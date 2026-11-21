import { AdminHeader } from "@/components/admin/ui";
import { NewsSettingsForm } from "@/components/news/NewsSettingsForm";
import { getNewsSettings } from "@/lib/news/service";
import { newsDeskState, newsDeskStateText } from "@/lib/news/schema";

export const metadata = { title: "Settings" };

export default async function NewsSettingsPage() {
  const s = await getNewsSettings();
  return (
    <>
      <AdminHeader title="News desk settings" description="Global caps apply on top of each job's own budget. Defaults keep spend small (docs/news/COSTS.md)." />
      <NewsSettingsForm initial={JSON.parse(JSON.stringify(s))} desk={{ ...newsDeskState(s), text: newsDeskStateText(newsDeskState(s)) }} envProvider={process.env.NEWS_IMAGE_PROVIDER ?? null} />
    </>
  );
}
