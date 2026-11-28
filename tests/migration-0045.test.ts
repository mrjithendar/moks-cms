import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { schema, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
import { migrateDb, migrationsDir } from "@/db/migrate";

/**
 * Migration 0045 (D-110): the CMS's own LLM providers, models, keys and budgets are archived, then removed; stored
 * Claude model ids become LiteLLM aliases. Replayed over data in the shape a site had before it, then rolled back.
 */

const statements = (file: string) =>
  fs
    .readFileSync(path.resolve(migrationsDir(), file), "utf8")
    .split("--> statement-breakpoint")
    .map((x) => x.trim())
    .filter(Boolean);

const SEALED = { v: 1, iv: "aXY=", tag: "dGFn", data: "c2VjcmV0LWNpcGhlcnRleHQ=" };

describe("migration 0045", () => {
  let pg: PGlite;
  let db: Db;
  const run = async (file: string) => {
    for (const stmt of statements(file)) await db.execute(sql.raw(stmt));
  };
  const setting = async (key: string) => rowsOf<{ value: Record<string, unknown> }>(await db.execute(sql`select value from setting where key = ${key}`))[0]?.value;
  const archive = async () => rowsOf<{ source: string; item: Record<string, unknown> }>(await db.execute(sql`select source, item from llm_config_archive order by id`));

  beforeEach(async () => {
    pg = new PGlite();
    db = drizzle(pg, { schema }) as unknown as Db;
    await migrateDb(db);
    // What a site had before D-110: the agent's runtime tables, the batches ledger, and settings with the old fields.
    await db.execute(sql`create table seo_agent_llm_providers (id text primary key, kind text, name text, enabled boolean, key_sealed jsonb)`);
    await db.execute(sql`insert into seo_agent_llm_providers values ('anthropic', 'anthropic', 'Anthropic', true, ${JSON.stringify(SEALED)}::jsonb)`);
    await db.execute(sql`create table seo_agent_llm_models (provider_id text, model_id text, input_usd double precision)`);
    await db.execute(sql`insert into seo_agent_llm_models values ('anthropic', 'claude-sonnet-5-5', 2)`);
    await db.execute(sql`create table seo_agent_llm_budget (id int primary key, daily_usd double precision, monthly_usd double precision)`);
    await db.execute(sql`insert into seo_agent_llm_budget values (1, 2, 15)`);
    await db.execute(sql`create table seo_llm_batches (id text primary key, status text default 'in_progress' not null, model text not null, request_count integer default 0 not null, estimated_cost_usd double precision default 0 not null, created_at timestamptz default now() not null, ended_at timestamptz, processed_at timestamptz, error text)`);
    await db.execute(sql`insert into seo_llm_batches (id, status, model) values ('msgbatch_1', 'ended', 'claude-sonnet-5-5')`);
    const put = (key: string, value: unknown) => db.execute(sql`insert into setting (key, value) values (${key}, ${JSON.stringify(value)}::jsonb) on conflict (key) do update set value = excluded.value`);
    await put("seo", { llm: { enabled: true, provider: "openai", model: "gpt-x", baseUrl: "", region: "us-east-1", timeoutMs: 30_000, maxOutputTokens: 900, dailyRequestLimit: 100 }, drafts: { enabled: true, draftModel: "claude-opus-5-5", classifyModel: "", effort: "medium", maxOutputTokens: 16_000 }, aiVisibility: { enabled: true, costPerAnswerUsd: 0.03, models: { claude: "claude-opus-5-5" }, providers: { claude: true } }, llmKey: SEALED });
    await put("practice", { ai: { enabled: true, provider: "openai", model: "gpt-x", baseUrl: "", region: "us-east-1", apiKey: SEALED, timeoutMs: 30_000, maxOutputTokens: 900, inputUsdPerMTok: 1, outputUsdPerMTok: 2 }, quotas: { runsPerHour: 120, aiRequestsPerDay: 40, aiDailyBudgetUsd: 5 } });
    await put("ask_blog", { enabled: true, dailyBudgetUsd: 1, cacheTtlSeconds: 600 });
    await put("news", { writer_model: "claude-sonnet-5-5", fast_model: "claude-haiku-5-5", vision_model: "moks-cms-vision", llm_daily_usd: 2, llm_monthly_usd: 20, image_daily_usd: 1 });
    await db.execute(sql`insert into news_writing_profiles (key, version, name, model) values ('house', 1, 'House', 'claude-opus-5-5'), ('plain', 1, 'Plain', null)`);
    await db.execute(sql`insert into seo_crew_configs (crew, version, config) values ('editorial', 1, ${JSON.stringify({ agents: { writer: { model: "claude-opus-5-5", max_tokens: 4000 }, reviewer: { goal: "x" } } })}::jsonb)`);
  });
  afterEach(async () => {
    await pg.close();
  });

  it("archives the CMS's own LLM configuration (never a key), then removes it, and turns Claude ids into aliases", async () => {
    await run("0045_litellm_only.sql");
    const tables = rowsOf<{ t: string }>(await db.execute(sql`select table_name as t from information_schema.tables where table_name like 'seo_agent_llm%' or table_name = 'seo_llm_batches'`));
    expect(tables).toEqual([]);
    const seo = (await setting("seo"))!;
    expect(seo).not.toHaveProperty("llmKey");
    expect(seo.llm).toEqual({ enabled: true, timeoutMs: 30_000, maxOutputTokens: 900, dailyRequestLimit: 100 });
    expect(seo.drafts).toEqual({ enabled: true, maxOutputTokens: 16_000 });
    expect(seo.aiVisibility).toEqual({ enabled: true, providers: { claude: true } });
    const practice = (await setting("practice"))!;
    expect(practice.ai).toEqual({ enabled: true, timeoutMs: 30_000, maxOutputTokens: 900 });
    expect(practice.quotas).toEqual({ runsPerHour: 120, aiRequestsPerDay: 40 });
    expect(await setting("ask_blog")).toEqual({ enabled: true, cacheTtlSeconds: 600 });
    expect(await setting("news")).toEqual({ writer_model: "moks-cms-default", fast_model: "moks-cms-fast", vision_model: "moks-cms-vision", image_daily_usd: 1 });
    const profiles = rowsOf<{ key: string; model: string | null }>(await db.execute(sql`select key, model from news_writing_profiles order by key`));
    expect(profiles).toEqual([{ key: "house", model: "moks-cms-quality" }, { key: "plain", model: null }]);
    const [overlay] = rowsOf<{ config: { agents: Record<string, Record<string, unknown>> } }>(await db.execute(sql`select config from seo_crew_configs`));
    expect(overlay!.config.agents).toEqual({ writer: { model: "moks-cms-quality", max_tokens: 4000 }, reviewer: { goal: "x" } });

    const a = await archive();
    expect(a.map((x) => x.source).sort()).toEqual(["news_writing_profiles.model", "seo_agent_llm_budget", "seo_agent_llm_models", "seo_agent_llm_providers", "seo_crew_configs.config", "seo_llm_batches", "setting:ask_blog", "setting:news", "setting:practice", "setting:seo"]);
    expect(a.find((x) => x.source === "seo_agent_llm_providers")!.item).toEqual({ id: "anthropic", kind: "anthropic", name: "Anthropic", enabled: true });
    expect(a.find((x) => x.source === "setting:seo")!.item).toMatchObject({ llm: { provider: "openai", model: "gpt-x" }, drafts: { draftModel: "claude-opus-5-5", effort: "medium" }, aiVisibility: { costPerAnswerUsd: 0.03 }, llmKeySaved: true });
    expect(a.find((x) => x.source === "setting:practice")!.item).toMatchObject({ ai: { provider: "openai", inputUsdPerMTok: 1 }, aiKeySaved: true, aiDailyBudgetUsd: 5 });
    // No sealed key anywhere in the archive.
    expect(JSON.stringify(a)).not.toContain(SEALED.data);
    // The helper functions are gone again.
    expect(rowsOf(await db.execute(sql`select 1 from pg_proc where proname like 'd110_%'`))).toEqual([]);
    // Again: nothing left to change, nothing archived twice.
    const n = a.length;
    await run("0045_litellm_only.sql");
    expect((await archive()).length).toBe(n);
    expect(await setting("news")).toEqual({ writer_model: "moks-cms-default", fast_model: "moks-cms-fast", vision_model: "moks-cms-vision", image_daily_usd: 1 });
  });

  it("rolls back from the archive (keys excepted) and re-applies", async () => {
    await run("0045_litellm_only.sql");
    await run("../rollback/0045_litellm_only.down.sql");
    const seo = (await setting("seo"))!;
    expect(seo.llm).toMatchObject({ provider: "openai", model: "gpt-x" });
    expect(seo.drafts).toMatchObject({ draftModel: "claude-opus-5-5", effort: "medium" });
    expect(seo).not.toHaveProperty("llmKey");
    expect((await setting("practice"))!.quotas).toMatchObject({ aiDailyBudgetUsd: 5 });
    expect(await setting("ask_blog")).toMatchObject({ dailyBudgetUsd: 1 });
    expect(await setting("news")).toMatchObject({ writer_model: "claude-sonnet-5-5", fast_model: "claude-haiku-5-5", llm_daily_usd: 2 });
    expect(rowsOf<{ model: string }>(await db.execute(sql`select model from news_writing_profiles where key = 'house'`))[0]!.model).toBe("claude-opus-5-5");
    expect(rowsOf<{ id: string }>(await db.execute(sql`select id from seo_llm_batches`))).toEqual([{ id: "msgbatch_1" }]);
    expect(rowsOf(await db.execute(sql`select 1 from information_schema.tables where table_name = 'llm_config_archive'`))).toEqual([]);
    expect(await migrateDb(db)).toEqual(["0045_litellm_only.sql"]);
  });
});
