import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schema, type Db } from "@/db";
import type { SessionUser } from "@/lib/session";
import { freshDb } from "./db-helpers";
import { settingsInput } from "./seo-fixtures";

let currentUser: SessionUser | null = null;
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "user-agent": "vitest" }), cookies: async () => ({ getAll: () => [], get: () => undefined }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }), usePathname: () => "/admin/crewai/flows", useSearchParams: () => new URLSearchParams(), redirect: (u: string) => { throw new Error(`NEXT_REDIRECT ${u}`); }, notFound: () => { throw new Error("NEXT_NOT_FOUND"); } }));
vi.mock("@/lib/session", () => ({ getSessionUser: async () => currentUser, requireRole: async () => currentUser, requireUser: async () => currentUser }));

const { renderToStaticMarkup } = await import("react-dom/server");
const catalog = await import("@/lib/crewai/catalog");
const modules = await import("@/lib/modules");
const { saveSeoSettings } = await import("@/lib/seo-intel/settings");
const { clearAgentCache } = await import("@/lib/seo-agent/endpoint");
const { default: CrewsPage } = await import("@/app/admin/crewai/crews/page");
const { default: CrewPage } = await import("@/app/admin/crewai/crews/[crew]/page");
const { default: NewCrewPage } = await import("@/app/admin/crewai/crews/new/page");
const { default: FlowsPage } = await import("@/app/admin/crewai/flows/page");
const { default: FlowPage } = await import("@/app/admin/crewai/flows/[name]/page");
const { default: NewFlowPage } = await import("@/app/admin/crewai/flows/new/page");
const { default: CategoriesPage } = await import("@/app/admin/crewai/categories/page");
const { default: OldCustomCrewPage } = await import("@/app/admin/crewai/crews/custom/[key]/page");
const listRoute = await import("@/app/api/admin/crewai/catalog/[kind]/route");
const itemRoute = await import("@/app/api/admin/crewai/catalog/[kind]/[key]/route");
const testRoute = await import("@/app/api/admin/crewai/catalog/[kind]/test/route");
const catRoute = await import("@/app/api/admin/crewai/categories/route");
const capRoute = await import("@/app/api/admin/capabilities/route");
const { ModuleGate } = await import("@/components/admin/ModuleGate");
const { StepInspector } = await import("@/components/crewai/StepInspector");
const { ConsoleNav } = await import("@/components/crewai/ConsoleNav");

/** The unified crews and flows console (D-100): pages, API routes, the module registry and the step inspector. */
const ADMIN: SessionUser = { id: "admin", name: "Admin", email: "admin@example.com", role: "admin", emailVerified: true, image: null, sessionCreatedAt: new Date() };
const env = { ...process.env };
let db: Db;
let kicked: Record<string, unknown>[] = [];

