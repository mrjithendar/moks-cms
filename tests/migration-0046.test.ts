import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { schema, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
import { migrateDb, migrationsDir } from "@/db/migrate";

/** Migration 0046 (D-111): the stored LiteLLM alias names are renamed, then rolled back. */

const statements = (file: string) =>
  fs
    .readFileSync(path.resolve(migrationsDir(), file), "utf8")
    .split("--> statement-breakpoint")
    .map((x) => x.trim())
    .filter(Boolean);

describe("migration 0046", () => {
  let pg: PGlite;
  let db: Db;
  const run = async (file: string) => {
    for (const stmt of statements(file)) await db.execute(sql.raw(stmt));
  };
  const news = async () => rowsOf<{ value: Record<string, unknown> }>(await db.execute(sql`select value from setting where key = 'news'`))[0]!.value;
  const profiles = async () => rowsOf<{ key: string; model: string | null }>(await db.execute(sql`select key, model from news_writing_profiles where key like 't-%' order by key`));
  const overlay = async () => rowsOf<{ config: unknown }>(await db.execute(sql`select config from seo_crew_configs`))[0]!.config;

  beforeEach(async () => {
    pg = new PGlite();
    db = drizzle(pg, { schema }) as unknown as Db;
    await migrateDb(db);
    const value = { writer_model: "moks-cms-default", fast_model: "moks-cms-fast", vision_model: "moks-cms-vision", note: 'was "moks-cms-fast" before' };
    await db.execute(sql`insert into setting (key, value) values ('news', ${JSON.stringify(value)}::jsonb) on conflict (key) do update set value = excluded.value`);
    await db.execute(sql`insert into news_writing_profiles (key, version, name, model) values ('t-default', 1, 'A', 'moks-cms-default'), ('t-fast', 1, 'B', 'moks-cms-fast'), ('t-none', 1, 'C', null), ('t-quality', 1, 'D', 'moks-cms-quality')`);
    await db.execute(sql`insert into seo_crew_configs (crew, version, config) values ('editorial', 1, ${JSON.stringify({ agents: { writer: { model: "moks-cms-default" }, researcher: { model: "moks-cms-fast" }, reviewer: { model: "moks-cms-quality" } } })}::jsonb)`);
  });
  afterEach(async () => {
    await pg.close();
  });

  it("renames whole values only, then rolls back and re-applies", async () => {
    await run("0046_litellm_alias_names.sql");
    expect(await news()).toEqual({ writer_model: "cms-claude-sonnet-latest", fast_model: "ops-claude-haiku-latest", vision_model: "moks-cms-vision", note: 'was "moks-cms-fast" before' });
    expect(await profiles()).toEqual([
      { key: "t-default", model: "cms-claude-sonnet-latest" },
      { key: "t-fast", model: "ops-claude-haiku-latest" },
      { key: "t-none", model: null },
      { key: "t-quality", model: "moks-cms-quality" },
    ]);
    expect(await overlay()).toEqual({ agents: { writer: { model: "cms-claude-sonnet-latest" }, researcher: { model: "ops-claude-haiku-latest" }, reviewer: { model: "moks-cms-quality" } } });
    expect(rowsOf(await db.execute(sql`select 1 from pg_proc where proname like 'd111_%'`))).toEqual([]);

    await run("../rollback/0046_litellm_alias_names.down.sql");
    expect(await news()).toMatchObject({ writer_model: "moks-cms-default", fast_model: "moks-cms-fast" });
    expect((await profiles())[0]).toEqual({ key: "t-default", model: "moks-cms-default" });
    expect(await migrateDb(db)).toEqual(["0046_litellm_alias_names.sql"]);
    expect(await news()).toMatchObject({ writer_model: "cms-claude-sonnet-latest" });
  });
});
