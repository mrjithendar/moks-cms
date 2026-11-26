import type { Metadata } from "next";
import Link from "next/link";
import { SettingsDirectory } from "@/components/admin/SettingsDirectory";
import { AdminHeader, Card } from "@/components/admin/ui";
import { moduleState } from "@/lib/modules";
import { requireRole } from "@/lib/session";
import { settingsCategoryHref, settingsHref, visibleCategories } from "@/lib/settings-areas";
import { settingsReference } from "@/lib/user-guide-settings";

export const metadata: Metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

/**
 * Admin → Settings: every setting of the site in one place (owner, 2026-11-26), by category (lib/settings-areas.ts),
 * with a search. Until 2026-11-26 this address opened Appearance → General; General is the first category now and
 * links there.
 */
export default async function SettingsOverviewPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  await requireRole("admin");
  const [seoAgent, sp] = await Promise.all([moduleState("seo-agent").catch(() => null), searchParams]);
  const installed = Boolean(seoAgent?.installed);
  const categories = visibleCategories({ seoAgent: installed }).map((c) => ({
    id: c.id,
    label: c.label,
    description: c.description,
    href: settingsCategoryHref(c.id),
    sections: c.sections.map((s) => ({ ...s, href: settingsHref(s.id) })),
  }));
  return (
    <>
      <AdminHeader
        title="Settings"
        description="Every setting of the site, by category. Each section saves on its own and changes apply at once; the site's design and identity are edited in Appearance and go live when published."
      />
      {!installed && (
        <Card className="mb-6">
          <p className="text-sm text-fg-muted">
            The SEO agent is not set up, so its settings (LLM providers and budget, agent limits, Ask the Blog, MCP and the SEO areas) are not listed.{" "}
            <Link href={settingsHref("seo-agent")} className="link">
              Set up the SEO agent
            </Link>
          </p>
        </Card>
      )}
      <SettingsDirectory categories={categories} fields={fieldNames()} initialQuery={sp.q?.slice(0, 100) ?? ""} />
    </>
  );
}

/** The names of the fields in each section, from the user guide's settings reference, for the search. */
function fieldNames(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const g of settingsReference()) {
    const url = new URL(g.href, "http://x");
    const section = url.searchParams.get("section");
    // Appearance's groups link into the editor: General is Settings → General → Site identity, the rest Appearance.
    const id = url.pathname === "/admin/appearance" ? (section === "general" ? "site" : "appearance") : section;
    if (!id) continue;
    (out[id] ??= []).push(g.title, ...g.rows.map((r) => r.name));
  }
  return out;
}
