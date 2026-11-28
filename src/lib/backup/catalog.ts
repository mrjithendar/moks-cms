import { sql, type SQL } from "drizzle-orm";
import { rowsOf } from "@/db/rows";

/**
 * Which tables a site backup holds and how a restore puts each one back (D-108).
 *
 * The tables come from the live PostgreSQL catalog of the site's schema, not from a list: a table a migration (or the
 * SEO agent, which creates a few of its own) adds is backed up from the day it exists. Format 1 named 12 tables and
 * silently left out everything added after it (accounts' sign-in methods, Python practice, the SEO and CrewAI data…).
 * Every table is restored as `replace` unless POLICIES says otherwise, and tests/backup-catalog.test.ts fails when a
 * migration adds a table that holds credentials without a policy here.
 */

type Exec = { execute: (query: SQL) => Promise<unknown> };

export type ColumnInfo = { name: string; type: string; nullable: boolean; generated: boolean; identity: "" | "a" | "d"; sequence: boolean };
export type ForeignKey = { name: string; columns: string[]; refTable: string; refColumns: string[]; onDelete: "a" | "r" | "c" | "n" | "d" };
export type TableInfo = { name: string; columns: ColumnInfo[]; primaryKey: string[]; foreignKeys: ForeignKey[] };

/**
 * - replace: the backup's rows replace the table's (all of them, in one transaction);
 * - merge: rows the site does not have are added, rows it has are left alone (accounts: never overwritten, and the
 *   sign-in secrets in `omit` never leave the server);
 * - append: like merge, for a log whose newer entries must survive a restore;
 * - exclude: never in a backup (credentials, or state that only means something on the running deployment).
 */
export type Policy = { mode: "replace" } | { mode: "merge"; omit?: string[] } | { mode: "append" } | { mode: "exclude"; reason: string };

export const POLICIES: Record<string, Policy> = {
  // Accounts are merged: a restore never changes or removes an account the site has now.
  user: { mode: "merge" },
  account: { mode: "merge", omit: ["password", "access_token", "refresh_token", "id_token"] },
  audit_log: { mode: "append" },
  // Credentials.
  session: { mode: "exclude", reason: "sign-in sessions (credentials): everyone signs in again after a restore" },
  verification: { mode: "exclude", reason: "email verification and password reset tokens (credentials)" },
  api_key: { mode: "exclude", reason: "API key hashes (credentials): issue new keys after a restore on a new deployment" },
  preview: { mode: "exclude", reason: "draft preview links (bearer tokens that expire)" },
  seo_mcp_codes: { mode: "exclude", reason: "MCP sign-in codes (credentials)" },
  seo_mcp_tokens: { mode: "exclude", reason: "MCP access and refresh tokens (credentials): MCP clients sign in again" },
  // State of the running deployment, rebuilt on its own.
  schema_migrations: { mode: "exclude", reason: "the migration ledger: the manifest records the schema version instead" },
  job: { mode: "exclude", reason: "the background job queue (would re-run old jobs)" },
  backup_run: { mode: "exclude", reason: "this deployment's own backup and restore history" },
  rate_limit: { mode: "exclude", reason: "rate-limit counters" },
  seo_job_locks: { mode: "exclude", reason: "the SEO agent's job locks" },
  practice_execution_job: { mode: "exclude", reason: "queued Python practice executions" },
  seo_llm_cache: { mode: "exclude", reason: "a cache of model answers, filled again on use" },
};

export function policyOf(table: string): Policy {
  return POLICIES[table] ?? { mode: "replace" };
}

