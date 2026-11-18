import { auditSafe } from "@/lib/audit";
import { fail, guard, ok, preflight, readParams } from "@/lib/mcp-oauth/http";
import { exchange, OAuthError } from "@/lib/mcp-oauth/oauth";

export const dynamic = "force-dynamic";

/** POST /api/mcp-oauth/token — authorization_code (PKCE S256) and rotating refresh_token grants. */
export async function POST(req: Request): Promise<Response> {
  const blocked = await guard(req, "token", 60);
  if (blocked) return blocked;
  let p: Record<string, string | undefined> = {};
  try {
    p = (await readParams(req)) as Record<string, string | undefined>;
    const t = await exchange(p);
    if (p.grant_type === "authorization_code") await auditSafe({ id: null, label: `mcp:${p.client_id}` }, "seo.mcp.token_issued", p.client_id, { scope: t.scope });
    return ok(t);
  } catch (e) {
    if (e instanceof OAuthError) {
      if (e.error === "invalid_grant") await auditSafe({ id: null, label: `mcp:${p.client_id ?? "?"}` }, "seo.mcp.token_refused", p.client_id, { grant: p.grant_type, reason: e.message }, { severity: "warning" });
      return fail(e);
    }
    throw e;
  }
}
export const OPTIONS = preflight;
