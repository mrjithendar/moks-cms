import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { rowsOf } from "@/db/rows";
import { siteOrigin } from "../seo-intel/urls";

/**
 * Minimal OAuth 2.1 authorization server for the admin MCP (docs/seo/MCP.md, DECISIONS.md D-60).
 *
 * - Public clients only (PKCE S256, no client secret), dynamic client registration (RFC 7591) so Claude's custom
 *   connector and MCP Inspector can register themselves.
 * - Consent requires a signed-in **admin** (the site's existing Better Auth session) on /admin/mcp/authorize.
 * - Tokens are audience-bound (RFC 8707) to the /mcp/admin resource, opaque, and stored only as SHA-256 hashes in
 *   the shared Postgres; seo-agent (the resource server) verifies them with one lookup. Access tokens live 15 minutes;
 *   refresh tokens 30 days and rotate on every use; presenting a used refresh token revokes the whole grant.
 * - Scopes: seo:read, seo:flows, seo:review:reject. There is no approve/publish scope.
 */
export const SCOPES = {
  "seo:read": "Read SEO metrics, keyword opportunities, the review queue, draft diffs, audit issues, flow runs and LLM usage",
  "seo:flows": "Start drafting, sync, audit and report flows (drafts still wait for your approval on the site)",
  "seo:review:reject": "Reject drafts and add review notes",
} as const;
export type Scope = keyof typeof SCOPES;
export const ACCESS_TTL_S = 15 * 60;
export const REFRESH_TTL_S = 30 * 24 * 3600;
const CODE_TTL_S = 60;

