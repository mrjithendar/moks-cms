import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schema, setDbForTests, type Db } from "@/db";
import type { AgentSettingField, AgentSettingsGroup } from "@/lib/seo-agent/client";
import type { SessionUser } from "@/lib/session";
import { freshDb } from "./db-helpers";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "user-agent": "vitest" }), cookies: async () => ({ getAll: () => [] }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
let currentUser: SessionUser | null = null;
vi.mock("@/lib/session", () => ({ getSessionUser: async () => currentUser, requireRole: async () => currentUser, requireUser: async () => currentUser }));

const as = (role: "admin" | "author", id: string = role): SessionUser => ({ id, name: role, email: `${id}@example.com`, role, emailVerified: true, image: null, sessionCreatedAt: new Date() });

/**
 * Admin → Automation & AI → Agent limits. The seo-agent owns these settings (moks-seo-agent/app/admin_settings, tested
 * in moks-seo-agent/tests/test_admin_settings.py); this app draws the fields the agent reports and hands a save to
 * the agent's PUT /admin-settings/{group}. It keeps nothing itself.
 */
let db: Db;
type Sent = { method: string; path: string; body: unknown; auth: string | null };
let sent: Sent[] = [];
let agent: "ok" | "down" | "old" = "ok";

const field = (over: Partial<AgentSettingField> & Pick<AgentSettingField, "env" | "label" | "type">): AgentSettingField => ({
  hint: "A hint.",
  apply: "live",
  unit: null,
  min: null,
  max: null,
  options: [],
  source: "default",
  updated_by: null,
  updated_at: null,
  restart_pending: false,
  ...over,
});

const GROUP = (): AgentSettingsGroup => ({
  id: "agent-limits",
  title: "Agent limits",
  description: "How much a crew may use.",
  restart_pending: false,
  fields: [
    field({ env: "CREW_MAX_ITER", label: "Turns per agent", type: "integer", unit: "turns", min: 1, max: 20, source: "admin", value: 8, default: 4, deployment: 6 }),
    field({ env: "CREW_MAX_RPM", label: "Model requests per minute, per crew", type: "integer", unit: "requests per minute", min: 1, max: 600, source: "deployment", value: 30, default: 20, deployment: 30 }),
    field({ env: "SEO_LLM_TIMEOUT_SECONDS", label: "Model request time limit", type: "number", unit: "seconds", apply: "restart", value: 120, default: 120, deployment: null }),
    field({ env: "SEO_AGENT_DOCS_ALLOWLIST", label: "Documentation sites agents may read", type: "list", source: "admin", value: ["kubernetes.io", "istio.io"], default: ["kubernetes.io"], deployment: null }),
    field({ env: "ASK_BLOG_ENABLED", label: "Ask the Blog", type: "boolean", value: false, default: false, deployment: null }),
    field({ env: "EMBEDDINGS_API_KEY", label: "Embeddings key", type: "secret", apply: "restart", source: "admin", set: true, deployment_set: false, editable: true }),
  ],
});
const VIEW = () => ({ groups: [GROUP()], secrets_key_set: true, refresh_seconds: 30, restart_pending: false });

beforeEach(async () => {
  db = await freshDb();
  await db.insert(schema.user).values([as("admin"), as("author")].map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role })));
  currentUser = null;
  sent = [];
  agent = "ok";
  vi.stubEnv("BETTER_AUTH_SECRET", "s".repeat(40));
  vi.stubEnv("SEO_AGENT_TOKEN", "a".repeat(40));
  vi.stubEnv("SEO_ORCHESTRATOR", "crewai");
  vi.stubGlobal("fetch", (async (url: string, init?: RequestInit) => {
    if (agent === "down") throw new TypeError("fetch failed");
    const path = new URL(url).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    sent.push({ method: init?.method ?? "GET", path, body, auth: new Headers(init?.headers).get("authorization") });
    if (agent === "old" && path.startsWith("/admin-settings")) return new Response(JSON.stringify({ detail: "Not Found" }), { status: 404 });
    if (path === "/admin-settings/agent-limits" && init?.method === "PUT") {
      const b = body as { values: Record<string, unknown> };
      if (b.values.CREW_MAX_ITER === 99) return new Response(JSON.stringify({ error: "the settings are not valid", issues: ["Turns per agent: at most 20"] }), { status: 422 });
      return new Response(JSON.stringify(VIEW()), { status: 200 });
    }
    if (path === "/admin-settings/nope") return new Response(JSON.stringify({ error: "no such settings group" }), { status: 404 });
    if (path === "/admin-settings") return new Response(JSON.stringify(VIEW()), { status: 200 });
    return new Response(JSON.stringify({ status: "ready" }), { status: 200 });
  }) as typeof fetch);
  setDbForTests(db);
});

