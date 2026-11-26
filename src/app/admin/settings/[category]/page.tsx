import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { Flash } from "@/components/admin/Flash";
import { SettingsHub, type HubCategory } from "@/components/admin/SettingsHub";
import { AdminHeader, Card } from "@/components/admin/ui";
import { buttonClass } from "@/components/ui/form";
import { moduleState } from "@/lib/modules";
import { requireRole } from "@/lib/session";
import { sectionsOf, sectionVisible, settingsCategory, settingsCategoryHref, settingsHref, settingsSection, SETTINGS_PATH, visibleCategories, type SettingsCategory, type SettingsSectionDef } from "@/lib/settings-areas";
import { SECTION_RENDERS } from "../sections";

export const dynamic = "force-dynamic";

type Params = Promise<{ category: string }>;
type Query = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const c = settingsCategory((await params).category);
  return { title: c ? `${c.label} settings` : "Settings" };
}

/**
 * Admin → Settings → <category> (lib/settings-areas.ts): the category's sections listed beside the form (a select and
 * buttons on narrow screens), one section at a time at `?section=<id>`, each its own server render that loads its own
 * data and saves on its own (app/admin/settings/sections). Admins only, as every settings page was.
 *
 * The SEO agent's sections are listed only while the agent is set up (lib/modules.ts); opened by address while it is
 * not, they say how to set it up. A section opened under the wrong category is sent to its own address.
 */
export default async function SettingsCategoryPage({ params, searchParams }: { params: Params; searchParams: Query }) {
  await requireRole("admin");
  const [{ category: id }, raw] = await Promise.all([params, searchParams]);
  const category = settingsCategory(id);
  if (!category) notFound();
  const query: Record<string, string | undefined> = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));

  const seoAgent = await moduleState("seo-agent").catch(() => null);
  const visibility = { seoAgent: Boolean(seoAgent?.installed) };

  const asked = query.section ? settingsSection(query.section) : undefined;
  if (asked && asked.category !== category.id) redirect(settingsHref(asked.id));

  const listed = await listedSections(category, visibility);
  const current: SettingsSectionDef | undefined = asked ?? listed[0];
  const categories: HubCategory[] = visibleCategories(visibility).map((c) => {
    const sections = c.id === category.id ? listed : c.sections;
    return { id: c.id, label: c.label, href: settingsCategoryHref(c.id), sections: sections.map((s) => ({ id: s.id, label: s.label, href: settingsHref(s.id) })) };
  });
  // A category whose every section belongs to a module that is not set up is not in the list; opened by address, it
  // is still shown (with the notice) so the person learns why.
  if (!categories.some((c) => c.id === category.id)) categories.push({ id: category.id, label: category.label, href: settingsCategoryHref(category.id), sections: [] });

  let panel: ReactNode;
  if (!current || !sectionVisible(current, visibility)) panel = <AgentNotSetUp reason={seoAgent?.reason} />;
  else {
    const impl = SECTION_RENDERS[current.id];
    if (!impl) throw new Error(`Settings section ${current.id} has nothing to draw`);
    panel = await impl.render(query);
  }

  return (
    <>
      <AdminHeader title={category.label} description={category.description} breadcrumbs={[{ href: SETTINGS_PATH, label: "Settings" }]} />
      <SettingsHub categories={categories} category={category.id} section={current?.id ?? ""}>
        <Flash ok={query.ok} error={query.error} />
        {panel}
      </SettingsHub>
    </>
  );
}

/** The category's visible sections that have something to do now (SectionImpl.available). */
async function listedSections(category: SettingsCategory, visibility: { seoAgent: boolean }): Promise<SettingsSectionDef[]> {
  const sections = sectionsOf(category.id, visibility);
  const ok = await Promise.all(sections.map((s) => SECTION_RENDERS[s.id]?.available?.().catch(() => true) ?? true));
  return sections.filter((_, i) => ok[i]);
}

function AgentNotSetUp({ reason }: { reason?: string }) {
  return (
    <Card>
      <h2 className="text-lg font-semibold text-fg">The SEO agent is not set up</h2>
      <div className="mt-2 space-y-3 text-sm text-fg-muted">
        {reason && <p>{reason}</p>}
        <p>These settings belong to the SEO agent, an optional module of the admin. They are listed here once it is set up; everything else in Settings works without it.</p>
        <Link href={settingsHref("seo-agent")} className={buttonClass("primary", "sm")}>
          Set up the SEO agent
        </Link>
      </div>
    </Card>
  );
}
