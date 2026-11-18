import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { GUIDE_PRINT_CSS, GuideArticle } from "@/components/guide/GuideArticle";
import { GuideLayout, GuideSidebar } from "@/components/guide/GuideSidebar";
import { requireRole } from "@/lib/session";
import { GUIDE, GUIDE_ADMIN_BASE, guideFor, sameAdminPage } from "@/lib/user-guide";
import { settingsReference } from "@/lib/user-guide-settings";

type Params = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id } = await params;
  const entry = GUIDE.find((e) => e.id === id);
  return { title: entry ? `${entry.title} · User manual` : "User manual" };
}

/**
 * One guide or question of the manual as its own page (Admin → User manual → an entry), with the contents tree beside
 * it. Authors get only the entries about pages they can open; an entry they may not read is "not found", like one that
 * does not exist. The settings tables of the page an entry describes are shown to admins only, as on the home page.
 */
export default async function GuideArticlePage({ params }: Params) {
  const user = await requireRole("admin", "author");
  // A demo account reads as an admin here (lib/demo.ts), as on the manual's home page.
  const isAdmin = user.role === "admin";
  const { id } = await params;
  const entries = guideFor(isAdmin);
  const entry = entries.find((e) => e.id === id);
  if (!entry) notFound();
  const settings = isAdmin ? settingsReference().filter((g) => sameAdminPage(entry, g.href)) : [];
  return (
    <>
      <style>{GUIDE_PRINT_CSS}</style>
      <GuideLayout sidebar={<GuideSidebar entries={entries} base={GUIDE_ADMIN_BASE} current={entry.id} />}>
        <GuideArticle entry={entry} entries={entries} base={GUIDE_ADMIN_BASE} linkToAdmin settings={settings} />
      </GuideLayout>
    </>
  );
}
