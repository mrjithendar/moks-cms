import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schema, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
import { freshDb } from "./db-helpers";
import { settingsInput } from "./seo-fixtures";
import { seedArticle } from "./seo-v2-fixtures";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
const stored: { key: string; bytes: number; contentType: string }[] = [];
vi.mock("@/lib/storage", () => ({
  putObject: async (key: string, body: Buffer, o: { contentType: string }) => void stored.push({ key, bytes: body.length, contentType: o.contentType }),
  presignGet: async (key: string) => `https://r2.example/${key}?sig=x`,
}));

const oauth = await import("@/lib/mcp-oauth/oauth");
const { seoTick } = await import("@/lib/seo-intel/jobs");
const { saveSeoSettings } = await import("@/lib/seo-intel/settings");
const { handleCallback } = await import("@/lib/seo-agent/internal-server");
const { callbackPort } = await import("@/lib/seo-agent/config");
const { orchestrator } = await import("@/lib/seo-agent/endpoint");
const reports = await import("@/lib/seo-intel/reports");

/**
 * SEO v4 on the web-app side: the admin MCP OAuth authorization server (PKCE, audience, rotation, reuse detection,
 * revocation, demoted admins), the scheduler handing flow-owned jobs to the CronJobs, the v4 callbacks, report
 * narrative + R2 PDF, and migration 0016.
 */
const env = { ...process.env };
const CB = "c".repeat(40);
let db: Db;
const cb = (method: string, path: string, body?: unknown) => handleCallback(method, `/internal/seo-agent${path}`, `Bearer ${CB}`, body, { ...process.env, SEO_AGENT_CALLBACK_TOKEN: CB });
const b64url = (b: Buffer) => b.toString("base64url");
const VERIFIER = "a".repeat(20) + "-verifier-" + "b".repeat(30);
const CHALLENGE = b64url(createHash("sha256").update(VERIFIER).digest());
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

beforeEach(async () => {
  db = await freshDb();
  await db.insert(schema.user).values([{ id: "admin", name: "Admin", email: "admin@example.com", role: "admin" }, { id: "author", name: "Author", email: "author@example.com", role: "author" }]);
  Object.assign(process.env, { SITE_URL: "https://jithendar.com", ADMIN_MCP_ENABLED: "true", SEO_AGENT_CALLBACK_TOKEN: CB });
  stored.length = 0;
});
afterEach(() => {
  process.env = { ...env };
});

async function connect(scope = "seo:read seo:flows") {
  const c = await oauth.register({ client_name: "Claude", redirect_uris: [REDIRECT] });
  const r = await oauth.parseAuthorize({ response_type: "code", client_id: c.client_id, redirect_uri: REDIRECT, code_challenge: CHALLENGE, code_challenge_method: "S256", scope, state: "st", resource: "https://jithendar.com/mcp/admin" });
  if (!("ok" in r)) throw new Error(JSON.stringify(r));
  const url = new URL(await oauth.approve(r.ok, "admin"));
  return { clientId: c.client_id, code: url.searchParams.get("code")!, url };
}

