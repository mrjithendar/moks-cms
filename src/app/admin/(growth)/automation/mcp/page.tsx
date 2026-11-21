import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/** MCP access is a section of AI & SEO → Settings since 2026-11-21 (the sectioned layout of Settings → General). */
export default function McpAccessPage() {
  redirect("/admin/automation?section=mcp-access");
}
