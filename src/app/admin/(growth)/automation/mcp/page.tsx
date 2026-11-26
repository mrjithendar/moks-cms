import { redirect } from "next/navigation";
import { settingsHref } from "@/lib/settings-areas";

export const dynamic = "force-dynamic";

/** MCP access was its own page until 2026-11-21, then part of AI & SEO → Settings → MCP; it is Settings → Assistants → MCP now. */
export default function McpAccessPage() {
  redirect(settingsHref("mcp", "mcp-clients-h"));
}