describe("admin MCP OAuth authorization server", () => {
  it("publishes RFC 8414 and RFC 9728 metadata for the /mcp/admin resource", () => {
    const m = oauth.metadata();
    expect(m).toMatchObject({ issuer: "https://jithendar.com", code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"], registration_endpoint: "https://jithendar.com/api/mcp-oauth/register" });
    expect(m.scopes_supported).toEqual(["seo:read", "seo:flows", "seo:review:reject"]);
    expect(m.scopes_supported.some((s) => /approve|publish/.test(s))).toBe(false); // no approve/publish scope exists
    expect(oauth.protectedResourceMetadata()).toEqual(expect.objectContaining({ resource: "https://jithendar.com/mcp/admin", authorization_servers: ["https://jithendar.com"] }));
  });

  it("code + PKCE → audience-bound tokens stored only as hashes (the resource server's lookup)", async () => {
    const { clientId, code, url } = await connect();
    expect(url.searchParams.get("state")).toBe("st");
    expect(url.searchParams.get("iss")).toBe("https://jithendar.com");
    const t = await oauth.exchange({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: VERIFIER, resource: "https://jithendar.com/mcp/admin" });
    expect(t).toMatchObject({ token_type: "Bearer", expires_in: 900, scope: "seo:read seo:flows" });
    const rows = rowsOf<{ token_hash: string; kind: string; resource: string }>(await db.execute(sql`select token_hash, kind, resource from seo_mcp_tokens`));
    expect(rows.map((r) => r.kind).sort()).toEqual(["access", "refresh"]);
    expect(JSON.stringify(rows)).not.toContain(t.access_token); // never stored in clear
    // exactly the query seo-agent's DbTokenVerifier runs (sha256 hex of the presented token)
    const [v] = rowsOf<{ scopes: string[] | string; resource: string }>(
      await db.execute(sql`select t.scopes, t.resource from seo_mcp_tokens t join seo_mcp_grants g on g.id = t.grant_id join "user" u on u.id = g.user_id
        where t.token_hash = ${createHash("sha256").update(t.access_token).digest("hex")} and t.kind = 'access' and t.revoked_at is null and t.expires_at > now() and g.revoked_at is null and u.role = 'admin'`),
    );
    expect(v?.resource).toBe("https://jithendar.com/mcp/admin");
  });

  it("refuses a wrong verifier, a wrong redirect, another resource, a replayed code (revoking the grant)", async () => {
    const { clientId, code } = await connect();
    await expect(oauth.exchange({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: "x".repeat(50) })).rejects.toMatchObject({ error: "invalid_grant" });
    await expect(oauth.exchange({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: "https://evil.example/cb", code_verifier: VERIFIER })).rejects.toMatchObject({ error: "invalid_grant" });
    await expect(oauth.exchange({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: VERIFIER, resource: "https://jithendar.com/mcp/public" })).rejects.toMatchObject({ error: "invalid_target" });
    const ok = await oauth.exchange({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: VERIFIER });
    await expect(oauth.exchange({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: VERIFIER })).rejects.toMatchObject({ error: "invalid_grant" });
    await expect(oauth.exchange({ grant_type: "refresh_token", refresh_token: ok.refresh_token, client_id: clientId })).rejects.toMatchObject({ error: "invalid_grant" }); // grant revoked by the replay
  });

  it("rotates refresh tokens, detects reuse, never widens scopes, and stops for a demoted admin", async () => {
    const { clientId, code } = await connect("seo:read");
    const t1 = await oauth.exchange({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: VERIFIER });
    await expect(oauth.exchange({ grant_type: "refresh_token", refresh_token: t1.refresh_token, client_id: clientId, scope: "seo:read seo:flows" })).rejects.toMatchObject({ error: "invalid_scope" });
    const t2 = await oauth.exchange({ grant_type: "refresh_token", refresh_token: t1.refresh_token, client_id: clientId });
    expect(t2.refresh_token).not.toBe(t1.refresh_token);
    await expect(oauth.exchange({ grant_type: "refresh_token", refresh_token: t1.refresh_token, client_id: clientId })).rejects.toMatchObject({ error: "invalid_grant" }); // reuse
    await expect(oauth.exchange({ grant_type: "refresh_token", refresh_token: t2.refresh_token, client_id: clientId })).rejects.toMatchObject({ error: "invalid_grant" }); // whole grant revoked
    const again = await connect("seo:read");
    const t3 = await oauth.exchange({ grant_type: "authorization_code", code: again.code, client_id: again.clientId, redirect_uri: REDIRECT, code_verifier: VERIFIER });
    await db.execute(sql`update "user" set role = 'author' where id = 'admin'`);
    await expect(oauth.exchange({ grant_type: "refresh_token", refresh_token: t3.refresh_token, client_id: again.clientId })).rejects.toMatchObject({ error: "invalid_grant" });
  });

  it("revocation from Settings kills every token of the grant at once", async () => {
    const { clientId, code } = await connect();
    await oauth.exchange({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: VERIFIER });
    const [g] = await oauth.listGrants();
    expect(g).toMatchObject({ client_name: "Claude", scopes: ["seo:read", "seo:flows"], revoked_at: null });
    await oauth.revokeGrantById(g!.id);
    const live = rowsOf(await db.execute(sql`select 1 from seo_mcp_tokens where revoked_at is null`));
    expect(live).toEqual([]);
  });

  it("validates registration and authorize requests", async () => {
    await expect(oauth.register({ client_name: "x", redirect_uris: ["http://evil.example/cb"] })).rejects.toMatchObject({ error: "invalid_redirect_uri" });
    await expect(oauth.register({ client_name: "x", redirect_uris: ["https://a.example/cb"], token_endpoint_auth_method: "client_secret_basic" })).rejects.toMatchObject({ error: "invalid_client_metadata" });
    expect((await oauth.register({ client_name: "Inspector", redirect_uris: ["http://localhost:6274/oauth/callback"] })).client_id).toMatch(/^mcp_/);
    const c = await oauth.register({ client_name: "Claude", redirect_uris: [REDIRECT] });
    const base = { response_type: "code", client_id: c.client_id, redirect_uri: REDIRECT, code_challenge: CHALLENGE, code_challenge_method: "S256" };
    expect(await oauth.parseAuthorize({ ...base, redirect_uri: "https://evil.example/cb" })).toHaveProperty("show"); // never redirect to an unregistered URI
    expect(await oauth.parseAuthorize({ ...base, code_challenge_method: "plain" })).toMatchObject({ back: { error: "invalid_request" } });
    expect(await oauth.parseAuthorize({ ...base, scope: "seo:read seo:publish" })).toMatchObject({ back: { error: "invalid_scope" } });
    expect(await oauth.parseAuthorize({ ...base, scope: "seo:flows" })).toMatchObject({ ok: { scopes: ["seo:read", "seo:flows"] } });
  });

  it("stores redirect URIs exactly, whatever characters they hold", async () => {
    // Commas, quotes, braces and backslashes are all legal in a URL.
    const awkward = ['https://app.example/cb?ids=1,2&q={"a":"b"}', "https://app.example/back\\slash", REDIRECT];
    const c = await oauth.register({ client_name: "Awkward", redirect_uris: awkward });
    expect((await oauth.getClient(c.client_id))?.redirectUris).toEqual(awkward);
    for (const redirect_uri of awkward) {
      const request = { response_type: "code", client_id: c.client_id, redirect_uri, code_challenge: CHALLENGE, code_challenge_method: "S256", scope: "seo:read" };
      expect(await oauth.parseAuthorize(request)).toMatchObject({ ok: { redirectUri: redirect_uri } });
    }
  });
});

describe("scheduling: each job runs once, through one scheduler", () => {
  it("crewai mode leaves flow-owned job types to the CronJobs; legacy keeps them", async () => {
    await saveSeoSettings(settingsInput(), "admin");
    const at = new Date("2026-11-09T12:00:00Z"); // a Monday, after every daily hour
    const kinds = async () => rowsOf<{ t: string }>(await db.execute(sql`select payload->>'type' as t from job where kind = 'seo'`)).map((r) => r.t);
    await seoTick(at, { SEO_ORCHESTRATOR: "crewai" });
    const crew = await kinds();
    expect(crew).not.toContain("gsc_sync");
    expect(crew).not.toContain("ga4_sync");
    expect(crew).not.toContain("drafts_weekly");
    await db.execute(sql`delete from job`);
    await seoTick(at, { SEO_ORCHESTRATOR: "legacy" });
    expect(await kinds()).toEqual(expect.arrayContaining(["gsc_sync"]));
  });

  it("orchestrator: forced by crewai, the v3 alias langgraph and legacy; otherwise legacy until an agent is found", async () => {
    expect(await orchestrator({ env: { SEO_ORCHESTRATOR: "crewai" } })).toBe("crewai");
    expect(await orchestrator({ env: { SEO_ORCHESTRATOR: "langgraph" } })).toBe("crewai");
    expect(await orchestrator({ env: { SEO_ORCHESTRATOR: "legacy" } })).toBe("legacy");
    const nobody = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await orchestrator({ env: { SEO_AGENT_TOKEN: "t" }, fetchImpl: nobody, readAdminUrl: async () => null })).toBe("legacy");
    // The callback listener is off only when forced legacy (it also needs SEO_AGENT_CALLBACK_TOKEN).
    expect(callbackPort({ SEO_ORCHESTRATOR: "crewai" })).toBe(9465);
    expect(callbackPort({})).toBe(9465);
    expect(callbackPort({ SEO_ORCHESTRATOR: "legacy" })).toBe(0);
  });
});

describe("v4 callbacks", () => {
  it("runJob is idempotent per scheduled slot", async () => {
    await db.execute(sql`insert into seo_sync_jobs (job_type, trigger, status, correlation_id, detail) values ('gsc_sync', 'schedule', 'succeeded', 'x', '{"slot":"2026-11-10"}'::jsonb)`);
    const r = await cb("POST", "/jobs/run", { type: "gsc_sync", slot: "2026-11-10", trigger: "schedule" });
    expect(r).toMatchObject({ status: 200, body: { status: "skipped", skipped: "slot already ran" } });
    expect((await cb("POST", "/jobs/run", { type: "publish", trigger: "manual" })).status).toBe(400); // only the three job types
  });

  it("notes, topics, open drafts and unknown data views", async () => {
    const a = await seedArticle(db, {});
    const [d] = rowsOf<{ id: string }>(await db.execute(sql`insert into seo_drafts (article_id, collection, status, base_version, base_snapshot, changes, trigger) values (${a.id}, 'blog', 'ready_for_review', 1, '{}'::jsonb, '[]'::jsonb, 'manual') returning id`));
    expect((await cb("POST", `/drafts/${d!.id}/notes`, { note: "Check the versions.", actor: "mcp:claude" })).status).toBe(200);
    const diff = await cb("GET", `/drafts/${d!.id}/diff`);
    expect((diff.body as { notes: { note: string }[] }).notes[0]!.note).toBe("Check the versions.");
    expect((await cb("GET", "/drafts/open-articles")).body).toEqual({ articleIds: [a.id] });
    expect((await cb("GET", "/data/secrets")).status).toBe(404);
    expect((await cb("GET", "/articles/topics")).status).toBe(200);
  });

  it("report narrative is stored only after a passed check; the PDF goes to R2 under a private, unguessable key", async () => {
    await saveSeoSettings(settingsInput(), "admin");
    const g = await cb("POST", "/reports/generate", { period: "weekly" });
    expect(g.status).toBe(200);
    const id = (g.body as { id: string }).id;
    expect((g.body as { report: { daily: unknown[] } }).report.daily).toBeInstanceOf(Array);
    expect((await cb("POST", `/reports/${id}/narrative`, { narrative: "x", check: { ok: false } })).status).toBe(409);
    expect((await cb("POST", `/reports/${id}/narrative`, { narrative: "Clicks rose 5%.", check: { ok: true } })).status).toBe(200);
    expect((await cb("POST", `/reports/${id}/pdf`, { pdf: Buffer.from("not a pdf at all, but long enough to pass the size floor of one hundred bytes......").toString("base64") })).status).toBe(400);
    const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(500, 32)]);
    const p = await cb("POST", `/reports/${id}/pdf`, { pdf: pdf.toString("base64") });
    expect(p.status).toBe(200);
    expect(stored[0]!.key).toMatch(/^jithendar\/www\/reports\/seo\/weekly\/\d{4}\/\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}-[0-9a-f-]{36}\.pdf$/);
    expect(stored[0]!.contentType).toBe("application/pdf");
    const r = (await reports.getReport(id)) as unknown as { narrative: string; pdf: { key: string } };
    expect(r.narrative).toBe("Clicks rose 5%.") ;
    expect(r.pdf.key).toBe(stored[0]!.key);
    expect(await cb("POST", `/reports/${id}/notify`)).toMatchObject({ status: 200, body: { emailed: 0 } });
  });
});

