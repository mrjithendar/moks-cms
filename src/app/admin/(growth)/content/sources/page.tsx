import { AdminHeader } from "@/components/admin/ui";
import { JobSettingsCard } from "@/components/news/JobSettingsCard";
import { SourcesManager, type SourceRow } from "@/components/news/SourcesManager";
import { credibilitySuggestions, getNewsSettings, listSources } from "@/lib/news/service";

export const metadata = { title: "Content sources" };

/** AI & SEO → Content sources: the feeds and APIs every crew job can write from (news or any other content), and how they are fetched. */
export default async function ContentSourcesPage() {
  const [sources, suggestions, settings] = await Promise.all([listSources(), credibilitySuggestions(), getNewsSettings()]);
  return (
    <>
      <AdminHeader title="Content sources" description="Feeds and official APIs content flows read, for news and for any other content. Fetched through the site's SSRF-safe fetcher, robots.txt honoured, paywalled hosts refused (docs/news/SOURCES.md)." />
      <SourcesManager sources={JSON.parse(JSON.stringify(sources)) as SourceRow[]} suggestions={suggestions as { id: string; name: string; current: number; suggested: number; basis: string }[]} />
      <JobSettingsCard group="fetching" initial={JSON.parse(JSON.stringify(settings))} />
    </>
  );
}
