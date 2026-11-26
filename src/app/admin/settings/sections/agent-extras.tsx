import { SectionHeading, SeeAlso } from "@/components/admin/SettingsParts";
import { Card } from "@/components/admin/ui";
import { RepoSettingsForm } from "@/components/crewai/config/RepoSettingsForm";
import { JobSettingsCard } from "@/components/news/JobSettingsCard";
import { repoSummary } from "@/lib/crewai/bundle/repo";
import { getNewsSettings } from "@/lib/news/service";

/**
 * Settings → SEO agent → Configuration repository (the Settings tab of AI & SEO → Configuration until 2026-11-26):
 * the GitHub repository whose folder holds the CrewAI configuration, and its token.
 */
export async function CrewaiRepositorySection() {
  const summary = await repoSummary();
  return (
    <section aria-labelledby="crewai-repository-title" className="space-y-4">
      <SectionHeading
        id="crewai-repository-title"
        title="Configuration repository"
        description="The site repository whose folder holds the CrewAI configuration as files. The token stays on the server, sealed with SETTINGS_ENCRYPTION_KEY, and is never shown again; the deployment can give it instead as CREWAI_CONFIG_GITHUB_TOKEN from a Kubernetes Secret."
      />
      <Card>
        <RepoSettingsForm summary={summary} />
      </Card>
      <SeeAlso href="/admin/crewai/config">AI &amp; SEO → Configuration: what runs, drift, import and export, and history</SeeAlso>
    </section>
  );
}

/**
 * Settings → SEO agent → Content fetching (the last card of AI & SEO → Content sources until 2026-11-26): how the
 * content flows fetch their sources (the `news` settings group "fetching").
 */
export async function ContentFetchingSection() {
  const settings = await getNewsSettings();
  return (
    <section aria-labelledby="content-fetching-title" className="space-y-4">
      <SectionHeading
        id="content-fetching-title"
        title="Content fetching"
        description="How the content flows fetch their feeds and APIs: through the site's SSRF-safe fetcher, robots.txt honoured, paywalled hosts refused."
      />
      <JobSettingsCard group="fetching" initial={JSON.parse(JSON.stringify(settings))} />
      <SeeAlso href="/admin/content/sources">AI &amp; SEO → Content sources: the feeds and APIs themselves</SeeAlso>
    </section>
  );
}
