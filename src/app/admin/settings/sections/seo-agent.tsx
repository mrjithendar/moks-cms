import { SectionHeading } from "@/components/admin/SettingsParts";
import { IntegrationStatusCard, loadConnections } from "@/components/seo/IntegrationStatus";
import { SeoAgentCard } from "@/components/seo/SeoAgentCard";
import { moduleState } from "@/lib/modules";
import { agentStatus } from "@/lib/seo-agent/endpoint";

/**
 * Settings → SEO agent → Connection: where the SEO agent is and whether it answers, then what the site is connected to.
 * One section since 2026-11-26: the agent's endpoint card was drawn twice before (Settings → Integrations → SEO agent,
 * and AI & SEO → Settings → Overview with the connections). This section is shown whether or not the agent is set up,
 * because it is where it is set up (lib/modules.ts SEO_AGENT_SETUP).
 */
export default async function SeoAgentSection() {
  const [agent, mod, connections] = await Promise.all([agentStatus(), moduleState("seo-agent"), loadConnections()]);
  return (
    <section aria-labelledby="seo-agent-title" className="space-y-4">
      <SectionHeading
        id="seo-agent-title"
        title="SEO agent"
        description={
          <>
            The SEO agent (seo-agent, part of the moks-cms image) runs the crews and flows.{" "}
            {mod.installed ? (
              <>
                It is set up, so <strong>AI &amp; SEO</strong> is in the menu and its settings are listed here{mod.available ? "" : " (it does not answer right now: its pages say so)"}.
              </>
            ) : (
              <>
                It is not set up, so <strong>AI &amp; SEO</strong> and its settings are hidden. Save its address below, or deploy it as a Service named <code>seo-agent</code> next to this site,
                and they appear within a minute.
              </>
            )}
          </>
        }
      />
      <SeoAgentCard initial={agent} />
      <IntegrationStatusCard rows={connections} />
    </section>
  );
}
