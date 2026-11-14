import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Container } from "@/components/Container";
import { GUIDE_PRINT_CSS, GuideArticle, guideCrumbs } from "@/components/guide/GuideArticle";
import { GuideLayout, GuideSidebar } from "@/components/guide/GuideSidebar";
import { JsonLd } from "@/components/JsonLd";
import { site } from "@/config/site";
import { breadcrumbLd } from "@/lib/seo/jsonld";
import { shareImages } from "@/lib/seo/metadata";
import { getSiteConfig } from "@/lib/site-config";
import { GUIDE, GUIDE_PUBLIC_BASE, guideArticlePath, sameAdminPage } from "@/lib/user-guide";
import { settingsReference } from "@/lib/user-guide-settings";

// ISR like the manual's home page (../page.tsx): settings changes (the Public user manual switch) clear the page cache.
export const revalidate = 300;
// No paths at build time (the build has no database, and the switch is a setting): each page is rendered on its first
// request, then cached.
export async function generateStaticParams() {
  return [];
}

type Params = { params: Promise<{ id: string }> };

/** The entry, only while the manual is public. */
async function load(id: string) {
  const { config } = await getSiteConfig();
  return config.general.features.publicGuide ? GUIDE.find((e) => e.id === id) : undefined;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id } = await params;
  const entry = await load(id);
  if (!entry) return { title: "Not found", robots: { index: false } };
  const path = guideArticlePath(GUIDE_PUBLIC_BASE, entry.id);
  const title = `${entry.title} · User manual`;
  // An openGraph object here replaces the site's, image included: add the default share image back explicitly.
  const images = shareImages();
  return {
    title,
    description: entry.summary,
    alternates: { canonical: path },
    // Guides are indexed. A question is a sentence or two that the manual's home page already shows in full (with
    // FAQPage structured data), so its own page is for readers and links, not for the index.
    robots: entry.kind === "faq" ? { index: false, follow: true } : { index: true, follow: true },
    openGraph: { title, description: entry.summary, url: path, type: "article", siteName: site.name, locale: site.locale, images: images.og },
    twitter: { ...images.twitter, title, description: entry.summary },
  };
}

/**
 * One guide or question of the public user manual as its own page, with the contents tree beside it. Documentation and
 * defaults only, like the manual's home page; links to admin pages are shown as paths. Not found while Appearance &
 * settings → General → Public user manual is off, or for an id that is not an entry.
 */
export default async function PublicGuideArticlePage({ params }: Params) {
  const { id } = await params;
  const entry = await load(id);
  if (!entry) notFound();
  const settings = settingsReference().filter((g) => sameAdminPage(entry, g.href));
  return (
    <Container className="py-10 sm:py-14">
      <style>{GUIDE_PRINT_CSS}</style>
      <JsonLd data={breadcrumbLd(guideCrumbs(entry, GUIDE_PUBLIC_BASE))} />
      <GuideLayout sidebar={<GuideSidebar entries={GUIDE} base={GUIDE_PUBLIC_BASE} current={entry.id} />}>
        <GuideArticle entry={entry} entries={GUIDE} base={GUIDE_PUBLIC_BASE} linkToAdmin={false} settings={settings} />
      </GuideLayout>
    </Container>
  );
}
