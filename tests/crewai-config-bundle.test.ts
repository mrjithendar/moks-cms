import { readFileSync } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schema, setDbForTests, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
import type { Manifest } from "@/lib/crewai/bundle/files";
import type { AgentConfigCatalogue } from "@/lib/seo-agent/client";
import type { SessionUser } from "@/lib/session";
import { freshDb } from "./db-helpers";

/**
 * The CrewAI configuration bundle (D-101): a complete export discovered from what runs (never a list in the test), the
 * files and back, import plans with conflicts, one-transaction apply with verification, idempotency, failures that change
 * nothing, rollback, drift, the format 1 file, and secrets. The SEO agent is faked with its real GET /config-catalogue
 * (tests/fixtures/seo-agent/config-catalogue.json, captured from moks-seo-agent's code) and its checks.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "user-agent": "vitest" }), cookies: async () => ({ getAll: () => [], get: () => undefined }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
let currentUser: SessionUser | null = null;
vi.mock("@/lib/session", () => ({ getSessionUser: async () => currentUser, requireRole: async () => currentUser, requireUser: async () => currentUser }));

const files = await import("@/lib/crewai/bundle/files");
const model = await import("@/lib/crewai/bundle/model");
const runtime = await import("@/lib/crewai/bundle/runtime");
const io = await import("@/lib/crewai/bundle/import");
const sync = await import("@/lib/crewai/bundle/sync");
const schedules = await import("@/lib/crewai/schedules");
const crews = await import("@/lib/crewai/crews");
const catalog = await import("@/lib/crewai/catalog");
const skills = await import("@/lib/seo-agent/skills");
const { clearAgentCache } = await import("@/lib/seo-agent/endpoint");

const CATALOGUE = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "fixtures/seo-agent/config-catalogue.json"), "utf8")) as AgentConfigCatalogue;
const ADMIN: SessionUser = { id: "admin", name: "Admin", email: "admin@example.com", role: "admin", emailVerified: true, image: null, sessionCreatedAt: new Date() };
const ACTOR = { id: "admin", role: "admin" as const, label: "admin@example.com" };
const env = { ...process.env };
const META = { source: "jithendar.com", exportedAt: "2026-11-24T10:00:00.000Z", cmsVersion: "test", agentVersion: "fixture", unsupported: [] };

let db: Db;
let agentUp: boolean;
let calls: string[];
let refuse: (path: string, body: Record<string, unknown>) => string | null;

const stable = (v: unknown) => model.stable(v);

/** The agent's overlay normalisation (seo-agent/app/crews/config.py normalize), for the fake. */
function overlay(crew: string, cfg: Record<string, Record<string, Record<string, unknown>>>) {
  const def = CATALOGUE.crews.find((c) => c.crew === crew)!;
  const out: Record<string, Record<string, Record<string, unknown>>> = { agents: {}, tasks: {} };
  for (const [k, a] of Object.entries(cfg.agents ?? {})) {
    const d = def.agents.find((x) => x.key === k)!;
    const diff: Record<string, unknown> = {};
    for (const f of ["role", "goal", "backstory"] as const) if (a[f] != null && String(a[f]).trim() !== d[f].trim()) diff[f] = String(a[f]).trim();
    if (a.model) diff.model = a.model;
    if (a.max_tokens != null && a.max_tokens !== d.max_tokens) diff.max_tokens = a.max_tokens;
    if (a.max_iter != null) diff.max_iter = a.max_iter;
    if (a.tools && stable(a.tools) !== stable(d.tools)) diff.tools = a.tools;
    if (Object.keys(diff).length) out.agents![k] = diff;
  }
  for (const [k, t] of Object.entries(cfg.tasks ?? {})) {
    const d = def.tasks.find((x) => x.key === k)!;
    const diff: Record<string, unknown> = {};
    if (t.instructions != null && String(t.instructions).trim() !== d.instructions.trim()) diff.instructions = String(t.instructions).trim();
    if (t.expected_output != null && String(t.expected_output).trim() !== d.expected_output.trim()) diff.expected_output = String(t.expected_output).trim();
    if (Object.keys(diff).length) out.tasks![k] = diff;
  }
  return Object.fromEntries(Object.entries(out).filter(([, v]) => Object.keys(v).length));
}

/** The agent's spec check (POST /custom/validate): defaults filled in, inputs as objects. */
function checkedSpec(kind: string, spec: Record<string, unknown>) {
  if (kind === "flow") return { inputs: [], ...spec };
  return {
    description: "",
    output: null,
    model: null,
    ...spec,
    inputs: ((spec.inputs as unknown[]) ?? []).map((i) => (typeof i === "string" ? { name: i, label: "", description: "", required: false, default: "" } : i)),
    agents: ((spec.agents as Record<string, unknown>[]) ?? []).map((a) => ({ tools: [], model: null, max_tokens: null, max_iter: null, ...a })),
    tasks: ((spec.tasks as Record<string, unknown>[]) ?? []).map((t) => ({ context: [], ...t })),
  };
}

