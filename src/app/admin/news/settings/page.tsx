import { AdminHeader } from "@/components/admin/ui";
import { NewsAgentCard } from "@/components/news/NewsAgentCard";
import { NewsSettingsForm } from "@/components/news/NewsSettingsForm";
import { newsAgentStatus } from "@/lib/news-agent/endpoint";
import { getNewsSettings } from "@/lib/news/service";
import { newsDeskState, newsDeskStateText } from "@/lib/news/schema";

export const metadata = { title: "Settings" };

export default async function NewsSettingsPage() {
  const [s, agent] = await Promise.all([getNewsSettings(), newsAgentStatus()]);
  return (
    <>
      <AdminHeader title="News desk settings" description="Global caps apply on top of each job's own budget. Defaults keep spend small (the news agent's docs/COSTS.md)." />
      <NewsAgentCard initial={JSON.parse(JSON.stringify(agent))} />
      <NewsSettingsForm initial={JSON.parse(JSON.stringify(s))} desk={{ ...newsDeskState(s), text: newsDeskStateText(newsDeskState(s)) }} envProvider={process.env.NEWS_IMAGE_PROVIDER ?? null} />
    </>
  );
}
