import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Container } from "@/components/Container";
import { GUIDE_PRINT_CSS, GuidePrint } from "@/components/guide/GuideArticle";
import { getSiteConfig } from "@/lib/site-config";
import { GUIDE, GUIDE_PUBLIC_BASE } from "@/lib/user-guide";
import { settingsReference } from "@/lib/user-guide-settings";

// ISR like the manual's home page (../page.tsx).
export const revalidate = 300;

export async function generateMetadata(): Promise<Metadata> {
  const { config } = await getSiteConfig();
  if (!config.general.features.publicGuide) return { title: "Not found", robots: { index: false } };
  // The same text as the manual's pages, on one sheet: readers print it, search engines index the pages instead.
  return { title: "User manual (printable)", alternates: { canonical: GUIDE_PUBLIC_BASE }, robots: { index: false, follow: true } };
}

/** The whole public user manual on one page, to print or save as a PDF. Not found while the manual is not public. */
export default async function PublicGuidePrintPage() {
  const { config } = await getSiteConfig();
  if (!config.general.features.publicGuide) notFound();
  return (
    <Container className="py-10 sm:py-14">
      <style>{GUIDE_PRINT_CSS}</style>
      <GuidePrint entries={GUIDE} settings={settingsReference()} base={GUIDE_PUBLIC_BASE} linkToAdmin={false} siteName={config.general.siteName} />
    </Container>
  );
}