function reply(p: string, body: Record<string, unknown>): { status: number; json: unknown } {
  const no = refuse(p, body);
  if (no) return { status: 422, json: { error: "invalid", issues: [no] } };
  if (p === "/healthz") return { status: 200, json: { status: "ok", version: "fixture" } };
  if (p === "/config-catalogue") return { status: 200, json: CATALOGUE };
  if (p === "/crews") return { status: 200, json: { items: CATALOGUE.crews } };
  if (p === "/flows") return { status: 200, json: { items: CATALOGUE.flows } };
  if (p === "/llm-providers") return { status: 200, json: { kinds: [{ id: "anthropic", env_key: "ANTHROPIC_API_KEY" }], providers: [{ id: "anthropic", kind: "anthropic", kind_label: "Anthropic", name: "Anthropic", enabled: true, base_url: "https://api.anthropic.com", region: "", deployment: "", api_version: "", key: "env", saved: false, issues: [], models: [{ provider_id: "anthropic", model_id: "claude-sonnet-5-5", label: "Sonnet", enabled: true, free: false, price_state: "built-in", prices: {}, builtin_prices: null, context_window: 200000, max_output: 64000, capabilities: {} }] }], can_store_keys: true, key_env: "SEO_AGENT_SECRETS_KEY" } };
  const crew = /^\/crews\/([a-z_]+)\/validate$/.exec(p);
  if (crew) {
    const def = CATALOGUE.crews.find((c) => c.crew === crew[1]);
    if (!def) return { status: 404, json: { error: "unknown crew" } };
    return { status: 200, json: { config: overlay(crew[1]!, (body.config ?? {}) as never), default_hash: def.default_hash, prompt_version: def.prompt_version } };
  }
  if (p === "/custom/validate") return { status: 200, json: { spec: checkedSpec(String(body.kind), body.spec as Record<string, unknown>) } };
  if (/^\/flows\/[a-z_0-9]+\/validate$/.test(p)) return { status: 200, json: { inputs: body.inputs ?? {} } };
  return { status: 404, json: { error: "not found" } };
}

beforeEach(async () => {
  db = await freshDb();
  await db.insert(schema.user).values([{ id: "admin", name: "Admin", email: "admin@example.com", role: "admin" }]);
  await db.execute(sql`insert into news_writing_profiles (key, version, name, status) values ('news-default', 1, 'Default', 'active')`);
  await db.execute(sql`insert into news_image_profiles (key, version, name, status) values ('cover-template', 1, 'Cover', 'active')`);
  currentUser = ADMIN;
  agentUp = true;
  calls = [];
  refuse = () => null;
  Object.assign(process.env, { SEO_ORCHESTRATOR: "crewai", SEO_AGENT_TOKEN: "a".repeat(40), SEO_AGENT_URL: "http://seo-agent.test:8080", SEO_AGENT_CALLBACK_TOKEN: "c".repeat(40) });
  clearAgentCache();
  sync.forgetStatus();
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const p = new URL(url).pathname;
    calls.push(`${init?.method ?? "GET"} ${p}`);
    if (!agentUp) throw new TypeError("fetch failed");
    const r = reply(p, init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {});
    return new Response(JSON.stringify(r.json), { status: r.status, headers: { "content-type": "application/json" } });
  });
});
afterEach(() => {
  setDbForTests(undefined);
  currentUser = null;
  process.env = { ...env };
  vi.unstubAllGlobals();
});

const exportFiles = async () => {
  const rt = await runtime.exportRuntime();
  return { rt, files: files.toFiles(rt.config, { ...META, unsupported: rt.report.unsupported }) };
};
const importFiles = (f: Record<string, string>, opts: Parameters<typeof io.importBundle>[1] = {}, source: "admin" | "deploy" = "deploy") => io.importBundle({ files: f }, opts, ACTOR, { source, revision: "a".repeat(40) });
const edit = (f: Record<string, string>, p: string, from: string | RegExp, to: string) => {
  const next = f[p]!.replace(from, to);
  expect(next).not.toBe(f[p]);
  return { ...f, [p]: next };
};

