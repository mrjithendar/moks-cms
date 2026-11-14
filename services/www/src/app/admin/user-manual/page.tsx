import Link from "next/link";
import { AdminHeader } from "@/components/admin/ui";
import { GuideBrowser } from "@/components/guide/GuideBrowser";
import { GuideLayout, GuideSidebar } from "@/components/guide/GuideSidebar";
import { getSiteConfig } from "@/lib/site-config";
import { requireRole } from "@/lib/session";
import { GUIDE_ADMIN_BASE, guideFor } from "@/lib/user-guide";
import { settingsReference } from "@/lib/user-guide-settings";

export const metadata = { title: "User manual" };

/**
 * Admin → User manual, the manual's home: the contents tree, search, every guide by category, the FAQ and the settings
 * reference, for admins, authors and demo accounts. Each guide and question has its own page under this one
 * ([id]/page.tsx); print/page.tsx is the whole manual on one page.
 */
export default async function GuidePage({ searchParams }: { searchParams: Promise<{ q?: string; area?: string; kind?: string }> }) {
  const user = await requireRole("admin", "author");
  // A demo account reads as an admin here (lib/demo.ts), so it gets the whole guide, like the admin it mirrors.
  const isAdmin = user.role === "admin";
  const [sp, { config }] = await Promise.all([searchParams, getSiteConfig()]);
  const entries = guideFor(isAdmin);
  return (
    <>
      <AdminHeader
        title="User manual"
        description={`How Moks CMS works, page by page: guides with diagrams, answers to common questions, and every setting with its default. ${config.general.features.publicGuide ? "It is also public at /user-manual." : "Only signed-in staff can see it (an admin can publish it at /user-manual under Appearance & settings → General)."}`}
        actions={<Link href={`${GUIDE_ADMIN_BASE}/print`} className="min-h-9 rounded-md border border-line-strong px-3 py-2 text-sm">Printable manual</Link>}
      />
      <GuideLayout sidebar={<GuideSidebar entries={entries} base={GUIDE_ADMIN_BASE} />}>
        <GuideBrowser entries={entries} settings={isAdmin ? settingsReference() : []} initial={sp} base={GUIDE_ADMIN_BASE} linkToAdmin />
      </GuideLayout>
    </>
  );
}
