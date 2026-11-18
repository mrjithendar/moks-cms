import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { migrateDb, migrationFiles } from "@/db/migrate";
import { freshDb } from "./db-helpers";

describe("database migrations", () => {
  it("apply once and are idempotent", async () => {
    const db = await freshDb();
    expect(await migrateDb(db)).toEqual([]);
    const result = (await db.execute(sql`select count(*)::int as n from schema_migrations`)) as unknown as { rows: { n: number }[] };
    expect(result.rows[0]!.n).toBeGreaterThan(0);
  });

  // Two pull requests that each add "the next" migration end up with the same number. The files would still be
  // applied (they are tracked by name), but in an order nobody chose. Renumber the newer one before merging.
  it("gives every migration its own number", () => {
    const byNumber = new Map<string, string[]>();
    for (const file of migrationFiles()) {
      const number = /^(\d{4})_[a-z0-9_]+\.sql$/.exec(file)?.[1];
      expect(number, `${file} must be named NNNN_name.sql`).toBeDefined();
      byNumber.set(number!, [...(byNumber.get(number!) ?? []), file]);
    }
    const shared = [...byNumber].filter(([, files]) => files.length > 1).map(([number]) => number);
    // 0027 was handed out twice before this check existed. Both files are applied in production under these names,
    // so renaming either would run it again: they stay, and no other number may repeat.
    expect(shared).toEqual(["0027"]);
  });

  it("applies each file in its own transaction, and a file numbered before an applied one is still applied", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "migrations-"));
    const tables = async (db: Awaited<ReturnType<typeof freshDb>>) =>
      ((await db.execute(sql`select table_name from information_schema.tables where table_name in ('t_ok', 't_half', 't_late') order by 1`)) as unknown as { rows: { table_name: string }[] }).rows.map((r) => r.table_name);
    const ledger = async (db: Awaited<ReturnType<typeof freshDb>>) =>
      ((await db.execute(sql`select name from schema_migrations where name like '9%' order by 1`)) as unknown as { rows: { name: string }[] }).rows.map((r) => r.name);
    try {
      fs.writeFileSync(path.join(dir, "9001_ok.sql"), 'create table "t_ok" (id int)');
      fs.writeFileSync(path.join(dir, "9002_broken.sql"), 'create table "t_half" (id int)\n--> statement-breakpoint\nselect * from "t_no_such_table"');
      const db = await freshDb();
      await expect(migrateDb(db, dir)).rejects.toThrow();
      // The first file is applied and recorded; nothing of the failed one is left behind.
      expect(await tables(db)).toEqual(["t_ok"]);
      expect(await ledger(db)).toEqual(["9001_ok.sql"]);

      fs.writeFileSync(path.join(dir, "9002_broken.sql"), 'create table "t_half" (id int)');
      expect(await migrateDb(db, dir)).toEqual(["9002_broken.sql"]);
      fs.writeFileSync(path.join(dir, "9000_late.sql"), 'create table "t_late" (id int)');
      expect(await migrateDb(db, dir)).toEqual(["9000_late.sql"]);
      expect(await migrateDb(db, dir)).toEqual([]);
      expect(await tables(db)).toEqual(["t_half", "t_late", "t_ok"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates every application table", async () => {
    const db = await freshDb();
    const result = (await db.execute(
      sql`select table_name from information_schema.tables where table_schema = 'public' order by 1`,
    )) as unknown as { rows: { table_name: string }[] };
    const tables = result.rows.map((r) => r.table_name);
    for (const t of ["user", "session", "account", "verification", "rate_limit", "author_profile", "post", "page", "setting", "comment", "contact_message", "media", "api_key", "audit_log"]) {
      expect(tables).toContain(t);
    }
  });
});