describe("export", () => {
  it("discovers every registered crew, agent, task, flow, tool and skill, and every schedule (no list in the test)", async () => {
    const { rt } = await exportFiles();
    const c = rt.config;
    // Every crew the agent defines, with every agent and task as the code has them.
    expect(c.crews.map((x) => x.key).sort()).toEqual(CATALOGUE.crews.map((x) => x.crew).sort());
    expect(c.agents.map((a) => `${a.crew}.${a.key}`).sort()).toEqual(CATALOGUE.crews.flatMap((x) => x.agents.map((a) => `${x.crew}.${a.key}`)).sort());
    expect(c.tasks.map((t) => `${t.crew}.${t.key}`).sort()).toEqual(CATALOGUE.crews.flatMap((x) => x.tasks.map((t) => `${x.crew}.${t.key}`)).sort());
    // Every flow but the three runners, which are named in the report with the reason.
    const runners = catalog.RUNNER_FLOWS;
    expect(c.flows.map((f) => f.key).sort()).toEqual(CATALOGUE.flows.map((f) => f.name).filter((n) => !runners.includes(n)).sort());
    expect(rt.report.skipped.filter((s) => s.kind === "flows").map((s) => s.id).sort()).toEqual([...runners].sort());
    expect(c.tools.map((t) => t.name).sort()).toEqual(CATALOGUE.tools.map((t) => t.name).sort());
    expect(c.guardrails).toHaveLength(CATALOGUE.guardrails.length);
    expect(c.skills.map((s) => s.name).sort()).toEqual(skills.DEFAULT_SKILLS.map((s) => s.name).sort());
    expect(c.schedules).toHaveLength((await schedules.listSchedules()).length);
    expect(c.categories.length).toBeGreaterThan(0);
    expect(c.providers[0]).toMatchObject({ id: "anthropic", key: "env", key_ref: "environment variable ANTHROPIC_API_KEY" });
    expect(rt.report.complete).toBe(true);
    // A code crew's task carries its read-only contract; its agents the code's limits.
    const write = c.tasks.find((t) => t.crew === "editorial" && t.key === "write")!;
    expect(write.contract).toBeTruthy();
    expect(c.crews.find((x) => x.key === "editorial")!.code!.allowed_tools).toContain("fetch_allowlisted_docs");
  });

  it("writes the layout, a manifest with inventory and checksums, schemas and a README; files read back to the same configuration", async () => {
    const { rt, files: f } = await exportFiles();
    expect(f["crews/editorial.yaml"]).toMatch(/^# Crew .*defined in code/);
    expect(f["agents/editorial/writer.md"]).toMatch(/^---\ncrew: editorial\nkey: writer\nrole: /);
    expect(f["skills/technical-research/SKILL.md"]).toMatch(/^---\nname: technical-research\ndescription: /);
    expect(Object.keys(f).filter((p) => p.startsWith("schemas/")).length).toBeGreaterThanOrEqual(10);
    const manifest = JSON.parse(f["manifest.json"]!) as Manifest;
    expect(manifest).toMatchObject({ kind: "moks-crewai-bundle", format: 2, source: "jithendar.com" });
    expect(manifest.inventory!.crews).toEqual(rt.config.crews.map((c) => c.key));
    expect(manifest.counts!.agents).toBe(rt.config.agents.length);
    expect((manifest.dependencies as { flows: Record<string, { crews: string[] }> }).flows.new_article_flow!.crews).toEqual(["editorial"]);
    expect(manifest.files!.every((x) => x.sha256 === files.sha256(f[x.path]!))).toBe(true);
    expect(manifest.unsupported!.map((u) => u.component).join(" ")).toMatch(/content profiles/);
    const back = files.fromFiles(f);
    expect(back.issues).toEqual([]);
    expect(files.verifyManifest(f, back)).toEqual([]);
    expect(files.configChecksum(back.config)).toBe(files.configChecksum(rt.config));
    for (const k of model.KINDS) {
      const ids = (c: typeof rt.config) => new Map((c[k.kind] as unknown[]).map((x) => [model.idOf(k.kind, x), x]));
      expect(ids(back.config), k.kind).toEqual(ids(rt.config));
    }
  });

  it("says what it could not export when the agent is down, and redacts anything that looks like a credential", async () => {
    const [first] = await skills.listSkills();
    await skills.updateSkill(ACTOR, first!.id, { instructions: `${first!.instructions}\nUse the key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123 for tests.` });
    agentUp = false;
    clearAgentCache();
    const rt = await runtime.exportRuntime();
    expect(rt.report.complete).toBe(false);
    expect(rt.report.unsupported.map((u) => u.component).join(" ")).toMatch(/crews defined in code/);
    expect(rt.config.crews).toEqual([]);
    expect(rt.report.redacted).toEqual([expect.objectContaining({ item: `skills:${first!.name}`, pattern: "Anthropic or OpenAI key" })]);
    expect(JSON.stringify(rt.config)).not.toMatch(/sk-ant-/);
    expect(JSON.stringify(rt.config)).toMatch(/\[redacted\]/);
  });
});

describe("import", () => {
  it("is a no-op for the site's own export, applies edits in one go, verifies them, and is idempotent", async () => {
    const { files: f0 } = await exportFiles();
    const same = await importFiles(f0, { dryRun: true });
    expect(same.plan.ok).toBe(true);
    expect(same.plan.items.every((i) => i.action === "unchanged")).toBe(true);
    const first = await importFiles(f0);
    expect(first.result).toMatchObject({ status: "unchanged", verified: true });

    // Edits: an agent's backstory, a schedule's time, a new category, spec crew, spec flow and schedule, a skill.
    let f = edit(f0, "agents/report/analyst.md", /\n\n[\s\S]*$/, "\n\nYou explain SEO numbers to the owner in plain words.\n");
    f = edit(f, "schedules/schedules.yaml", "cron: 10 6 * * *", "cron: 30 5 * * *");
    f = edit(f, "categories/categories.yaml", /\ncategories:\n/, "\ncategories:\n  - slug: newsletters\n    label: Newsletters\n    description: ''\n    position: 95\n");
    f = { ...f, "crews/digest.yaml": "key: digest\nlabel: Digest crew\ndefinition: spec\ncategories: [newsletters]\nagents: [editor]\ntasks: [summarise]\ninputs: [topic]\n" };
    f = { ...f, "agents/digest/editor.md": "---\nrole: Digest editor\ngoal: Summarise the week\ntools: [vector_search]\n---\n\nYou write short digests.\n" };
    f = { ...f, "tasks/digest/summarise.md": "---\nagent: editor\nlabel: Summarise\nexpected_output: A digest\n---\n\nSummarise this week's articles about {topic}.\n" };
    f = { ...f, "flows/weekly_digest.yaml": "key: weekly_digest\nlabel: Weekly digest\ndefinition: spec\nflow_name: custom_flow\ncategories: [newsletters]\nspec:\n  inputs: [topic]\n  steps:\n    - kind: crew\n      crew: digest\n      inputs: {topic: '{topic}'}\n      save_as: digest\n" };
    f = edit(f, "schedules/schedules.yaml", /\nschedules:\n/, "\nschedules:\n  - name: digest-weekly\n    flow: custom_flow\n    cron: 0 9 * * 5\n    inputs: {flow: weekly_digest, inputs: {topic: kubernetes}}\n");
    f = edit(f, "skills/technical-research/SKILL.md", /\n\n[\s\S]*$/, "\n\nTrust the project's own documentation first.\n");

    const planned = await importFiles(f, { dryRun: true });
    expect(planned.plan.ok).toBe(true);
    const by = new Map(planned.plan.items.map((i) => [i.ref, i]));
    expect(by.get("agents:report.analyst")).toMatchObject({ action: "update", changes: ["backstory"] });
    expect(by.get("schedules:gsc-sync")).toMatchObject({ action: "update", changes: ["cron: 10 6 * * * → 30 5 * * *"] });
    for (const r of ["categories:newsletters", "crews:digest", "agents:digest.editor", "tasks:digest.summarise", "flows:weekly_digest", "schedules:digest-weekly"]) expect(by.get(r)?.action, r).toBe("create");
    expect(by.get("skills:technical-research")).toMatchObject({ action: "update", changes: ["instructions"] });
    expect((await schedules.scheduleByName("gsc-sync"))!.cron).toBe("10 6 * * *"); // a plan changes nothing

    const done = await importFiles(f);
    expect(done.result).toMatchObject({ status: "applied", verified: true });
    expect((await schedules.scheduleByName("gsc-sync"))!.cron).toBe("30 5 * * *");
    expect((await crews.activeVersions()).find((v) => v.crew === "report")).toMatchObject({ source: "import", config: { agents: { analyst: { backstory: "You explain SEO numbers to the owner in plain words." } } } });
    expect(await catalog.getItem("crew", "digest")).toMatchObject({ definition: "spec", enabled: true, categories: ["newsletters"] });
    expect(await catalog.getItem("flow", "weekly_digest")).toMatchObject({ definition: "spec", enabled: true, crews: ["digest"] });
    expect((await schedules.scheduleByName("digest-weekly"))!.inputs).toEqual({ flow: "weekly_digest", inputs: { topic: "kubernetes" } });

    // Idempotent: the same bundle again changes nothing, and neither does a re-export of the site.
    const again = await importFiles(f, { dryRun: true });
    expect(again.plan.items.filter((i) => i.action !== "unchanged")).toEqual([]);
    const versions = (await crews.listVersions("report")).length;
    await importFiles(f);
    expect((await crews.listVersions("report")).length).toBe(versions);
    const { files: f2 } = await exportFiles();
    expect((await importFiles(f2, { dryRun: true })).plan.items.filter((i) => i.action !== "unchanged")).toEqual([]);
    // The sync is recorded with the revision, and the site is in step with it.
    const status = await sync.syncStatus({ fresh: true });
    expect(status.lastImport).toMatchObject({ status: "unchanged", revision: "a".repeat(40), source: "deploy" });
    expect((await sync.listSyncs()).filter((s) => s.status === "applied")).toHaveLength(1);
    expect(status.drift).toMatchObject({ state: "in_sync" });
  });

  it("keeps a change made here since the last sync unless the policy overwrites it, and drift shows it", async () => {
    const { files: f0 } = await exportFiles();
    await importFiles(f0);
    const gsc = (await schedules.scheduleByName("gsc-sync"))!;
    await schedules.updateSchedule(gsc.id, { cron: "45 6 * * *" }, "admin"); // an admin's change on the Schedules page
    const status = await sync.syncStatus({ fresh: true });
    expect(status.drift).toMatchObject({ state: "drifted", changed: ["schedules:gsc-sync"] });

    const f = edit(f0, "schedules/schedules.yaml", "cron: 10 6 * * *", "cron: 0 7 * * *");
    const skip = await importFiles(f);
    expect(skip.plan.items.find((i) => i.ref === "schedules:gsc-sync")).toMatchObject({ action: "conflict", apply: false });
    expect((await schedules.scheduleByName("gsc-sync"))!.cron).toBe("45 6 * * *");
    await expect(importFiles(f, { policy: "fail" })).rejects.toThrow(/conflict/);
    const over = await importFiles(f, { policy: "overwrite" });
    expect(over.result!.status).toBe("applied");
    expect((await schedules.scheduleByName("gsc-sync"))!.cron).toBe("0 7 * * *");
  });

  it("refuses the whole import when one item is refused, records the failure, and changes nothing", async () => {
    const { files: f0 } = await exportFiles();
    await importFiles(f0); // a baseline: the schedule change below is then an update, not a conflict
    let f = edit(f0, "schedules/schedules.yaml", "cron: 10 6 * * *", "cron: 30 5 * * *");
    f = { ...f, "crews/broken.yaml": "key: broken\nlabel: Broken crew\ndefinition: spec\nagents: [aa]\ntasks: [tt]\n", "agents/broken/aa.md": "---\nrole: R\ngoal: G\ntools: [shell]\n---\n\nB\n", "tasks/broken/tt.md": "---\nagent: aa\nlabel: T\nexpected_output: X\n---\n\nDo it.\n" };
    refuse = (p, body) => (p === "/custom/validate" && (body.spec as { key?: string }).key === "broken" ? "agents.0.tools: tool(s) a custom crew may not use: shell" : null);
    const plan = (await importFiles(f, { dryRun: true })).plan;
    expect(plan.ok).toBe(false);
    expect(plan.items.find((i) => i.ref === "crews:broken")).toMatchObject({ action: "error" });
    expect(plan.items.find((i) => i.ref === "agents:broken.aa")?.action).toBe("error"); // tools outside CUSTOM_TOOLS, found before the agent
    const err = await importFiles(f).catch((e: unknown) => e as InstanceType<typeof io.ImportError>);
    expect(err).toBeInstanceOf(io.ImportError);
    expect((await schedules.scheduleByName("gsc-sync"))!.cron).toBe("10 6 * * *");
    expect(await catalog.getItem("crew", "broken")).toBeNull();
    expect((await sync.listSyncs()).find((s) => s.status === "refused")).toMatchObject({ source: "deploy", error: expect.stringMatching(/refused/) });
    // A partial import applies the rest and leaves the refused crew out.
    const partial = await importFiles(f, { allowPartial: true });
    expect(partial.result!.status).toBe("applied");
    expect((await schedules.scheduleByName("gsc-sync"))!.cron).toBe("30 5 * * *");
    expect(await catalog.getItem("crew", "broken")).toBeNull();
  });

  it("refuses broken files, unknown references and a structure change of a code crew", async () => {
    const { files: f0 } = await exportFiles();
    const bad = { ...f0, "flows/odd.yaml": "key: odd\nlabel: Odd flow\ndefinition: spec\nflow_name: custom_flow\nspec:\n  steps: [{kind: crew, crew: nobody}]\n", "crews/editorial.yaml": f0["crews/editorial.yaml"]!.replace("  - seo_editor\n", ""), "skills/x/SKILL.md": "no front matter" };
    const plan = (await importFiles(bad, { dryRun: true })).plan;
    expect(plan.ok).toBe(false);
    const msgs = plan.issues.map((i) => `${i.path}: ${i.message}`).join("\n");
    expect(msgs).toMatch(/skills\/x\/SKILL.md: Cannot read it/);
    expect(msgs).toMatch(/step crew nobody is neither in the bundle nor on this site/);
    expect(msgs).toMatch(/crews\/editorial.yaml: defined in code: its agents are/);
    expect(msgs).toMatch(/agents\/editorial\/seo_editor.md: the crew editorial does not list this agent/);
    // Unsafe paths and a newer format are refused outright.
    expect(files.fromFiles({ "../etc/passwd": "x" }).issues[0]!.message).toMatch(/safe relative path/);
    const newer = { ...f0, "manifest.json": f0["manifest.json"]!.replace('"format": 2', '"format": 3') };
    expect((await importFiles(newer, { dryRun: true })).plan.issues.map((i) => i.message).join(" ")).toMatch(/newer than this CMS reads/);
    // YAML is data only: tags and aliases do not run anything, and duplicate keys are refused.
    expect(files.fromFiles({ "crews/xx.yaml": "key: xx\nkey: yy\n" }).issues[0]!.message).toMatch(/Cannot read it/);
    expect(files.fromFiles({ "crews/xx.yaml": "!!js/function 'function(){}'" }).issues[0]!.severity).toBe("error");
    expect(files.fromFiles({ "crews/xx.yaml": "a: &x [*x, *x]\n" }).issues[0]!.severity).toBe("error");
  });

  it("imports one crew, or only some kinds, and removes only when asked (never code crews or shipped skills)", async () => {
    const { files: f0 } = await exportFiles();
    let f = edit(f0, "agents/report/analyst.md", /\n\n[\s\S]*$/, "\n\nTerse.\n");
    f = edit(f, "schedules/schedules.yaml", "cron: 10 6 * * *", "cron: 30 5 * * *");
    const one = await importFiles(f, { only: ["crews:report"], policy: "overwrite" });
    expect(one.result!.status).toBe("applied");
    expect((await schedules.scheduleByName("gsc-sync"))!.cron).toBe("10 6 * * *");
    const kinds = await importFiles(f, { kinds: ["schedules"], policy: "overwrite" });
    expect(kinds.result!.applied).toEqual({ schedules: 1 });

    // Remove: a crew and flow made here, missing from the bundle, go only with prune.
    await importFiles({ ...f0, "crews/digest.yaml": "key: digest\nlabel: Digest crew\ndefinition: spec\nagents: [editor]\ntasks: [summarise]\n", "agents/digest/editor.md": "---\nrole: R\ngoal: G\n---\n\nB\n", "tasks/digest/summarise.md": "---\nagent: editor\nlabel: S\nexpected_output: X\n---\n\nDo it.\n" }, { policy: "overwrite" });
    const without = { ...f0 };
    delete without["skills/technical-research/SKILL.md"];
    const kept = (await importFiles(without, { dryRun: true, policy: "overwrite" })).plan;
    expect(kept.items.find((i) => i.ref === "crews:digest")).toMatchObject({ action: "keep" });
    const pruned = (await importFiles(without, { dryRun: true, policy: "overwrite", prune: true })).plan;
    expect(pruned.items.find((i) => i.ref === "crews:digest")).toMatchObject({ action: "remove" });
    expect(pruned.items.find((i) => i.ref === "skills:technical-research")).toMatchObject({ action: "keep", changes: [expect.stringMatching(/shipped with the CMS/)] });
    await importFiles(without, { policy: "overwrite", prune: true });
    expect((await catalog.getItem("crew", "digest"))!.deletedAt).not.toBeNull();
    expect((await catalog.getItem("crew", "editorial"))!.deletedAt).toBeNull();
  });

  it("rolls an import back to what was there before", async () => {
    const { files: f0 } = await exportFiles();
    const f = { ...edit(f0, "schedules/schedules.yaml", "cron: 10 6 * * *", "cron: 30 5 * * *"), "crews/digest.yaml": "key: digest\nlabel: Digest crew\ndefinition: spec\nagents: [editor]\ntasks: [summarise]\n", "agents/digest/editor.md": "---\nrole: R\ngoal: G\n---\n\nB\n", "tasks/digest/summarise.md": "---\nagent: editor\nlabel: S\nexpected_output: X\n---\n\nDo it.\n" };
    const done = await importFiles(f, { policy: "overwrite" });
    const back = await io.rollbackImport(done.result!.recordId, ACTOR);
    expect(back.result!.status).toBe("applied");
    expect((await schedules.scheduleByName("gsc-sync"))!.cron).toBe("10 6 * * *");
    expect((await catalog.getItem("crew", "digest"))!.deletedAt).not.toBeNull();
    expect((await sync.listSyncs())[0]).toMatchObject({ source: "rollback", status: "applied" });
  });

  it("brings a content flow and its sources to another site under the same key", async () => {
    const { createJob, saveSource } = await import("@/lib/news/service");
    const src = await saveSource(ACTOR, null, { name: "Kubernetes blog", type: "rss", url: "https://kubernetes.io/feed.xml" });
    await createJob(ACTOR, { name: "Kubernetes news", enabled: false, cron: "0 7 * * *", timezone: "Etc/UTC", config: { source_ids: [src.id], topics: [], max_articles_per_run: 2 } });
    const { rt, files: f } = await exportFiles();
    const flow = rt.config.flows.find((x) => x.definition === "content")!;
    expect(flow.content).toMatchObject({ sources: ["https://kubernetes.io/feed.xml"], config: expect.objectContaining({ max_articles_per_run: 2 }) });
    expect(JSON.stringify(flow)).not.toMatch(src.id);

    // Another site: a fresh database with the same agent.
    db = await freshDb();
    await db.insert(schema.user).values([{ id: "admin", name: "Admin", email: "admin@example.com", role: "admin" }]);
    await db.execute(sql`insert into news_writing_profiles (key, version, name, status) values ('news-default', 1, 'Default', 'active')`);
    await db.execute(sql`insert into news_image_profiles (key, version, name, status) values ('cover-template', 1, 'Cover', 'active')`);
    const done = await importFiles(f, { policy: "overwrite" });
    expect(done.result!.status).toBe("applied");
    const row = await catalog.getItem("flow", flow.key);
    expect(row).toMatchObject({ definition: "content", label: "Kubernetes news" });
    const [job] = rowsOf<{ config: { source_ids: string[] } }>(await db.execute(sql`select config from news_jobs where id = ${row!.contentJobId}::uuid`));
    const [newSrc] = rowsOf<{ id: string }>(await db.execute(sql`select id from news_sources where url = 'https://kubernetes.io/feed.xml'`));
    expect(job!.config.source_ids).toEqual([newSrc!.id]);
    expect((await importFiles(f, { dryRun: true })).plan.items.filter((i) => i.action !== "unchanged")).toEqual([]);
  });

  it("still imports the one-file moks-crewai-config export (format 1)", async () => {
    const legacy = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "fixtures/crewai-config-format1.json"), "utf8"));
    const same = await io.importBundle(legacy, { dryRun: true }, ACTOR, { source: "admin" });
    expect(same.plan.format).toBe(1);
    expect(same.plan.items.every((i) => i.action === "unchanged")).toBe(true);
    const edited = { ...legacy, schedules: legacy.schedules.map((s: { name: string }) => (s.name === "gsc-sync" ? { ...s, cron: "30 5 * * *" } : s)), crews: [{ crew: "report", version: 4, note: "from staging", config: { agents: { analyst: { backstory: "Very terse." } } } }] };
    const r = await io.importBundle(edited, { policy: "overwrite" }, ACTOR, { source: "admin" });
    expect(r.result!.status).toBe("applied");
    expect((await schedules.scheduleByName("gsc-sync"))!.cron).toBe("30 5 * * *");
    expect((await crews.listVersions("report"))[0]).toMatchObject({ source: "import", active: true, note: "Imported (v4 in the file): from staging" });
    await expect(io.importBundle({ ...legacy, crews: [{ crew: "report", config: {} }] }, { prune: true }, ACTOR, { source: "admin" })).rejects.toThrow(/cannot remove/);
  });
});

