import { GUIDE_PRINT_CSS, GuidePrint } from "@/components/guide/GuideArticle";
import { getSiteConfig } from "@/lib/site-config";
import { requireRole } from "@/lib/session";
import { GUIDE_ADMIN_BASE, guideFor } from "@/lib/user-guide";
import { settingsReference } from "@/lib/user-guide-settings";

export const metadata = { title: "User manual (printable)" };

/**
 * The whole manual on one page, to print or save as a PDF (Admin → User manual → Printable manual). The same content
 * the reader may see online: authors get the entries about their pages and no settings reference.
 */
export default async function GuidePrintPage() {
  const user = await requireRole("admin", "author");
  const isAdmin = user.role === "admin";
  const { config } = await getSiteConfig();
  return (
    <>
      <style>{GUIDE_PRINT_CSS}</style>
      <GuidePrint entries={guideFor(isAdmin)} settings={isAdmin ? settingsReference() : []} base={GUIDE_ADMIN_BASE} linkToAdmin siteName={config.general.siteName} />
    </>
  );
}