export class OAuthError extends Error {
  constructor(
    readonly error: "invalid_request" | "invalid_client" | "invalid_grant" | "unauthorized_client" | "unsupported_grant_type" | "invalid_scope" | "invalid_target" | "access_denied" | "invalid_redirect_uri" | "invalid_client_metadata",
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
  body() {
    return { error: this.error, error_description: this.message };
  }
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const token = (prefix: string) => `${prefix}${randomBytes(32).toString("base64url")}`;
export const resourceUrl = (origin = siteOrigin()) => `${origin.origin}/mcp/admin`;
export const issuer = (origin = siteOrigin()) => origin.origin;

export function metadata(origin = siteOrigin()) {
  const o = origin.origin;
  return {
    issuer: o,
    authorization_endpoint: `${o}/mcp-oauth/authorize`,
    token_endpoint: `${o}/api/mcp-oauth/token`,
    registration_endpoint: `${o}/api/mcp-oauth/register`,
    revocation_endpoint: `${o}/api/mcp-oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: Object.keys(SCOPES),
    service_documentation: `${o}/admin/automation/mcp`,
  };
}

export function protectedResourceMetadata(origin = siteOrigin()) {
  return { resource: resourceUrl(origin), authorization_servers: [issuer(origin)], scopes_supported: Object.keys(SCOPES), bearer_methods_supported: ["header"], resource_name: "jithendar.com SEO admin (MCP)" };
}

/** https only, except loopback (MCP Inspector, desktop clients); no fragments, no credentials. */
export function redirectOk(u: string): boolean {
  try {
    const url = new URL(u);
    if (url.hash || url.username || url.password) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

const registration = z.object({
  client_name: z.string().trim().min(1).max(100).default("MCP client"),
  redirect_uris: z.array(z.string().max(500)).min(1).max(5),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  token_endpoint_auth_method: z.string().optional(),
  software_id: z.string().max(100).optional(),
});

export async function register(raw: unknown) {
  const r = registration.safeParse(raw ?? {});
  if (!r.success) throw new OAuthError("invalid_client_metadata", "client_name and redirect_uris are required.");
  const b = r.data;
  if (!b.redirect_uris.every(redirectOk)) throw new OAuthError("invalid_redirect_uri", "Redirect URIs must be https (or http on localhost) without fragments.");
  if (b.token_endpoint_auth_method && b.token_endpoint_auth_method !== "none") throw new OAuthError("invalid_client_metadata", "Only public clients (token_endpoint_auth_method none, with PKCE) are supported.");
  if (b.grant_types && !b.grant_types.every((g) => g === "authorization_code" || g === "refresh_token")) throw new OAuthError("invalid_client_metadata", "Unsupported grant type.");
  const clientId = `mcp_${randomBytes(16).toString("hex")}`;
  const db = await getDb();
  // One bound parameter per URI. They used to be pasted into an array literal by hand, which dropped quotes and let a
  // backslash escape the character after it, so a registered URI could differ from the one later compared against it.
  const uris = sql.join(b.redirect_uris.map((u) => sql`${u}::text`), sql`, `);
  await db.execute(sql`insert into seo_mcp_clients (client_id, client_name, redirect_uris, software_id) values (${clientId}, ${b.client_name}, array[${uris}]::text[], ${b.software_id ?? null})`);
  return { client_id: clientId, client_name: b.client_name, redirect_uris: b.redirect_uris, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", client_id_issued_at: Math.floor(Date.now() / 1000) };
}

export async function getClient(clientId: string) {
  if (!/^mcp_[0-9a-f]{32}$/.test(clientId)) return null;
  const db = await getDb();
  // As JSON text: the same for every driver, and a URI with a comma or a quote in it comes back whole.
  const [c] = rowsOf<{ client_id: string; client_name: string; redirect_uris: string }>(await db.execute(sql`select client_id, client_name, array_to_json(redirect_uris)::text as redirect_uris from seo_mcp_clients where client_id = ${clientId}`));
  if (!c) return null;
  return { clientId: c.client_id, name: c.client_name, redirectUris: JSON.parse(c.redirect_uris) as string[] };
}

export type AuthorizeRequest = { clientId: string; clientName: string; redirectUri: string; state: string | null; scopes: Scope[]; codeChallenge: string; resource: string };

/**
 * Validate an /authorize request. Errors about the client or redirect URI are shown on the page (never redirected to
 * an unverified URI); the rest go back to the client as ?error=… per RFC 6749 §4.1.2.1.
 */
export async function parseAuthorize(q: Record<string, string | undefined>): Promise<{ ok: AuthorizeRequest } | { show: string } | { back: { redirectUri: string; error: string; description: string; state: string | null } }> {
  const client = await getClient(q.client_id ?? "");
  if (!client) return { show: "Unknown client. Add the connector again so it can register." };
  const redirectUri = q.redirect_uri ?? "";
  if (!client.redirectUris.includes(redirectUri)) return { show: "The redirect URI does not match what this client registered." };
  const state = q.state ?? null;
  const back = (error: string, description: string) => ({ back: { redirectUri, error, description, state } });
  if (q.response_type !== "code") return back("unsupported_response_type", "Only response_type=code is supported.");
  if (q.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(q.code_challenge ?? "")) return back("invalid_request", "PKCE with code_challenge_method=S256 is required.");
  const resource = q.resource ?? resourceUrl();
  if (resource !== resourceUrl()) return back("invalid_target", "Tokens are issued only for the /mcp/admin resource.");
  const requested = (q.scope ?? "seo:read").split(/\s+/).filter(Boolean);
  if (!requested.every((s) => s in SCOPES)) return back("invalid_scope", `Supported scopes: ${Object.keys(SCOPES).join(" ")}.`);
  const scopes = [...new Set(requested.includes("seo:read") ? requested : ["seo:read", ...requested])] as Scope[];
  return { ok: { clientId: client.clientId, clientName: client.name, redirectUri, state, scopes, codeChallenge: q.code_challenge!, resource } };
}

/** The admin approved: a grant + a single-use code. Returns the client redirect URL. */
export async function approve(req: AuthorizeRequest, userId: string): Promise<string> {
  const db = await getDb();
  const [g] = rowsOf<{ id: string }>(await db.execute(sql`insert into seo_mcp_grants (client_id, user_id, scopes, resource) values (${req.clientId}, ${userId}, ${`{${req.scopes.join(",")}}`}::text[], ${req.resource}) returning id`));
  const code = token("jcm_code_");
  await db.execute(sql`insert into seo_mcp_codes (code_hash, grant_id, redirect_uri, code_challenge, expires_at) values (${sha256(code)}, ${g!.id}, ${req.redirectUri}, ${req.codeChallenge}, now() + make_interval(secs => ${CODE_TTL_S}))`);
  const u = new URL(req.redirectUri);
  u.searchParams.set("code", code);
  if (req.state) u.searchParams.set("state", req.state);
  u.searchParams.set("iss", issuer());
  return u.toString();
}

export function denyUrl(req: { redirectUri: string; state: string | null }, error = "access_denied", description = "The admin declined."): string {
  const u = new URL(req.redirectUri);
  u.searchParams.set("error", error);
  u.searchParams.set("error_description", description);
  if (req.state) u.searchParams.set("state", req.state);
  return u.toString();
}

async function issueTokens(grantId: string, clientId: string, scopes: string[], resource: string) {
  const db = await getDb();
  const access = token("jcm_at_");
  const refresh = token("jcm_rt_");
  const arr = `{${scopes.join(",")}}`;
  await db.execute(sql`insert into seo_mcp_tokens (token_hash, kind, grant_id, client_id, scopes, resource, expires_at) values
    (${sha256(access)}, 'access', ${grantId}, ${clientId}, ${arr}::text[], ${resource}, now() + make_interval(secs => ${ACCESS_TTL_S})),
    (${sha256(refresh)}, 'refresh', ${grantId}, ${clientId}, ${arr}::text[], ${resource}, now() + make_interval(secs => ${REFRESH_TTL_S}))`);
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: scopes.join(" ") };
}

async function revokeGrant(grantId: string) {
  const db = await getDb();
  await db.execute(sql`update seo_mcp_grants set revoked_at = coalesce(revoked_at, now()) where id = ${grantId}`);
  await db.execute(sql`update seo_mcp_tokens set revoked_at = coalesce(revoked_at, now()) where grant_id = ${grantId}`);
}

/** The grant's admin must still be an admin (a demoted or banned user's tokens stop working). */
async function grantActive(grantId: string) {
  const db = await getDb();
  const [g] = rowsOf<{ ok: boolean }>(await db.execute(sql`select (g.revoked_at is null and u.role = 'admin' and coalesce(u.banned, false) = false) as ok from seo_mcp_grants g join "user" u on u.id = g.user_id where g.id = ${grantId}`));
  return Boolean(g?.ok);
}

const pkceOk = (verifier: string, challenge: string) => {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const a = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** POST /token: authorization_code (with PKCE) or refresh_token (rotating, reuse detection). */
export async function exchange(p: Record<string, string | undefined>) {
  const db = await getDb();
  const clientId = p.client_id ?? "";
  if (!(await getClient(clientId))) throw new OAuthError("invalid_client", "Unknown client.", 401);
  if (p.resource && p.resource !== resourceUrl()) throw new OAuthError("invalid_target", "Tokens are issued only for the /mcp/admin resource.");
  if (p.grant_type === "authorization_code") {
    const [c] = rowsOf<{ grant_id: string; redirect_uri: string; code_challenge: string; expired: boolean; used_at: string | null; client_id: string; scopes: string[] | string; resource: string }>(
      await db.execute(sql`select c.grant_id, c.redirect_uri, c.code_challenge, c.expires_at < now() as expired, c.used_at, g.client_id, g.scopes, g.resource from seo_mcp_codes c join seo_mcp_grants g on g.id = c.grant_id where c.code_hash = ${sha256(p.code ?? "")}`),
    );
    if (!c || c.client_id !== clientId) throw new OAuthError("invalid_grant", "Invalid authorization code.");
    if (c.used_at) {
      await revokeGrant(c.grant_id); // a replayed code: revoke everything issued from it (RFC 6749 §4.1.2)
      throw new OAuthError("invalid_grant", "Authorization code already used.");
    }
    if (c.expired) throw new OAuthError("invalid_grant", "Authorization code expired.");
    if (c.redirect_uri !== p.redirect_uri) throw new OAuthError("invalid_grant", "redirect_uri does not match.");
    if (!pkceOk(p.code_verifier ?? "", c.code_challenge)) throw new OAuthError("invalid_grant", "PKCE verification failed.");
    const used = rowsOf(await db.execute(sql`update seo_mcp_codes set used_at = now() where code_hash = ${sha256(p.code ?? "")} and used_at is null returning 1`));
    if (!used.length) throw new OAuthError("invalid_grant", "Authorization code already used.");
    if (!(await grantActive(c.grant_id))) throw new OAuthError("invalid_grant", "The grant is no longer valid.");
    return issueTokens(c.grant_id, clientId, pgArr(c.scopes), c.resource);
  }
  if (p.grant_type === "refresh_token") {
    const h = sha256(p.refresh_token ?? "");
    const [t] = rowsOf<{ grant_id: string; client_id: string; scopes: string[] | string; resource: string; expired: boolean; used_at: string | null; revoked_at: string | null }>(
      await db.execute(sql`select grant_id, client_id, scopes, resource, expires_at < now() as expired, used_at, revoked_at from seo_mcp_tokens where token_hash = ${h} and kind = 'refresh'`),
    );
    if (!t || t.client_id !== clientId) throw new OAuthError("invalid_grant", "Invalid refresh token.");
    if (t.used_at || t.revoked_at) {
      if (t.used_at) await revokeGrant(t.grant_id); // reuse of a rotated refresh token: assume theft, revoke the grant
      throw new OAuthError("invalid_grant", "Refresh token is no longer valid.");
    }
    if (t.expired) throw new OAuthError("invalid_grant", "Refresh token expired.");
    if (!(await grantActive(t.grant_id))) throw new OAuthError("invalid_grant", "The grant is no longer valid.");
    const granted = pgArr(t.scopes);
    const want = p.scope ? p.scope.split(/\s+/).filter(Boolean) : granted;
    if (!want.every((s) => granted.includes(s))) throw new OAuthError("invalid_scope", "A refresh cannot widen the granted scopes.");
    const rotated = rowsOf(await db.execute(sql`update seo_mcp_tokens set used_at = now() where token_hash = ${h} and used_at is null returning 1`));
    if (!rotated.length) throw new OAuthError("invalid_grant", "Refresh token is no longer valid.");
    return issueTokens(t.grant_id, clientId, want, t.resource);
  }
  throw new OAuthError("unsupported_grant_type", "Use authorization_code or refresh_token.");
}

/** RFC 7009: always 200; a refresh token revokes its whole grant, an access token only itself. */
export async function revoke(p: Record<string, string | undefined>) {
  const db = await getDb();
  const [t] = rowsOf<{ grant_id: string; kind: string }>(await db.execute(sql`select grant_id, kind from seo_mcp_tokens where token_hash = ${sha256(p.token ?? "")}`));
  if (!t) return;
  if (t.kind === "refresh") await revokeGrant(t.grant_id);
  else await db.execute(sql`update seo_mcp_tokens set revoked_at = coalesce(revoked_at, now()) where token_hash = ${sha256(p.token ?? "")}`);
}

/** Settings → MCP access. */
export async function listGrants() {
  const db = await getDb();
  return rowsOf<{ id: string; client_name: string; client_id: string; scopes: string[] | string; created_at: string; last_used_at: string | null; revoked_at: string | null; email: string }>(
    await db.execute(sql`select g.id, c.client_name, g.client_id, g.scopes, g.created_at::text, g.last_used_at::text, g.revoked_at::text, u.email from seo_mcp_grants g join seo_mcp_clients c on c.client_id = g.client_id join "user" u on u.id = g.user_id order by g.revoked_at is not null, g.created_at desc limit 100`),
  ).map((g) => ({ ...g, scopes: pgArr(g.scopes) }));
}

export async function revokeGrantById(id: string) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new OAuthError("invalid_request", "Invalid grant id.");
  await revokeGrant(id);
}

function pgArr(v: string[] | string): string[] {
  return Array.isArray(v) ? v : String(v).replace(/^\{|\}$/g, "").split(",").filter(Boolean);
}

export const _internal = { pkceOk, token };
