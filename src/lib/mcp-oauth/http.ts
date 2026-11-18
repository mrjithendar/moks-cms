import { clientAddress } from "@/app/api/ask/route";
import { hit } from "../rate-limit";
import { readBodyTextOrNull } from "../read-body";
import { mcpEnabled } from "../seo-agent/endpoint";
import { OAuthError } from "./oauth";

/**
 * Shared bits of the OAuth endpoints: CORS (browser-based MCP clients such as MCP Inspector call them; they are public
 * PKCE clients and no cookies are involved), no-store caching, form or JSON bodies, per-IP rate limits, the
 * ADMIN_MCP_ENABLED kill switch, and RFC 6749 error bodies.
 */
export const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Protocol-Version", "Access-Control-Max-Age": "600" };
const HEADERS = { ...CORS, "Cache-Control": "no-store", Pragma: "no-cache", "X-Robots-Tag": "noindex", "X-Content-Type-Options": "nosniff" };

export const preflight = () => new Response(null, { status: 204, headers: CORS });
export const ok = (body: unknown, status = 200) => Response.json(body, { status, headers: HEADERS });
export const fail = (e: OAuthError) => Response.json(e.body(), { status: e.status, headers: HEADERS });

export async function readParams(req: Request): Promise<Record<string, string | undefined> | unknown> {
  const ct = req.headers.get("content-type") ?? "";
  const text = await readBodyTextOrNull(req, 20_000);
  if (text === null) throw new OAuthError("invalid_request", "Request too large.");
  if (ct.includes("application/json")) {
    try {
      return JSON.parse(text);
    } catch {
      throw new OAuthError("invalid_request", "Invalid JSON.");
    }
  }
  return Object.fromEntries(new URLSearchParams(text));
}

/** Kill switch + per-IP limit. Returns an error response, or null to continue. */
export async function guard(req: Request, name: string, max: number): Promise<Response | null> {
  if (!(await mcpEnabled("admin"))) return Response.json({ error: "temporarily_unavailable", error_description: "The admin MCP server is switched off (ADMIN_MCP_ENABLED, or the SEO agent is disabled)." }, { status: 404, headers: HEADERS });
  const ip = clientAddress(req.headers) ?? "unknown";
  if (!(await hit(`mcp-oauth:${name}:${ip}`, max, 600))) return Response.json({ error: "slow_down", error_description: "Too many requests; try again in a few minutes." }, { status: 429, headers: { ...HEADERS, "Retry-After": "600" } });
  return null;
}