// --- the site repository (a fake GitHub: just the REST and GraphQL calls lib/crewai/bundle/repo.ts makes) -----------

const { createHash } = await import("node:crypto");
const repo = await import("@/lib/crewai/bundle/repo");

type Commit = { files: Record<string, string>; parent: string | null; message: string; author: string };
function fakeGitHub() {
  const sha = (s: string) => createHash("sha1").update(s).digest("hex");
  const commits = new Map<string, Commit>();
  const branches = new Map<string, string>();
  const trees = new Map<string, Record<string, string>>();
  const pulls: { number: number; head: string; base: string; title: string }[] = [];
  const root = sha("root");
  commits.set(root, { files: { "README.md": "# site\n" }, parent: null, message: "init", author: "owner" });
  branches.set("master", root);
  const blobs = new Map<string, string>();
  const folder = (c: string) => Object.fromEntries(Object.entries(commits.get(c)!.files).filter(([p]) => p.startsWith("crewconfig/")).map(([p, t]) => [p.slice("crewconfig/".length), t]));
  const handle = (method: string, url: URL, body: Record<string, unknown>): { status: number; json: unknown } => {
    const p = url.pathname.replace(/^\/repos\/o\/r/, "");
    if (url.pathname === "/graphql") {
      const ids = [...String(body.query).matchAll(/(b\d+): object\(oid: "([0-9a-f]+)"\)/g)];
      return { status: 200, json: { data: { repository: Object.fromEntries(ids.map(([, a, s]) => [a, { text: blobs.get(s!) ?? null, isBinary: false }])) } } };
    }
    if (method === "GET" && p === "") return { status: 200, json: { permissions: { push: true } } };
    let m = /^\/branches\/(.+)$/.exec(p);
    if (m) return branches.has(decodeURIComponent(m[1]!)) ? { status: 200, json: { commit: { sha: branches.get(decodeURIComponent(m[1]!)) } } } : { status: 404, json: { message: "Branch not found" } };
    m = /^\/git\/commits\/([0-9a-f]{40})$/.exec(p);
    if (m && method === "GET") return { status: 200, json: { tree: { sha: `root-${m[1]}` } } };
    m = /^\/git\/trees\/root-([0-9a-f]{40})$/.exec(p);
    if (m) return { status: 200, json: { tree: Object.keys(folder(m[1]!)).length ? [{ path: "crewconfig", type: "tree", sha: `cfg-${m[1]}` }] : [] } };
    m = /^\/git\/trees\/cfg-([0-9a-f]{40})$/.exec(p);
    if (m) return { status: 200, json: { tree: Object.entries(folder(m[1]!)).map(([path, t]) => (blobs.set(sha(t), t), { path, type: "blob", sha: sha(t), size: t.length })) } };
    if (method === "POST" && p === "/git/trees") {
      const base = String(body.base_tree).replace(/^root-/, "");
      const files = { ...commits.get(base)!.files };
      for (const e of body.tree as { path: string; content?: string; sha?: null }[]) {
        if (e.sha === null) delete files[e.path];
        else files[e.path] = e.content!;
      }
      const id = `t${trees.size}`;
      trees.set(id, files);
      return { status: 201, json: { sha: id } };
    }
    if (method === "POST" && p === "/git/commits") {
      const files = trees.get(String(body.tree))!;
      const c = sha(JSON.stringify(files) + String(body.message) + (body.parents as string[])[0]);
      commits.set(c, { files, parent: (body.parents as string[])[0]!, message: String(body.message), author: (body.author as { name: string }).name });
      return { status: 201, json: { sha: c } };
    }
    m = /^\/git\/refs\/heads\/(.+)$/.exec(p);
    if (m && method === "PATCH") {
      const b = decodeURIComponent(m[1]!);
      if (commits.get(String(body.sha))!.parent !== branches.get(b)) return { status: 422, json: { message: "Update is not a fast forward" } };
      branches.set(b, String(body.sha));
      return { status: 200, json: {} };
    }
    if (method === "POST" && p === "/git/refs") {
      branches.set(String(body.ref).replace("refs/heads/", ""), String(body.sha));
      return { status: 201, json: {} };
    }
    if (method === "POST" && p === "/pulls") {
      pulls.push({ number: pulls.length + 1, head: String(body.head), base: String(body.base), title: String(body.title) });
      return { status: 201, json: { number: pulls.length, html_url: `https://github.com/o/r/pull/${pulls.length}` } };
    }
    m = /^\/contents\/crewconfig\/(.+)$/.exec(p);
    if (m) {
      const ref = url.searchParams.get("ref")!;
      const c = branches.get(ref) ?? ref;
      const t = commits.get(c)?.files[`crewconfig/${decodeURIComponent(m[1]!)}`];
      return t === undefined ? { status: 404, json: { message: "Not Found" } } : { status: 200, json: { type: "file", encoding: "base64", content: Buffer.from(t).toString("base64"), sha: sha(t) } };
    }
    if (p === "/commits") {
      const path = url.searchParams.get("path")!;
      const out = [];
      for (let c: string | null = branches.get(url.searchParams.get("sha")!)!; c; c = commits.get(c)!.parent) {
        const cur = commits.get(c)!;
        const prev = cur.parent ? commits.get(cur.parent)!.files : {};
        const touched = Object.keys({ ...cur.files, ...prev }).some((f) => f.startsWith(path) && cur.files[f] !== prev[f]);
        if (touched) out.push({ sha: c, html_url: `https://github.com/o/r/commit/${c}`, commit: { message: cur.message, author: { name: cur.author, date: "2026-11-24T10:00:00Z" } } });
      }
      return { status: 200, json: out };
    }
    return { status: 404, json: { message: `fake GitHub: ${method} ${p}` } };
  };
  return { handle, commits, branches, pulls, head: () => branches.get("master")!, folder, push: (files: Record<string, string>, message: string) => {
    const head = branches.get("master")!;
    const c = sha(message + head);
    commits.set(c, { files: { ...commits.get(head)!.files, ...Object.fromEntries(Object.entries(files).map(([p, t]) => [`crewconfig/${p}`, t])) }, parent: head, message, author: "someone" });
    branches.set("master", c);
    return c;
  } };
}

