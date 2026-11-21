import { SettingsSections } from "@/components/admin/SettingsSections";
import { AdminHeader } from "@/components/admin/ui";
import { AI_SEO_SECTIONS, AI_SEO_SETTINGS_PATH } from "./sections";

export const metadata = { title: "AI & SEO settings" };

/**
 * Admin → AI & SEO → Settings (called "Automation & AI" until 2026-11-21; the address is unchanged). One section at
 * a time, chosen with ?section=<id> (sections/index.ts); a section loads its own data and saves on its own.
 */
export default async function AiSeoSettingsPage({ searchParams }: { searchParams?: Promise<Record<string, string | undefined>> } = {}) {
  const query = (await searchParams) ?? {};
  const section = query.section;
  const current = AI_SEO_SECTIONS.find((s) => s.id === section) ?? AI_SEO_SECTIONS[0]!;
  const panel = await current.render(query);
  return (
    <>
      <AdminHeader title="AI & SEO settings" description="The SEO agent and its connections, LLM providers and budget, agent limits, Ask the Blog, ML and retrieval, MCP, then the SEO settings by area: data sources, schedules (UTC), scoring, content and links, AI and drafts, crawler, reports and run history. Each section saves on its own; saved changes are audit-logged." />
      <SettingsSections sections={AI_SEO_SECTIONS.map(({ id, label }) => ({ id, label }))} current={current.id} basePath={AI_SEO_SETTINGS_PATH} label="AI & SEO settings sections">
        {panel}
      </SettingsSections>
    </>
  );
}
