import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schema, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
import type { Actor } from "@/lib/posts";
import { freshDb } from "./db-helpers";
import { settingsInput } from "./seo-fixtures";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "user-agent": "vitest" }), cookies: async () => ({ getAll: () => [] }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const custom = await import("@/lib/crewai/custom");
const flows = await import("@/lib/crewai/flows");
const { handleCallback } = await import("@/lib/seo-agent/internal-server");
const { saveSeoSettings } = await import("@/lib/seo-intel/settings");

/**
 * Custom crews and flows made in the admin (crew-jobs plan PR 6, migration 0039). The SEO agent checks every spec
 * (POST /custom/validate, mocked here: it echoes the spec, or refuses one whose key is "refused").
 */
const admin: Actor = { id: "admin", role: "admin", label: "admin@example.com" };
const CB = "c".repeat(40);
const cb = (method: string, p: string, body?: unknown) => handleCallback(method, `/internal/seo-agent${p}`, `Bearer ${CB}`, body, { ...process.env, SEO_AGENT_CALLBACK_TOKEN: CB });
const env = { ...process.env };
let db: Db;
let validated: { kind: string; crews?: string[] }[] = [];

const CREW = { key: "explainer", label: "Explainer", inputs: ["topic"], agents: [{ key: "writer", role: "Writer", goal: "g", backstory: "b", tools: [] }], tasks: [{ key: "write", agent: "writer", label: "Write", instructions: "Write {topic}.", expected_output: "MDX", context: [] }] };
const FLOW = { key: "explain_topic", label: "Explain a topic", inputs: ["topic"], steps: [{ kind: "crew", crew: "explainer", inputs: { topic: "{input.topic}" }, save_as: "result" }, { kind: "draft", title: "{input.topic}", body: "{steps.result}", collection: "blog" }] };

beforeEach(async () => {
  db = await freshDb();
  await db.insert(schema.user).values([{ id: "admin", name: "Admin", email: "admin@example.com", role: "admin" }]);
  await db.insert(schema.authorProfile).values({ userId: "admin", slug: "jithendar-dharmapuri", displayName: "Admin" });
  await saveSeoSettings(settingsInput(), "admin");
  Object.assign(process.env, { SEO_ORCHESTRATOR: "crewai", SEO_AGENT_TOKEN: "a".repeat(40), SEO_AGENT_CALLBACK_TOKEN: CB, SEO_AGENT_URL: "http://seo-agent.test:8080" });
  validated = [];
  vi.stubGlobal("fetch", (async (u: string | URL, init?: RequestInit) => {
    if (!String(u).endsWith("/custom/validate")) return Response.json({}, { status: 404 });
    const b = JSON.parse(String(init?.body)) as { kind: string; spec: { key: string }; crews?: string[] };
    validated.push({ kind: b.kind, crews: b.crews });
    if (b.spec.key === "refused") return Response.json({ error: "invalid spec", issues: ["agents.0.tools: shell is not allowed"] }, { status: 422 });
    return Response.json({ spec: b.spec });
  }) as typeof fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...env };
});

describe("custom crews and flows", () => {
  it("are checked by the SEO agent, saved as versions and served to it only while switched on", async () => {
    expect((await custom.saveCustom("crew", admin, CREW)).version).toBe(1);
    expect((await custom.saveCustom("crew", admin, { ...CREW, label: "Explainer 2" })).version).toBe(2);
    await custom.saveCustom("flow", admin, FLOW);
    expect(validated.at(-1)).toEqual({ kind: "flow", crews: ["explainer"] }); // a flow is checked against the crews that are on
    await expect(custom.saveCustom("crew", admin, { ...CREW, key: "refused" })).rejects.toMatchObject({ status: 422, issues: ["agents.0.tools: shell is not allowed"] });
    await expect(custom.saveCustom("crew", admin, { ...CREW, key: "Bad Key" })).rejects.toMatchObject({ status: 400 });
    const served = await cb("GET", "/custom-crews");
    expect(served.status).toBe(200);
    expect((served.body as { items: { key: string; version: number }[] }).items).toEqual([{ key: "explainer", version: 2, spec: { ...CREW, label: "Explainer 2", description: "" } }]);
    expect(((await cb("GET", "/custom-flows")).body as { items: unknown[] }).items).toHaveLength(1);
  });

  it("a crew a flow uses can be neither switched off nor deleted; deleting a flow removes its schedules; a deleted key stays taken", async () => {
    await custom.saveCustom("crew", admin, CREW);
    await custom.saveCustom("flow", admin, FLOW);
    await expect(custom.setCustomEnabled("crew", admin, "explainer", false)).rejects.toMatchObject({ status: 409 });
    await expect(custom.deleteCustom("crew", admin, "explainer")).rejects.toMatchObject({ status: 409 });
    await db.execute(sql`insert into seo_flow_schedules (name, flow_name, cron, inputs) values ('explain-weekly', 'custom_flow', '0 7 * * 1', '{"flow": "explain_topic", "inputs": {"topic": "kubelet"}}'::jsonb)`);
    expect(await custom.deleteCustom("flow", admin, "explain_topic")).toEqual({ schedulesRemoved: 1 });
    expect(((await cb("GET", "/custom-flows")).body as { items: unknown[] }).items).toEqual([]);
    expect(await custom.deleteCustom("crew", admin, "explainer")).toEqual({ schedulesRemoved: 0 });
    await expect(custom.saveCustom("crew", admin, CREW)).rejects.toMatchObject({ status: 409 }); // its run history names it
  });

  it("a custom flow's draft step is a draft post in the review queue, checked like every new article", async () => {
    const r = await cb("POST", "/custom/drafts", { title: "Kubelet explained", description: "What the kubelet does on every node.", body: "## What it is\n\nThe kubelet is the node agent.", collection: "blog", flow: "explain_topic", runId: "r1" });
    expect(r.status).toBe(200);
    const body = r.body as { draftId: string; postId: string; errors: string[] };
    expect(body.errors).toEqual([]);
    const [post] = await db.select().from(schema.post).where(sql`id = ${body.postId}`);
    expect(post).toMatchObject({ collection: "blog", contentType: "tutorial", status: "draft" });
    const [d] = rowsOf<{ status: string; summary: string }>(await db.execute(sql`select status, summary from seo_drafts where id = ${body.draftId}`));
    expect(d).toMatchObject({ status: "ready_for_review", summary: "Custom flow explain_topic: Kubelet explained" });
  });

  it("custom_flow is a flow a person or a schedule may start", () => {
    expect(flows.flowInfo("custom_flow").group).toBe("Custom");
    expect(flows.SCHEDULABLE_FLOWS).toContain("custom_flow");
    expect(flows.rerunBlocked("custom_flow")).toBeNull();
  });
});