describe("the site repository", () => {
  let gh: ReturnType<typeof fakeGitHub>;
  const AUTHOR = { name: "Admin", email: "admin@example.com" };
  beforeEach(async () => {
    gh = fakeGitHub();
    const agentFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      if (u.host !== "api.github.com") return agentFetch(url, init);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer github_pat_test");
      const r = gh.handle(init?.method ?? "GET", u, init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {});
      return new Response(JSON.stringify(r.json), { status: r.status, headers: { "content-type": "application/json" } });
    });
    await repo.saveRepoSettings(ACTOR, { repo: "o/r", branch: "master", path: "crewconfig", mode: "commit", token: "github_pat_test" });
  });

  it("keeps the token sealed, writes the running configuration to Git, and imports it back as the same", async () => {
    const summary = await repo.repoSummary();
    expect(summary).toMatchObject({ repo: "o/r", configured: true, hasToken: true, tokenSource: "admin" });
    expect(JSON.stringify(summary)).not.toMatch(/github_pat_test/);
    const [row] = rowsOf<{ value: unknown }>(await db.execute(sql`select value from setting where key = 'crewai-repository'`));
    expect(JSON.stringify(row!.value)).not.toMatch(/github_pat_test/);

    const w = await repo.writeRuntimeToRepo(ACTOR, AUTHOR);
    expect(w.unchanged).toBe(false);
    expect(gh.folder(gh.head())["crews/editorial.yaml"]).toMatch(/definition: code/);
    expect(gh.commits.get(gh.head())!.author).toBe("Admin");
    expect((await repo.writeRuntimeToRepo(ACTOR, AUTHOR)).unchanged).toBe(true); // nothing new: no empty commit
    const cmp = await repo.repoCompare();
    expect(cmp).toMatchObject({ same: true, commit: gh.head() });
    // In commit mode the export is the baseline: the site is in step with Git.
    expect((await sync.syncStatus({ fresh: true })).drift).toMatchObject({ state: "in_sync" });
    const { files, commit } = await repo.repoFiles();
    const imp = await io.importBundle({ files }, { dryRun: true }, ACTOR, { source: "repository", revision: commit });
    expect(imp.plan.items.filter((i) => i.action !== "unchanged")).toEqual([]);
  });

  it("saves an edit as a commit after checking it, refuses a file changed in Git meanwhile, shows history and reverts", async () => {
    await repo.writeRuntimeToRepo(ACTOR, AUTHOR);
    const tree = await repo.repoTree();
    const file = tree.files.find((f) => f.path === "agents/report/analyst.md")!;
    const text = (await repo.repoFileAt(file.path, tree.commit))!.text;
    const edited = text.replace(/\n\n[\s\S]*$/, "\n\nTerse.\n");
    const saved = await repo.saveRepoFiles({ changes: { [file.path]: edited }, base: tree.commit, expected: { [file.path]: file.sha }, message: "crewconfig: terse analyst", author: AUTHOR }, ACTOR);
    expect(saved.files).toContain(file.path);
    expect(saved.files).toContain("manifest.json"); // the manifest follows the files
    expect(gh.folder(gh.head())[file.path]).toBe(edited);
    // Saving again from the old blob is a conflict, whoever changed it.
    await expect(repo.saveRepoFiles({ changes: { [file.path]: text }, base: tree.commit, expected: { [file.path]: file.sha }, message: "stale", author: AUTHOR }, ACTOR)).rejects.toMatchObject({ status: 409 });
    // A change that does not read is refused before anything is written.
    await expect(repo.saveRepoFiles({ changes: { "crews/report.yaml": "key: [" }, base: gh.head(), message: "broken", author: AUTHOR }, ACTOR)).rejects.toMatchObject({ status: 422 });
    const history = await repo.repoHistory(file.path);
    expect(history[0]).toMatchObject({ message: "crewconfig: terse analyst", author: "Admin" });
    const now = (await repo.repoTree()).files.find((f) => f.path === file.path)!;
    await repo.revertRepoFile(file.path, history[1]!.sha, gh.head(), now.sha, ACTOR, AUTHOR);
    expect(gh.folder(gh.head())[file.path]).toBe(text);
    // Someone pushes another file after the editor opened this one: the save builds on their commit and keeps it.
    const base = gh.head();
    const theirs = gh.folder(base)["schedules/schedules.yaml"]!.replace("cron: 10 6 * * *", "cron: 15 6 * * *");
    gh.push({ "schedules/schedules.yaml": theirs }, "someone else");
    const next = (await repo.repoTree()).files.find((f) => f.path === file.path)!;
    const r = await repo.saveRepoFiles({ changes: { [file.path]: edited }, base, expected: { [file.path]: next.sha }, message: "after a push", author: AUTHOR }, ACTOR);
    expect(r.commit).toBe(gh.head());
    expect(gh.folder(gh.head())["schedules/schedules.yaml"]).toBe(theirs);
    expect(gh.folder(gh.head())[file.path]).toBe(edited);
  });

  it("opens a pull request in pull request mode and leaves the branch alone", async () => {
    await repo.saveRepoSettings(ACTOR, { repo: "o/r", branch: "master", path: "crewconfig", mode: "pull_request" });
    const before = gh.head();
    const w = await repo.writeRuntimeToRepo(ACTOR, AUTHOR);
    expect(w.pullRequest).toMatchObject({ number: 1, url: "https://github.com/o/r/pull/1" });
    expect(gh.head()).toBe(before);
    expect(gh.pulls[0]).toMatchObject({ base: "master", head: expect.stringMatching(/^crewconfig\//) });
    // Until it merges and is imported, the export is not a baseline (Git does not hold it yet).
    expect((await sync.syncStatus({ fresh: true })).drift?.state).toBe("never_synced");
  });

  it("refuses to write an incomplete export to Git", async () => {
    agentUp = false;
    clearAgentCache();
    await expect(repo.writeRuntimeToRepo(ACTOR, AUTHOR)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/incomplete/) });
  });
});

