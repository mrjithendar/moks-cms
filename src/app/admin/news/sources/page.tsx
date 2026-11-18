import { AdminHeader } from "@/components/admin/ui";
import { SourcesManager, type SourceRow } from "@/components/news/SourcesManager";
import { credibilitySuggestions, listSources } from "@/lib/news/service";

export const metadata = { title: "Sources" };

export default async function SourcesPage() {
  const [sources, suggestions] = await Promise.all([listSources(), credibilitySuggestions()]);
  return (
    <>
      <AdminHeader title="Sources" description="Feeds and official APIs the desk reads. Fetched through the site's SSRF-safe fetcher, robots.txt honoured, paywalled hosts refused (docs/news/SOURCES.md)." />
      <SourcesManager sources={JSON.parse(JSON.stringify(sources)) as SourceRow[]} suggestions={suggestions as { id: string; name: string; current: number; suggested: number; basis: string }[]} />
    </>
  );
}
