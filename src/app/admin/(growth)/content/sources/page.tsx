import { AdminHeader } from "@/components/admin/ui";
import { SettingsElsewhere } from "@/components/admin/SettingsParts";
import { SourcesManager, type SourceRow } from "@/components/news/SourcesManager";
import { credibilitySuggestions, listSources } from "@/lib/news/service";
import { settingsHref } from "@/lib/settings-areas";

export const metadata = { title: "Content sources" };

/** AI & SEO → Content sources: the feeds and APIs every crew job can write from (news or any other content). How they are fetched is in Settings → SEO agent → Content fetching. */
export default async function ContentSourcesPage() {
  const [sources, suggestions] = await Promise.all([listSources(), credibilitySuggestions()]);
  return (
    <>
      <AdminHeader title="Content sources" description="Feeds and official APIs content flows read, for news and for any other content. Fetched through the site's SSRF-safe fetcher, robots.txt honoured, paywalled hosts refused (docs/news/SOURCES.md)." />
      <SourcesManager sources={JSON.parse(JSON.stringify(sources)) as SourceRow[]} suggestions={suggestions as { id: string; name: string; current: number; suggested: number; basis: string }[]} />
      <SettingsElsewhere href={settingsHref("content-fetching")}>how the sources are fetched (timeouts, limits, intervals) is in Settings → SEO agent → Content fetching.</SettingsElsewhere>
    </>
  );
}
