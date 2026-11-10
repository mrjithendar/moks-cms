import { sql, type SQL } from "drizzle-orm";
import type { Db } from "@/db";

/**
 * Idempotent batched upsert: INSERT … ON CONFLICT (keys) DO UPDATE SET every non-key column. Table and column
 * names are fixed identifiers from this module's callers (never user input); values are bound parameters.
 * Running it twice with the same rows leaves the table unchanged (apart from synced_at).
 */
export async function upsertRows(db: Db, table: string, columns: string[], keys: string[], rows: unknown[][], batch = 500): Promise<number> {
  if (!/^[a-z_][a-z0-9_]*$/.test(table) || [...columns, ...keys].some((c) => !/^[a-z_][a-z0-9_]*$/.test(c))) throw new Error("invalid identifier");
  const updates = columns.filter((c) => !keys.includes(c));
  const set = sql.raw(updates.map((c) => `"${c}" = excluded."${c}"`).join(", "));
  const cols = sql.raw(columns.map((c) => `"${c}"`).join(", "));
  const conflict = sql.raw(keys.map((c) => `"${c}"`).join(", "));
  let written = 0;
  for (let i = 0; i < rows.length; i += batch) {
    const chunk = rows.slice(i, i + batch);
    const values: SQL = sql.join(
      chunk.map((r) => sql`(${sql.join(r.map((v) => sql`${v}`), sql`, `)})`),
      sql`, `,
    );
    await db.execute(sql`insert into ${sql.raw(`"${table}"`)} (${cols}) values ${values} on conflict (${conflict}) do update set ${set}`);
    written += chunk.length;
  }
  return written;
}

/** YYYY-MM-DD of `d` in `timeZone` (GSC reports in America/Los_Angeles; GA4 in the property's zone). */
export function dateIn(timeZone: string, d: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86_400_000);
}

export function addMonths(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
}

/** Split [start, end] (inclusive) into windows of at most `size` days. */
export function windows(start: string, end: string, size: number): { start: string; end: string }[] {
  const out: { start: string; end: string }[] = [];
  for (let s = start; s <= end; s = addDays(s, size)) {
    const e = addDays(s, size - 1);
    out.push({ start: s, end: e < end ? e : end });
  }
  return out;
}

export const isDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(new Date(`${v}T00:00:00Z`).getTime());
