"use client";

import { usePathname, useSearchParams } from "next/navigation";
import Script from "next/script";
import { Suspense, useEffect, useRef, useState } from "react";
import { isTrackablePath } from "@/config/integrations";
import { cleanLocation, PageViewDeduper, track } from "@/lib/analytics";

type Gtag = (...args: unknown[]) => void;
const gtag: Gtag = (...args) => (globalThis as { gtag?: Gtag }).gtag?.(...args);

function PageViews() {
  const pathname = usePathname();
  const search = useSearchParams();
  const deduper = useRef(new PageViewDeduper());
  useEffect(() => {
    if (!isTrackablePath(pathname)) return;
    const location = cleanLocation(window.location.origin, pathname, search.toString());
    // Runs after the new page rendered, so document.title is the new page's title.
    if (deduper.current.shouldSend(location)) gtag("event", "page_view", { page_location: location, page_title: document.title });
  }, [pathname, search]);
  return null;
}

/**
 * GA4 with manual page views (send_page_view: false) so the first load and every client-side
 * navigation count exactly once. Turn off "Page changes based on browser history events" in the
 * GA4 stream's enhanced measurement, or those would be counted a second time.
 * Not loaded at all on private routes, or when the visitor arrives on one.
 */
export function GoogleAnalytics({ measurementId }: { measurementId: string }) {
  const pathname = usePathname();
  const [allowed] = useState(() => isTrackablePath(pathname));
  if (!allowed) return null;
  const config = JSON.stringify({ send_page_view: false, allow_google_signals: false });
  return (
    <>
      <Script id="ga4-src" src={`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`} strategy="afterInteractive" />
      <Script id="ga4-config" strategy="afterInteractive">
        {`gtag('js', new Date()); gtag('config', ${JSON.stringify(measurementId)}, ${config});`}
      </Script>
      <Suspense fallback={null}>
        <PageViews />
      </Suspense>
    </>
  );
}

/**
 * The AdSense tag (Auto ads + ad units), on public pages only. It also shows Google's consent message where required.
 * A plain async <script>, not next/script: React 19 hoists it into <head> of the server-rendered HTML, which is
 * where AdSense site verification and Auto ads expect it (next/script afterInteractive only injects it after
 * hydration, so crawlers never see it). Async, so it never blocks rendering; React de-duplicates it by src.
 */
export function AdSenseLoader({ client }: { client: string }) {
  const pathname = usePathname();
  if (!isTrackablePath(pathname)) return null;
  return (
    <script
      async
      src={`https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(client)}`}
      crossOrigin="anonymous"
    />
  );
}

/**
 * Google's Reader Revenue Manager init (the snippet from Publisher Center → Add code to your site), with the theme the
 * page is showing: an explicit choice (data-theme), else the system's. JSON in a <script>: "<" is escaped.
 */
export function readerRevenueInitScript(productId: string, lang: string): string {
  const options = JSON.stringify({ type: "NewsArticle", isPartOfType: ["Product"], isPartOfProductId: productId, clientOptions: { lang } }).replace(/</g, "\\u003c");
  return (
    `(self.SWG_BASIC=self.SWG_BASIC||[]).push(function(b){var o=${options},d=document.documentElement.dataset.theme;` +
    `o.clientOptions.theme=d==="dark"||(!d&&matchMedia("(prefers-color-scheme: dark)").matches)?"dark":"light";b.init(o);});`
  );
}

/**
 * Google Reader Revenue Manager (swg-basic.js): shows the CTAs set up in Publisher Center (rewarded ads, surveys,
 * contributions, newsletter sign-ups). Public pages only, and not at all when the visitor arrives on a private one.
 * Server-rendered like the AdSense tag, so Publisher Center finds the code in the raw HTML; the async src is hoisted
 * into <head> and never blocks rendering. The init only queues itself (SWG_BASIC), so the order does not matter.
 */
export function ReaderRevenue({ productId, lang }: { productId: string; lang: string }) {
  const pathname = usePathname();
  const [allowed] = useState(() => isTrackablePath(pathname));
  if (!allowed) return null;
  return (
    <>
      <script async src="https://news.google.com/swg/js/v1/swg-basic.js" />
      <script id="swg-basic-init" dangerouslySetInnerHTML={{ __html: readerRevenueInitScript(productId, lang) }} />
    </>
  );
}

/** Sends article_engaged once, when the end of the article body scrolls into view. */
export function ArticleEngagement({ collection, slug }: { collection: string; slug: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        track("article_engaged", { content_group: collection, article_slug: slug });
        io.disconnect();
      }
    });
    io.observe(el);
    return () => io.disconnect();
  }, [collection, slug]);
  return <span ref={ref} aria-hidden="true" />;
}