// --- access: API keys and roles ----------------------------------------------------------------------------------------

describe("access", () => {
  it("lets only an admin's key with the crewai scopes export and import, and never an author", async () => {
    const { createApiKey } = await import("@/lib/api-keys");
    await db.insert(schema.user).values([{ id: "author", name: "Author", email: "author@example.com", role: "author" }]);
    await expect(createApiKey({ id: "author", role: "author", label: "author" }, { name: "ci", scopes: ["crewai:import"] })).rejects.toThrow(/Only an admin/);
    const read = await createApiKey(ACTOR, { name: "read", scopes: ["crewai:read"] });
    const full = await createApiKey(ACTOR, { name: "deploy", scopes: ["crewai:read", "crewai:import"] });
    const posts = await createApiKey(ACTOR, { name: "posts", scopes: ["posts:read"] });
    const exportRoute = await import("@/app/api/v1/crewai/config/route");
    const statusRoute = await import("@/app/api/v1/crewai/config/status/route");
    const importRoute = await import("@/app/api/v1/crewai/config/import/route");
    const get = (key: string) => new Request("https://jithendar.com/api/v1/crewai/config", { headers: { authorization: `Bearer ${key}` } });
    expect((await exportRoute.GET(get(posts.key))).status).toBe(403);
    const ex = await exportRoute.GET(get(read.key));
    expect(ex.status).toBe(200);
    const files = ((await ex.json()) as { data: { files: Record<string, string> } }).data.files;
    const st = (await (await statusRoute.GET(new Request("https://jithendar.com/api/v1/crewai/config/status", { headers: { authorization: `Bearer ${read.key}` } }))).json()) as { data: { database: string; migrations: { ok: boolean; pending: string[] } } };
    expect(st.data).toMatchObject({ database: "ok", migrations: { ok: true, pending: [] } });
    const post = (key: string, body: unknown) => new Request("https://jithendar.com/api/v1/crewai/config/import", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await importRoute.POST(post(read.key, { files }))).status).toBe(403);
    const plan = (await (await importRoute.POST(post(full.key, { files, source: "deploy", revision: "b".repeat(40) }))).json()) as { data: { plan: { ok: boolean; policy: string } } };
    expect(plan.data.plan).toMatchObject({ ok: true, policy: "skip" }); // a deployment's default: never overwrite a change made here
    const applied = await importRoute.POST(post(full.key, { files, dryRun: false, source: "deploy", revision: "b".repeat(40) }));
    expect(applied.status).toBe(200);
    expect((await sync.listSyncs())[0]).toMatchObject({ source: "deploy", revision: "b".repeat(40), actor: expect.stringMatching(/^api:/) });
    const refused = await importRoute.POST(post(full.key, { files: { ...files, "crews/xx.yaml": "key: [" }, dryRun: false }));
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { message: string } }).error.message).toMatch(/problem/);
  });

  it("keeps the admin's configuration pages and routes from authors", async () => {
    const configRoute = await import("@/app/api/admin/crewai/config/route");
    currentUser = { ...ADMIN, id: "author", role: "author" };
    const res = await configRoute.GET(new Request("https://jithendar.com/api/admin/crewai/config"));
    expect(res.status).toBe(403);
    const post = await configRoute.POST(new Request("https://jithendar.com/api/admin/crewai/config", { method: "POST", headers: { origin: "https://jithendar.com", host: "jithendar.com", "content-type": "application/json" }, body: "{}" }));
    expect(post.status).toBe(403);
    await expect(repo.saveRepoSettings({ id: "author", role: "author", label: "author" }, { repo: "o/r" })).rejects.toMatchObject({ status: 403 });
  });
});