const CREW = { key: "explainer", label: "Explainer", inputs: [{ name: "topic", required: true }], agents: [{ key: "writer", role: "Writer", goal: "Write well", backstory: "Plain", tools: [] }], tasks: [{ key: "write", agent: "writer", label: "Write", instructions: "Write {topic}.", expected_output: "MDX", context: [] }] };
const FLOW = { key: "explain_topic", label: "Explain a topic", inputs: ["topic"], steps: [{ kind: "crew", crew: "explainer", inputs: { topic: "{input.topic}" }, save_as: "result", retry: { attempts: 2, delay_seconds: 5, backoff: 2 }, on_failure: "continue" }, { kind: "draft", title: "{input.topic}", body: "{steps.result}", collection: "blog" }] };
const req = (url: string, method = "GET", body?: unknown) => new Request(`https://jithendar.com${url}`, { method, headers: { origin: "https://jithendar.com", host: "jithendar.com", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const p = <T extends Record<string, string>>(v: T) => ({ params: Promise.resolve(v) });
const text = (html: string) => html.replace(/<[^>]+>/g, " ");

beforeEach(async () => {
  db = await freshDb();
  await db.insert(schema.user).values([{ id: "admin", name: "Admin", email: "admin@example.com", role: "admin" }]);
  await db.insert(schema.authorProfile).values({ userId: "admin", slug: "jithendar-dharmapuri", displayName: "Admin" });
  await saveSeoSettings(settingsInput(), "admin");
  currentUser = ADMIN;
  kicked = [];
  Object.assign(process.env, { SEO_ORCHESTRATOR: "crewai", SEO_AGENT_TOKEN: "a".repeat(40), SEO_AGENT_URL: "http://seo-agent.test:8080" });
  clearAgentCache();
  vi.stubGlobal("fetch", (async (u: string | URL, init?: RequestInit) => {
    const path = new URL(String(u)).pathname;
    const b = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (path === "/custom/validate") return Response.json({ spec: b.spec });
    if (path.endsWith("/kickoff")) {
      kicked.push({ path, ...b });
      return Response.json({ run_id: "11111111-2222-4333-8444-555555555555", status: "queued", existing: false }, { status: 202 });
    }
    if (path === "/flows") return Response.json({ items: [{ name: "gsc_sync_flow", label: "Search Console sync", inputs_schema: { properties: {} }, approval_only: false, schedulable: true, mcp: true, crews: [], flow_step: true, categories: ["seo"], start: "manual" }] });
    return Response.json({}, { status: 404 });
  }) as typeof fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...env };
  clearAgentCache();
});

describe("pages", () => {
  it("Crews and Flows are one list each, filtered on the server, with the same filter bar", async () => {
    await catalog.createItem("crew", { id: "admin", role: "admin", label: "admin@example.com" }, { key: "explainer", label: "Explainer", description: "Explains Kubernetes", categories: ["research"], tags: ["k8s"], spec: CREW });
    const crews = renderToStaticMarkup(await CrewsPage({ searchParams: Promise.resolve({}) }));
    for (const h of ["Editorial crew", "Report crew", "Explainer", "New crew", "Search crews by name, description or tag", "Categories", "Tags"]) expect(crews).toContain(h);
    expect(crews).not.toMatch(/Custom crews|Built-in/);
    const filtered = renderToStaticMarkup(await CrewsPage({ searchParams: Promise.resolve({ category: "research" }) }));
    expect(filtered).toContain("Explainer");
    expect(filtered).not.toContain("Editorial crew");
    expect(filtered).toContain("Clear all");
    const none = renderToStaticMarkup(await CrewsPage({ searchParams: Promise.resolve({ q: "nothing-like-this" }) }));
    expect(none).toContain("Nothing matches these filters.");
    const flows = renderToStaticMarkup(await FlowsPage({ searchParams: Promise.resolve({ sort: "updated" }) }));
    for (const h of ["Search Console sync", "New flow", "New content flow", "Search flows by name, description or tag"]) expect(flows).toContain(h);
    expect(text(flows)).not.toMatch(/Built-in flows|Custom flows|System flow/);
  });

  it("a code crew's page has the same header and details as any crew, its version editor, and the flows that run it", async () => {
    const html = renderToStaticMarkup(await CrewPage({ params: Promise.resolve({ crew: "editorial" }), searchParams: Promise.resolve({}) }));
    for (const h of ["Editorial crew", "Details", "Objective", "Run by", "New article", "Duplicate", "Delete", "Switch off", "Agents and tasks", "Run history"]) expect(html).toContain(h);
  });

  it("a spec crew's page has its inputs, model, agents, tasks, output, Check, Test run and versions", async () => {
    await catalog.createItem("crew", { id: "admin", role: "admin", label: "admin@example.com" }, { key: "explainer", label: "Explainer", spec: CREW });
    const html = renderToStaticMarkup(await CrewPage({ params: Promise.resolve({ crew: "explainer" }), searchParams: Promise.resolve({}) }));
    for (const h of ["Inputs", "Default model", "Agents", "Tasks, in order", "Output", "Check", "Start test run", "Versions", "v1"]) expect(html).toContain(h);
    expect(renderToStaticMarkup(await NewCrewPage())).toContain("Create crew");
    await expect(OldCustomCrewPage({ params: Promise.resolve({ key: "explainer" }) })).rejects.toThrow("NEXT_REDIRECT /admin/crewai/crews/explainer");
  });

  it("a step flow's page is the builder: steps, when it runs, if it fails, test and run", async () => {
    const admin = { id: "admin", role: "admin" as const, label: "admin@example.com" };
    await catalog.createItem("crew", admin, { key: "explainer", label: "Explainer", spec: CREW });
    await catalog.createItem("flow", admin, { key: "explain_topic", label: "Explain a topic", spec: FLOW });
    const html = renderToStaticMarkup(await FlowPage({ params: Promise.resolve({ name: "explain_topic" }) }));
    for (const h of ["Steps", "Drag", "When it runs", "If it fails", "retry ×2", "continue on failure", "Test run", "Run now", "Versions", "Run history"]) expect(html).toContain(h);
    const fresh = renderToStaticMarkup(await NewFlowPage());
    for (const h of ["New flow", "+ Crew", "+ Flow", "+ Condition", "+ Draft", "Create flow"]) expect(fresh).toContain(h);
    const code = renderToStaticMarkup(await FlowPage({ params: Promise.resolve({ name: "gsc_sync_flow" }) }));
    for (const h of ["Search Console sync", "Details", "Run with parameters", "Duplicate", "Schedules"]) expect(code).toContain(h);
  });

  it("Categories lists each with its crews and flows", async () => {
    const html = renderToStaticMarkup(await CategoriesPage());
    for (const h of ["SEO", "Content", "Automation", "Rename", "Remove", "New category"]) expect(html).toContain(h);
  });

  it("the console's tabs are crews and flows only: no Skills, Content or Settings links", () => {
    const html = renderToStaticMarkup(<ConsoleNav agent={{ enabled: true, version: "x", reason: "" }} />);
    for (const h of ["Flows", "Runs", "Crews", "Categories", "Configuration"]) expect(html).toContain(h);
    for (const gone of ["Skills ↗", "Content ↗", "Settings ↗", "/admin/automation/skills"]) expect(html).not.toContain(gone);
  });

  it("the run page's step inspector shows attempts, conditions, versions and redacted previews", () => {
    const html = renderToStaticMarkup(
      <StepInspector
        steps={[
          { id: 1, seq: 1, step: "1-crew", status: "succeeded", startedAt: "2026-11-24T10:00:00Z", finishedAt: "2026-11-24T10:00:09Z", error: null, seconds: 9, detail: { id: "research", kind: "crew", crew: "explainer", crew_version: 3, flow_version: 7, tokens: 1200, cost_usd: 0.01, attempts: [{ attempt: 1, status: "failed", error: "ConnectionError: overloaded" }, { attempt: 2, status: "succeeded", seconds: 8 }], input: { type: "object", keys: ["topic"], values: { topic: { type: "text", chars: 7, preview: "kubelet" } } }, output: { type: "text", chars: 900, preview: "The kubelet…" } } },
          { id: 2, seq: 2, step: "2-crew", status: "succeeded", startedAt: "2026-11-24T10:00:09Z", finishedAt: null, error: null, seconds: 0, detail: { id: "polish", kind: "crew", when: { op: "contains", operand: "draft", held: false }, outcome: "skipped" } },
          { id: 3, seq: 3, step: "3-flow", status: "succeeded", startedAt: "2026-11-24T10:00:09Z", finishedAt: null, error: null, seconds: 1, detail: { seconds: 1 } },
        ]}
      />,
    );
    for (const h of ["Steps in detail", "research", "2 attempts", "ConnectionError: overloaded", "explainer", "v3", "kubelet", "did not hold", "skipped"]) expect(html).toContain(h);
    expect(html).not.toContain("3-flow"); // a step with only its time recorded has nothing to inspect
  });
});

describe("API routes", () => {
  it("list, create, edit, duplicate, switch, delete and restore through one API; categories too", async () => {
    let r = await catRoute.POST(req("/api/admin/crewai/categories", "POST", { label: "Security" }), p({}));
    expect(r.status).toBe(201);
    r = await listRoute.POST(req("/api/admin/crewai/catalog/crews", "POST", { key: "explainer", label: "Explainer", categories: ["security"], tags: ["k8s"], spec: CREW }), p({ kind: "crews" }));
    expect(r.status).toBe(201);
    r = await listRoute.GET(req("/api/admin/crewai/catalog/crews?category=security&tag=k8s"), p({ kind: "crews" }));
    const page = (await r.json()) as { items: { key: string }[]; total: number };
    expect(page.items.map((i) => i.key)).toEqual(["explainer"]);
    r = await itemRoute.PATCH(req("/api/admin/crewai/catalog/flows/gsc_sync_flow", "PATCH", { categories: ["security"], tags: ["daily"] }), p({ kind: "flows", key: "gsc_sync_flow" }));
    expect(((await r.json()) as { item: { tags: string[] } }).item.tags).toEqual(["daily"]);
    r = await itemRoute.POST(req("/api/admin/crewai/catalog/flows/gsc_sync_flow", "POST", { action: "duplicate", key: "gsc_then_report", label: "GSC then report" }), p({ kind: "flows", key: "gsc_sync_flow" }));
    expect(r.status).toBe(201);
    r = await itemRoute.POST(req("/api/admin/crewai/catalog/flows/gsc_sync_flow", "POST", { action: "disable", reason: "quota" }), p({ kind: "flows", key: "gsc_sync_flow" }));
    expect(((await r.json()) as { item: { enabled: boolean; disabledReason: string } }).item).toMatchObject({ enabled: false, disabledReason: "quota" });
    r = await itemRoute.DELETE(req("/api/admin/crewai/catalog/crews/editorial", "DELETE"), p({ kind: "crews", key: "editorial" }));
    expect(r.status).toBe(409); // new_article_flow runs it
    r = await itemRoute.DELETE(req("/api/admin/crewai/catalog/crews/explainer", "DELETE"), p({ kind: "crews", key: "explainer" }));
    expect(r.status).toBe(200);
    r = await itemRoute.POST(req("/api/admin/crewai/catalog/crews/explainer", "POST", { action: "restore" }), p({ kind: "crews", key: "explainer" }));
    expect(((await r.json()) as { item: { enabled: boolean; deletedAt: string | null } }).item).toMatchObject({ enabled: false, deletedAt: null });
    r = await listRoute.GET(req("/api/admin/crewai/catalog/widgets"), p({ kind: "widgets" }));
    expect(r.status).toBe(404);
  });

  it("a test run of a draft is a dry run of custom_flow carrying the drafts, checked first", async () => {
    const draft = { ...FLOW, key: "test_explainer" };
    const r = await testRoute.POST(req("/api/admin/crewai/catalog/flows/test", "POST", { draft, crewDraft: CREW, inputs: { topic: "etcd" } }), p({ kind: "flows" }));
    expect(r.status).toBe(202);
    expect(kicked[0]).toMatchObject({ path: "/flows/custom_flow/kickoff", triggered_by: "manual", inputs: { flow: "test_explainer", dry_run: true, inputs: { topic: "etcd" }, draft: { key: "test_explainer" }, crew_draft: { key: "explainer" } } });
    expect((await testRoute.POST(req("/api/admin/crewai/catalog/flows/test", "POST", { flow: "gsc_sync_flow" }), p({ kind: "flows" }))).status).toBe(404);
  });

  it("GET /api/admin/capabilities says which modules this deployment has", async () => {
    const r = await capRoute.GET(req("/api/admin/capabilities"), p({}));
    const body = (await r.json()) as { modules: { id: string; installed: boolean; menuGroups: string[]; setupHref: string }[] };
    expect(body.modules).toEqual([expect.objectContaining({ id: "seo-agent", installed: true, menuGroups: ["ai"], setupHref: "/admin/integrations?section=seo-agent" })]);
  });
});

describe("the SEO agent module", () => {
  const status = (s: Partial<Awaited<ReturnType<typeof import("@/lib/seo-agent/endpoint").agentStatus>>>) => async () => ({ enabled: false, mode: "auto" as const, url: null, source: null, version: null, reason: "x", adminUrl: null, envUrl: null, tried: [], checkedAt: "", ...s });

  it("is installed when set up (even while it is down), not when nothing is set up or it is switched off", async () => {
    expect((await modules.moduleState("seo-agent", { status: status({ enabled: true, source: "discovered" }) })).installed).toBe(true);
    expect(await modules.moduleState("seo-agent", { status: status({ enabled: false, source: "admin" }) })).toMatchObject({ installed: true, available: false });
    expect((await modules.moduleState("seo-agent", { status: status({ enabled: false, source: null }) })).installed).toBe(false);
    expect((await modules.moduleState("seo-agent", { status: status({ enabled: false, mode: "forced off" }) })).installed).toBe(false);
    expect((await modules.moduleState("seo-agent", { status: async () => { throw new Error("boom"); } })).installed).toBe(false);
  });

  it("hides the AI & SEO menu, and only it, when the module is missing", () => {
    const items = [
      { href: "/admin/posts", label: "Posts", section: "Content" },
      { href: "/admin/crewai/flows", label: "Flows", section: "Site settings" },
      { href: "/admin/search", label: "Search performance", section: "Insights" },
      { href: "/admin/automation", label: "AI & SEO settings", section: "Site settings" },
      { href: "/admin/integrations", label: "Integrations", section: "Site settings" },
    ];
    const missing = [{ id: "seo-agent" as const, label: "SEO agent", installed: false, available: false, version: null, reason: "", menuGroups: ["ai"], setupHref: "" }];
    expect(modules.menuForModules(items, missing).map((i) => i.href)).toEqual(["/admin/posts", "/admin/integrations"]);
    expect(modules.menuForModules(items, [{ ...missing[0]!, installed: true }])).toHaveLength(5);
    expect(modules.moduleOfPath("/admin/crewai/runs/abc")).toBe("seo-agent");
    expect(modules.moduleOfPath("/admin/posts/new")).toBeNull();
  });

  it("its pages say how to set it up instead of rendering, when it is missing", async () => {
    process.env.SEO_ORCHESTRATOR = "legacy";
    clearAgentCache();
    const html = renderToStaticMarkup(await ModuleGate({ module: "seo-agent", children: <p>secret page</p> }));
    expect(html).toContain("SEO agent is not set up");
    expect(html).toContain("/admin/integrations?section=seo-agent");
    expect(html).not.toContain("secret page");
    process.env.SEO_ORCHESTRATOR = "crewai";
    clearAgentCache();
    expect(renderToStaticMarkup(await ModuleGate({ module: "seo-agent", children: <p>secret page</p> }))).toContain("secret page");
  });
});
