import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Container } from "@/components/Container";
import Link from "next/link";
import { GuideBrowser } from "@/components/guide/GuideBrowser";
import { GuideLayout, GuideSidebar } from "@/components/guide/GuideSidebar";
import { JsonLd } from "@/components/JsonLd";
import { absoluteUrl, site } from "@/config/site";
import { shareImages } from "@/lib/seo/metadata";
import { getSiteConfig } from "@/lib/site-config";
import { GUIDE, GUIDE_PUBLIC_BASE } from "@/lib/user-guide";
import { settingsReference } from "@/lib/user-guide-settings";

// ISR like the other public pages; settings changes (the switch below) clear the page cache on every replica. The
// page reads no query string on the server (the browser applies ?q=&area=&kind=), so every crawler and visitor gets
// the same cached, canonical HTML with the whole manual in it.
export const revalidate = 300;

const TITLE = "User manual";
const DESCRIPTION = "How the Moks CMS behind this site works: guides with diagrams, frequently asked questions and every setting explained.";

export async function generateMetadata(): Promise<Metadata> {
  const { config } = await getSiteConfig();
  if (!config.general.features.publicGuide) return { title: "Not found", robots: { index: false } };
  // An openGraph object here replaces the site's, image included: add the default share image back explicitly.
  const images = shareImages();
  return {
    title: TITLE,
    description: DESCRIPTION,
    alternates: { canonical: "/user-manual" },
    robots: { index: true, follow: true },
    openGraph: { title: TITLE, description: DESCRIPTION, url: "/user-manual", type: "article", siteName: site.name, locale: site.locale, images: images.og },
    twitter: { ...images.twitter, title: TITLE, description: DESCRIPTION },
  };
}

/**
 * The public user manual's home, shown (and listed in the sitemap, crawlable and indexable) only while Appearance &
 * settings → General → Public user manual is on: the contents tree, search, every guide by category, the FAQ and the
 * settings reference. The same content as Admin → User manual: documentation and defaults only, never this site's data
 * or saved values. Each guide and question has its own page ([id]/page.tsx); print/page.tsx is the whole manual on one
 * page. Off: not found.
 */
export default async function PublicUserManualPage() {
  const { config } = await getSiteConfig();
  if (!config.general.features.publicGuide) notFound();
  const faqs = GUIDE.filter((e) => e.kind === "faq");
  const ld = {
    "@context": "https://schema.org" as const,
    "@type": "FAQPage",
    name: `${TITLE}: frequently asked questions`,
    url: absoluteUrl("/user-manual"),
    mainEntity: faqs.map((e) => ({ "@type": "Question", name: e.title, acceptedAnswer: { "@type": "Answer", text: e.body.join(" ") } })),
  };
  return (
    <Container className="py-10 sm:py-14">
      <JsonLd data={ld} />
      <header className="max-w-3xl">
        <h1 className="text-3xl font-semibold tracking-tight text-fg">{TITLE}</h1>
        <p className="mt-3 text-base text-fg-muted">{DESCRIPTION}</p>
        <p className="mt-3 text-sm">
          <Link href={`${GUIDE_PUBLIC_BASE}/print`} className="link font-medium">Printable manual</Link>
        </p>
      </header>
      <div className="mt-8">
        <GuideLayout sidebar={<GuideSidebar entries={GUIDE} base={GUIDE_PUBLIC_BASE} />}>
          <GuideBrowser entries={GUIDE} settings={settingsReference()} initial={{}} base={GUIDE_PUBLIC_BASE} readUrlOnMount linkToAdmin={false} />
        </GuideLayout>
      </div>
    </Container>
  );
}
