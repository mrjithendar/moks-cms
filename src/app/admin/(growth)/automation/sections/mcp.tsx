import Link from "next/link";
import { Card } from "@/components/admin/ui";
import { buttonClass } from "@/components/ui/form";

/**
 * AI & SEO settings → MCP. A summary and the way to the connections page; the servers' own settings (on or off,
 * rate limits, per-tool switches) arrive with the ML and MCP work (plan P3), which extends this file.
 */
export default function McpSection() {
  return (
    <Card className="mb-6">
      <h2 className="text-lg font-semibold text-fg">MCP</h2>
      <p className="mt-1 text-sm text-fg-muted">
        AI clients such as Claude can read the site&apos;s SEO data and start flows through the SEO agent&apos;s MCP servers. Which clients are connected, their scopes and how to connect one are on the MCP access page.
      </p>
      <p className="mt-3 text-sm text-fg-muted">The servers are switched on and limited in the deployment today (ADMIN_MCP_ENABLED, PUBLIC_MCP_ENABLED and their rate limits). They are not editable here yet.</p>
      <p className="mt-4">
        <Link href="/admin/automation/mcp" className={buttonClass("secondary")}>
          Open MCP access
        </Link>
      </p>
    </Card>
  );
}