afterEach(() => {
  setDbForTests(undefined);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const put = async (group: string, body: unknown) => {
  const { PUT } = await import("@/app/api/admin/seo/agent-settings/[group]/route");
  return PUT(new Request(`https://jithendar.com/api/admin/seo/agent-settings/${group}`, { method: "PUT", headers: { origin: "https://jithendar.com", host: "jithendar.com", "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ group }) });
};
const get = async () => {
  const { GET } = await import("@/app/api/admin/seo/agent-settings/route");
  return GET(new Request("https://jithendar.com/api/admin/seo/agent-settings"));
};

describe("admin API (a thin client of the seo-agent)", () => {
  it("only admins may read or change them", async () => {
    expect((await get()).status).toBe(401);
    currentUser = as("author");
    expect((await get()).status).toBe(403);
    expect((await put("agent-limits", { values: { CREW_MAX_ITER: 5 } })).status).toBe(403);
    expect(sent.filter((s) => s.path.startsWith("/admin-settings"))).toEqual([]);
  });

  it("shows the groups and fields the agent reports", async () => {
    currentUser = as("admin");
    const body = (await (await get()).json()) as { view: { groups: AgentSettingsGroup[] }; error: string | null; tooOld: boolean };
    expect(body.error).toBeNull();
    expect(body.view.groups[0]?.fields.map((f) => f.env)).toContain("CREW_MAX_ITER");
    expect(sent.at(-1)).toMatchObject({ method: "GET", path: "/admin-settings", auth: `Bearer ${"a".repeat(40)}` });
  });

  it("saves through the agent with the admin as the actor, and audit-logs the field names without values", async () => {
    currentUser = as("admin");
    const res = await put("agent-limits", { values: { CREW_MAX_ITER: 5, CREW_MAX_RPM: null, EMBEDDINGS_API_KEY: "sk-live-123" } });
    expect(res.status).toBe(200);
    const call = sent.find((s) => s.method === "PUT");
    expect(call).toMatchObject({ path: "/admin-settings/agent-limits", body: { values: { CREW_MAX_ITER: 5, CREW_MAX_RPM: null, EMBEDDINGS_API_KEY: "sk-live-123" } } });
    expect(typeof (call?.body as { actor?: unknown }).actor).toBe("string");
    const rows = await db.select().from(schema.auditLog);
    const row = rows.find((r) => r.action === "seo.agent_settings.update");
    expect(row?.target).toBe("agent-limits");
    expect(row?.detail).toMatchObject({ saved: ["CREW_MAX_ITER", "EMBEDDINGS_API_KEY"], cleared: ["CREW_MAX_RPM"] });
    expect(JSON.stringify(rows)).not.toContain("sk-live-123");
    expect(await db.select().from(schema.setting)).toEqual([]);
  });

  it("passes the agent's refusal on with its issues, and writes no audit entry", async () => {
    currentUser = as("admin");
    const res = await put("agent-limits", { values: { CREW_MAX_ITER: 99 } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { issues: string[] }).issues).toEqual(["Turns per agent: at most 20"]);
    expect((await db.select().from(schema.auditLog)).filter((r) => r.action === "seo.agent_settings.update")).toEqual([]);
  });

  it("refuses a body that is not a set of setting names, before the agent is asked", async () => {
    currentUser = as("admin");
    for (const bad of [{ values: { "not an env name": 1 } }, { values: { CREW_MAX_ITER: { nested: true } } }, { CREW_MAX_ITER: 5 }, { values: [5] }]) expect((await put("agent-limits", bad)).status).toBe(400);
    expect((await put("Bad Group!", { values: {} })).status).toBe(404);
    expect(sent.filter((s) => s.method === "PUT")).toEqual([]);
  });

  it("says so when the agent cannot be reached, and when it is too old to have these settings", async () => {
    currentUser = as("admin");
    agent = "down";
    const down = (await (await get()).json()) as { view: unknown; error: string; tooOld: boolean };
    expect(down).toMatchObject({ view: null, tooOld: false });
    expect(down.error).toMatch(/unreachable/i);
    expect((await put("agent-limits", { values: { CREW_MAX_ITER: 5 } })).status).toBe(503);
    agent = "old";
    const old = (await (await get()).json()) as { view: unknown; error: string; tooOld: boolean };
    expect(old).toMatchObject({ view: null, tooOld: true });
    expect(old.error).toMatch(/newer seo-agent/);
    const res = await put("agent-limits", { values: { CREW_MAX_ITER: 5 } });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toMatch(/newer seo-agent/);
  });
});

describe("the settings card", () => {
  it("starts a field with the admin's saved value, and empty when the deployment or the default applies", async () => {
    const { draftsOf } = await import("@/components/seo/AgentSettingsGroup");
    expect(draftsOf(GROUP())).toEqual({ CREW_MAX_ITER: "8", CREW_MAX_RPM: "", SEO_LLM_TIMEOUT_SECONDS: "", SEO_AGENT_DOCS_ALLOWLIST: "kubernetes.io\nistio.io", ASK_BLOG_ENABLED: "", EMBEDDINGS_API_KEY: "" });
  });

  it("sends only what changed: an emptied field as null, numbers as numbers, a list one entry per line", async () => {
    const { changesOf, draftsOf } = await import("@/components/seo/AgentSettingsGroup");
    const g = GROUP();
    expect(changesOf(g, draftsOf(g))).toEqual({ values: {}, issues: [] });
    const out = changesOf(g, { ...draftsOf(g), CREW_MAX_ITER: "", CREW_MAX_RPM: " 45 ", SEO_LLM_TIMEOUT_SECONDS: "300.5", SEO_AGENT_DOCS_ALLOWLIST: "kubernetes.io\n\n helm.sh , istio.io", ASK_BLOG_ENABLED: "true" });
    expect(out).toEqual({ values: { CREW_MAX_ITER: null, CREW_MAX_RPM: 45, SEO_LLM_TIMEOUT_SECONDS: 300.5, SEO_AGENT_DOCS_ALLOWLIST: ["kubernetes.io", "helm.sh", "istio.io"], ASK_BLOG_ENABLED: true }, issues: [] });
    expect(changesOf(g, { ...draftsOf(g), CREW_MAX_RPM: "fast" })).toEqual({ values: {}, issues: ["Model requests per minute, per crew: enter a number"] });
  });

  it("never sends a secret it was not given, and removes one only when asked", async () => {
    const { changesOf, draftsOf } = await import("@/components/seo/AgentSettingsGroup");
    const g = GROUP();
    expect(changesOf(g, draftsOf(g)).values).not.toHaveProperty("EMBEDDINGS_API_KEY");
    expect(changesOf(g, { ...draftsOf(g), EMBEDDINGS_API_KEY: " sk-new " }).values).toEqual({ EMBEDDINGS_API_KEY: "sk-new" });
    expect(changesOf(g, draftsOf(g), ["EMBEDDINGS_API_KEY"]).values).toEqual({ EMBEDDINGS_API_KEY: null });
  });

  it("names the value that applies without the admin's", async () => {
    const { inEffect } = await import("@/components/seo/AgentSettingsGroup");
    const f = Object.fromEntries(GROUP().fields.map((x) => [x.env, x]));
    expect(inEffect(f.CREW_MAX_ITER!)).toBe("6 turns"); // saved here: the deployment's value would apply
    expect(inEffect(f.CREW_MAX_RPM!)).toBe("30 requests per minute");
    expect(inEffect(f.SEO_AGENT_DOCS_ALLOWLIST!)).toBe("1 entry");
    expect(inEffect(f.ASK_BLOG_ENABLED!)).toBe("off");
    expect(inEffect(f.EMBEDDINGS_API_KEY!)).toBe("not set");
  });
});
