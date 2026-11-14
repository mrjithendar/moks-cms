import { AdminHeader } from "@/components/admin/ui";
import { GuideBrowser } from "@/components/guide/GuideBrowser";
import { getSiteConfig } from "@/lib/site-config";
import { requireRole } from "@/lib/session";
import { guideFor } from "@/lib/user-guide";
import { settingsReference } from "@/lib/user-guide-settings";

export const metadata = { title: "User manual" };

/** Admin → User manual: how the CMS works, FAQ, diagrams and the settings reference, for admins, authors and demo accounts. */
export default async function GuidePage({ searchParams }: { searchParams: Promise<{ q?: string; area?: string; kind?: string }> }) {
  const user = await requireRole("admin", "author");
  // A demo account reads as an admin here (lib/demo.ts), so it gets the whole guide, like the admin it mirrors.
  const isAdmin = user.role === "admin";
  const [sp, { config }] = await Promise.all([searchParams, getSiteConfig()]);
  return (
    <>
      <AdminHeader
        title="User manual"
        description={`How Moks CMS works, page by page: guides with diagrams, answers to common questions, and every setting with its default. ${config.general.features.publicGuide ? "It is also public at /user-manual." : "Only signed-in staff can see it (an admin can publish it at /user-manual under Appearance & settings → General)."}`}
      />
      <GuideBrowser entries={guideFor(isAdmin)} settings={isAdmin ? settingsReference() : []} initial={sp} linkToAdmin />
    </>
  );
}
