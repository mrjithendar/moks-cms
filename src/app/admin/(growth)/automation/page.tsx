import { redirect } from "next/navigation";
import { SettingsSections } from "@/components/admin/SettingsSections";
import { AdminHeader } from "@/components/admin/ui";
import { AI_SEO_SECTIONS, AI_SEO_SETTINGS_PATH, aliasTarget } from "./sections";

export const metadata = { title: "AI & SEO settings" };

/**
 * Admin → AI & SEO → Settings (called "Automation & AI" until 2026-11-21; the address is unchanged). One section at
 * a time, chosen with ?section=<id> (sections/index.ts), listed under four headings; a section loads its own data and
 * saves on its own. An id from before two sections were merged (llm-providers, llm-budget, mcp-access) is sent on to
 * the section that has it now.
 */
export default async function AiSeoSettingsPage({ searchParams }: { searchParams?: Promise<Record<string, string | undefined>> } = {}) {
  const query = (await searchParams) ?? {};
  const moved = aliasTarget(query);
  if (moved) redirect(moved);
  const current = AI_SEO_SECTIONS.find((s) => s.id === query.section) ?? AI_SEO_SECTIONS[0]!;
  const panel = await current.render(query);
  return (
    <>
      <AdminHeader
        title="AI & SEO settings"
        description="The SEO agent (its connections, limits and run history), the models it calls (LLM providers and the one budget, AI and drafts, ML and retrieval), the assistants that reach the site (Ask the Blog, MCP), then the SEO settings by area. Each section saves on its own; saved changes are audit-logged."
      />
      <SettingsSections sections={AI_SEO_SECTIONS.map(({ id, label, group }) => ({ id, label, group }))} current={current.id} basePath={AI_SEO_SETTINGS_PATH} label="AI & SEO settings sections">
        {panel}
      </SettingsSections>
    </>
  );
}
