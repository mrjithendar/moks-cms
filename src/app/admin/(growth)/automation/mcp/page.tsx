import { redirect } from "next/navigation";
import { aiSeoSectionHref } from "../sections/paths";

export const dynamic = "force-dynamic";

/** MCP access was its own page until 2026-11-21; it is part of AI & SEO → Settings → MCP since 2026-11-23. */
export default function McpAccessPage() {
  redirect(aiSeoSectionHref("mcp", "mcp-clients-h"));
}
