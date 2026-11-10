import { fail, guard, ok, preflight, readParams } from "@/lib/mcp-oauth/http";
import { OAuthError, register } from "@/lib/mcp-oauth/oauth";

export const dynamic = "force-dynamic";

/** POST /api/mcp-oauth/register — RFC 7591 dynamic client registration (public PKCE clients only). */
export async function POST(req: Request): Promise<Response> {
  const blocked = await guard(req, "register", 10);
  if (blocked) return blocked;
  try {
    return ok(await register(await readParams(req)), 201);
  } catch (e) {
    if (e instanceof OAuthError) return fail(e);
    throw e;
  }
}
export const OPTIONS = preflight;