describe("migration 0016", () => {
  it("applies, rolls back and re-applies", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrateDb, migrationsDir } = await import("@/db/migrate");
    const pg = new PGlite();
    const clean = drizzle(pg, { schema }) as unknown as Db;
    await migrateDb(clean);
    const n = async () => rowsOf(await clean.execute(sql`select 1 from information_schema.tables where table_name in ('seo_flow_runs', 'seo_draft_notes', 'seo_mcp_clients', 'seo_mcp_grants', 'seo_mcp_codes', 'seo_mcp_tokens')`)).length;
    expect(await n()).toBe(6);
    // one active run per flow + target
    await clean.execute(sql`insert into seo_flow_runs (run_id, flow_name, target_id, status, triggered_by) values (gen_random_uuid(), 'gsc_sync_flow', 'site', 'running', 'cron')`);
    await expect(clean.execute(sql`insert into seo_flow_runs (run_id, flow_name, target_id, status, triggered_by) values (gen_random_uuid(), 'gsc_sync_flow', 'site', 'queued', 'cron')`)).rejects.toThrow();
    await expect(clean.execute(sql`insert into seo_flow_runs (run_id, flow_name, target_id, status, triggered_by) values (gen_random_uuid(), 'publish_flow', 'x', 'running', 'mcp')`)).resolves.toBeDefined(); // the DB allows it; the agent's policy is what refuses
    for (const stmt of fs.readFileSync(path.resolve(migrationsDir(), "../rollback/0016_seo_v4.down.sql"), "utf8").split("--> statement-breakpoint").map((x) => x.trim()).filter(Boolean)) await clean.execute(sql.raw(stmt));
    expect(await n()).toBe(0);
    expect(await migrateDb(clean)).toEqual(["0016_seo_v4.sql"]);
    await pg.close();
  });
});
