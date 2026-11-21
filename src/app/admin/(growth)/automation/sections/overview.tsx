import { IntegrationStatusCard, loadConnections } from "@/components/seo/IntegrationStatus";
import { SeoAgentCard } from "@/components/seo/SeoAgentCard";
import { agentStatus } from "@/lib/seo-agent/endpoint";

/** AI & SEO settings → Overview: what is connected, and the SEO agent (on or off, where it is, its endpoint). */
export default async function OverviewSection() {
  const [connections, agent] = await Promise.all([loadConnections(), agentStatus()]);
  return (
    <>
      <IntegrationStatusCard rows={connections} />
      <SeoAgentCard initial={agent} />
    </>
  );
}
