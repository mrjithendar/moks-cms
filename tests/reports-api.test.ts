import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schema, setDbForTests, type Db } from "@/db";
import type { SessionUser } from "@/lib/session";
import { freshDb } from "./db-helpers";
import { fakeR2 } from "./fake-r2";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "user-agent": "vitest" }), cookies: async () => ({ getAll: () => [] }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
let currentUser: SessionUser | null = null;
vi.mock("@/lib/session", () => ({ getSessionUser: async () => currentUser, requireRole: async () => currentUser, requireUser: async () => currentUser }));
const r2 = fakeR2();
vi.mock("@/lib/storage", async (orig) => ({ ...(await orig<typeof import("@/lib/storage")>()), ...r2 }));
vi.mock("@/lib/seo-agent/endpoint", async (orig) => ({ ...(await orig<typeof import("@/lib/seo-agent/endpoint")>()), orchestrator: async () => "legacy" }));

const as = (role: "admin" | "author" | "user"): SessionUser => ({ id: role, name: role, email: `${role}@example.com`, role, emailVerified: true, image: null, sessionCreatedAt: new Date() }) as SessionUser;
const list = await import("@/app/api/admin/crewai/reports/route");
const one = await import("@/app/api/admin/crewai/reports/[id]/route");
const download = await import("@/app/api/admin/crewai/reports/[id]/download/route");
const preview = await import("@/app/api/admin/crewai/reports/[id]/preview/route");
const options = await import("@/app/api/admin/crewai/reports/options/route");
const { reportJobHandler } = await import("@/lib/reports/service");
const { runDueJobs } = await import("@/lib/jobs");

const URL_ = "https://jithendar.com/api/admin/crewai/reports";
const post = (url: string, body: unknown, origin = "https://jithendar.com") => new Request(url, { method: "POST", headers: { origin, host: "jithendar.com", "content-type": "application/json" }, body: JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
let db: Db;

beforeEach(async () => {
  db = await freshDb();
  await db.insert(schema.user).values({ id: "admin", name: "Admin", email: "admin@example.com", role: "admin" });
  currentUser = as("admin");
  r2.objects.clear();
});
afterEach(() => setDbForTests(undefined));

describe("reports API", () => {
  it("is for admins only, and refuses cross-site requests", async () => {
    currentUser = null;
    expect((await list.GET(new Request(URL_))).status).toBe(401);
    currentUser = as("author");
    expect((await list.GET(new Request(URL_))).status).toBe(403);
    expect((await list.POST(post(URL_, { range: { preset: "today" }, categories: ["crewai"] }))).status).toBe(403);
    currentUser = as("admin");
    expect((await list.POST(post(URL_, { range: { preset: "today" }, categories: ["crewai"] }, "https://evil.example"))).status).toBe(403);
  });

  it("queues a report (202), returns the same one while it is open (200), and validates", async () => {
    expect((await list.POST(post(URL_, { range: { preset: "custom", start: "2026-01-02", end: "2026-01-01" }, categories: ["crewai"] }))).status).toBe(400);
    const r1 = await list.POST(post(URL_, { range: { preset: "last_30_days" }, categories: ["crewai", "operations"] }));
    expect(r1.status).toBe(202);
    const { id } = (await r1.json()) as { id: string };
    const r2_ = await list.POST(post(URL_, { range: { preset: "last_30_days" }, categories: ["operations", "crewai"] }));
    expect(r2_.status).toBe(200);
    expect(((await r2_.json()) as { id: string }).id).toBe(id);
    const audit = await db.execute(sql`select action from audit_log where target = ${id}`);
    expect(JSON.stringify(audit)).toContain("report.generate");
    // The list, the status the page polls, and the options for the form.
    const items = ((await (await list.GET(new Request(`${URL_}?status=queued`))).json()) as { items: { id: string }[] }).items;
    expect(items.map((i) => i.id)).toEqual([id]);
    expect(((await (await one.GET(new Request(`${URL_}/${id}`), params(id))).json()) as { report: { status: string } }).report.status).toBe("queued");
    const opts = (await (await options.GET(new Request(`${URL_}/options`))).json()) as { categories: unknown[]; sources: { key: string; status: string }[] };
    expect(opts.categories).toHaveLength(15);
    expect(opts.sources.find((s) => s.key === "ga4")?.status).toBe("empty");
  });

  it("downloads through a short-lived signed link, previews with a CSP, and deletes with its files", async () => {
    const { id } = (await (await list.POST(post(URL_, { range: { preset: "today" }, categories: ["editorial"] }))).json()) as { id: string };
    expect((await download.GET(new Request(`${URL_}/${id}/download?format=html`), params(id))).status).toBe(404); // not built yet
    await runDueJobs({ report: reportJobHandler });
    const res = await download.GET(new Request(`${URL_}/${id}/download?format=html`), params(id));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/^https:\/\/r2\.test\/jithendar\/www\/reports\/.+\/report\.html\?X-Amz-Signature=/);
    expect((await download.GET(new Request(`${URL_}/${id}/download?format=exe`), params(id))).status).toBe(400);
    const p = await preview.GET(new Request(`${URL_}/${id}/preview`), params(id));
    expect(p.headers.get("content-security-policy")).toMatch(/default-src 'none'.*sandbox/);
    expect(await p.text()).toMatch(/^<!doctype html>/);
    const del = await one.DELETE(new Request(`${URL_}/${id}`, { method: "DELETE", headers: { origin: "https://jithendar.com", host: "jithendar.com" } }), params(id));
    expect(del.status).toBe(200);
    expect([...r2.objects.keys()].filter((k) => k.includes(id))).toEqual([]);
    expect((await one.GET(new Request(`${URL_}/${id}`), params(id))).status).toBe(404);
  });
});