/** Every table of the current schema (partitions through their parent), with columns, primary key and foreign keys. */
export async function readCatalog(db: Exec): Promise<TableInfo[]> {
  const tables = rowsOf<{ oid: number; name: string }>(
    await db.execute(sql`
      select c.oid::int as oid, c.relname::text as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = current_schema() and c.relkind in ('r', 'p') and not c.relispartition order by c.relname`),
  );
  const columns = rowsOf<{ oid: number; name: string; type: string; nullable: boolean; generated: boolean; identity: string; sequence: boolean }>(
    await db.execute(sql`
      select a.attrelid::int as oid, a.attname::text as name, format_type(a.atttypid, a.atttypmod) as type, not a.attnotnull as nullable,
             a.attgenerated::text <> '' as generated, a.attidentity::text as identity,
             pg_get_serial_sequence(quote_ident(n.nspname) || '.' || quote_ident(c.relname), a.attname) is not null as sequence
      from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = current_schema() and c.relkind in ('r', 'p') and a.attnum > 0 and not a.attisdropped
      order by a.attrelid, a.attnum`),
  );
  const keys = rowsOf<{ oid: number; cols: string }>(
    await db.execute(sql`
      select i.indrelid::int as oid, json_agg(a.attname::text order by k.ord)::text as cols
      from pg_index i join pg_class c on c.oid = i.indrelid join pg_namespace n on n.oid = c.relnamespace
      cross join lateral unnest(i.indkey) with ordinality as k(attnum, ord)
      join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
      where i.indisprimary and n.nspname = current_schema() group by i.indrelid`),
  );
  const fks = rowsOf<{ oid: number; name: string; ref: string; cols: string; refcols: string; ondelete: string }>(
    await db.execute(sql`
      select con.conrelid::int as oid, con.conname::text as name, rc.relname::text as ref, con.confdeltype::text as ondelete,
             (select json_agg(a.attname::text order by k.ord) from unnest(con.conkey) with ordinality k(attnum, ord) join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum)::text as cols,
             (select json_agg(a.attname::text order by k.ord) from unnest(con.confkey) with ordinality k(attnum, ord) join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.attnum)::text as refcols
      from pg_constraint con join pg_class c on c.oid = con.conrelid join pg_namespace n on n.oid = c.relnamespace
      join pg_class rc on rc.oid = con.confrelid
      where con.contype = 'f' and n.nspname = current_schema() order by con.conname`),
  );
  return tables.map((t) => ({
    name: t.name,
    columns: columns
      .filter((c) => c.oid === t.oid)
      .map((c) => ({ name: c.name, type: c.type, nullable: Boolean(c.nullable), generated: Boolean(c.generated), identity: (c.identity || "") as ColumnInfo["identity"], sequence: Boolean(c.sequence) })),
    primaryKey: JSON.parse(keys.find((k) => k.oid === t.oid)?.cols ?? "[]") as string[],
    foreignKeys: fks
      .filter((f) => f.oid === t.oid)
      .map((f) => ({ name: f.name, columns: JSON.parse(f.cols) as string[], refTable: f.ref, refColumns: JSON.parse(f.refcols) as string[], onDelete: f.ondelete as ForeignKey["onDelete"] })),
  }));
}

/**
 * Tables in an order where every table comes after the tables it references (parents first); a restore inserts in this
 * order and deletes in the reverse one. A table's references to itself are left out (handled row by row). Throws on a
 * cycle between different tables: no order would satisfy the foreign keys, and the restore must not guess.
 */
export function parentsFirst(tables: TableInfo[]): string[] {
  const names = new Set(tables.map((t) => t.name));
  const parents = new Map(tables.map((t) => [t.name, new Set(t.foreignKeys.map((f) => f.refTable).filter((r) => r !== t.name && names.has(r)))]));
  const order: string[] = [];
  const done = new Set<string>();
  while (order.length < tables.length) {
    const ready = [...parents].filter(([n, ps]) => !done.has(n) && [...ps].every((p) => done.has(p))).map(([n]) => n).sort();
    if (ready.length === 0) {
      const left = [...parents.keys()].filter((n) => !done.has(n));
      throw new Error(`The foreign keys between these tables form a cycle, so no restore order exists: ${left.slice(0, 10).join(", ")}`);
    }
    for (const n of ready) {
      done.add(n);
      order.push(n);
    }
  }
  return order;
}

/** A table's foreign keys to itself (comment replies, nested categories…): their columns are set after every row is in. */
export const selfReferences = (t: TableInfo) => t.foreignKeys.filter((f) => f.refTable === t.name);

/** The columns of `t` that point at an account: remapped when the account exists now under another id. */
export const userColumns = (t: TableInfo) => t.foreignKeys.filter((f) => f.refTable === "user" && f.columns.length === 1).map((f) => f.columns[0]!);

/** Column types the export writes as JSON (jsonb/json): the only places sealed credentials can live. */
export const hasJsonColumns = (t: TableInfo) => t.columns.some((c) => c.type === "jsonb" || c.type === "json");
