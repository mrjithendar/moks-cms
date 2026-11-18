import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { log } from "../lib/log";
import type { Db } from "./index";
import { rowsOf } from "./rows";

const LOCK_ID = 7_250_031; // arbitrary, constant advisory-lock key for this app's migrations

export function migrationsDir(): string {
  return process.env.MIGRATIONS_DIR ?? path.join(/*turbopackIgnore: true*/ process.cwd(), "src", "db", "migrations");
}

/** The .sql files in `dir`, in the order they are applied (by name). */
export function migrationFiles(dir: string = migrationsDir()): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

/**
 * Apply pending drizzle-kit SQL migrations in order, once, safe with several replicas starting together.
 *
 * Each file runs in its own transaction, which first takes a transaction-scoped advisory lock and then checks the
 * ledger again: a replica that waited for the lock finds the file applied and skips it. The lock belongs to the
 * transaction, so it is taken and released on one connection whatever the pool does. (A session lock taken with one
 * pooled query and released with another can land on two different connections and never be released.)
 *
 * Files are tracked by name, not by position, so a rolled-back migration can be applied again. A pending file that
 * sorts before one already applied is applied too, with a warning: on this database it ran after a later file, on a
 * fresh database it runs before it.
 */
export async function migrateDb(db: Db, dir: string = migrationsDir()): Promise<string[]> {
  const files = migrationFiles(dir);
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${LOCK_ID})`);
    await tx.execute(sql`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`);
  });
  const done = new Set(rowsOf<{ name: string }>(await db.execute(sql`select name from schema_migrations`)).map((r) => r.name));
  const newest = [...done].sort().at(-1);
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const statements = fs
      .readFileSync(path.join(dir, file), "utf8")
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);
    const ran = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${LOCK_ID})`);
      const seen = rowsOf(await tx.execute(sql`select 1 from schema_migrations where name = ${file}`));
      if (seen.length > 0) return false; // another replica applied it while this one waited for the lock
      for (const statement of statements) await tx.execute(sql.raw(statement));
      await tx.execute(sql`insert into schema_migrations (name) values (${file})`);
      return true;
    });
    if (!ran) continue;
    applied.push(file);
    if (newest && file < newest) log.warn("migration applied after a later one", { event: "migration_out_of_order", operation: "migrate", migration: file, newestApplied: newest });
  }
  return applied;
}
