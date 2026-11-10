import { CORS, preflight } from "@/lib/mcp-oauth/http";
import { protectedResourceMetadata } from "@/lib/mcp-oauth/oauth";

export const dynamic = "force-dynamic";

/**
 * RFC 9728 protected resource metadata for https://jithendar.com/mcp/admin. The MCP server (seo-agent, behind Kong at
 * /mcp/admin) answers 401 with WWW-Authenticate resource_metadata pointing here; this path is served by the site.
 */
export const GET = () => Response.json(protectedResourceMetadata(), { headers: { ...CORS, "Cache-Control": "public, max-age=300" } });
export const OPTIONS = preflight;
