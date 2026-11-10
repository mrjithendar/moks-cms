import { guard, ok, preflight, readParams } from "@/lib/mcp-oauth/http";
import { revoke } from "@/lib/mcp-oauth/oauth";

export const dynamic = "force-dynamic";

/** POST /api/mcp-oauth/revoke — RFC 7009 token revocation (always 200). */
export async function POST(req: Request): Promise<Response> {
  const blocked = await guard(req, "revoke", 30);
  if (blocked) return blocked;
  const p = (await readParams(req).catch(() => ({}))) as Record<string, string | undefined>;
  await revoke(p);
  return ok({});
}
export const OPTIONS = preflight;
