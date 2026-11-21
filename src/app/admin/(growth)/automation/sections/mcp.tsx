import Link from "next/link";
import { Card } from "@/components/admin/ui";
import { AgentSettingsGroup } from "@/components/seo/AgentSettingsGroup";
import { buttonClass } from "@/components/ui/form";
import { loadAgentSettings } from "@/lib/seo-agent/settings-client";

/**
 * AI & SEO settings → MCP: the SEO agent's group "mcp" (the two servers' switches, limits and host names), and the
 * way to the connections page. Which tools exist, and that none approves, publishes or submits, is owned by the
 * agent's code and is not a setting.
 */
export default async function McpSection() {
  return (
    <>
      <Card className="mb-6">
        <h2 className="text-lg font-semibold text-fg">MCP</h2>
        <p className="mt-1 text-sm text-fg-muted">
          AI clients such as Claude can read the site&apos;s SEO data and start flows through the SEO agent&apos;s MCP servers. Which clients are connected, their scopes and how to connect one are on the MCP access page.
        </p>
        <p className="mt-3 text-sm text-fg-muted">No MCP tool can approve, publish, roll back or submit content, and the flows a client may start are fixed in the agent&apos;s code. The settings below cannot widen that.</p>
        <p className="mt-4">
          <Link href="/admin/automation/mcp" className={buttonClass("secondary")}>
            Open MCP access
          </Link>
        </p>
      </Card>
      <AgentSettingsGroup load={await loadAgentSettings()} groupId="mcp" title="MCP servers" />
    </>
  );
}
