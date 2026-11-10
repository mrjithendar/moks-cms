import { CORS, preflight } from "@/lib/mcp-oauth/http";
import { metadata } from "@/lib/mcp-oauth/oauth";

export const dynamic = "force-dynamic";

/** RFC 8414 authorization server metadata for the admin MCP (MCP authorization spec). */
export const GET = () => Response.json(metadata(), { headers: { ...CORS, "Cache-Control": "public, max-age=300" } });
export const OPTIONS = preflight;
