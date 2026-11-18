import { getPublishedContent } from "@/lib/content";
import { buildNewsSitemap, newsSitemapEntries } from "@/lib/seo/news-sitemap";

// ISR with a short revalidate: articles age out of the 48-hour window within a minute, without a rebuild, and a
// publish clears it at once (lib/page-cache.ts). Google News crawlers get a cached response in between.
export const revalidate = 60;

export async function GET() {
  const now = new Date();
  const xml = buildNewsSitemap(newsSitemapEntries(await getPublishedContent({ now }), now));
  return new Response(xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=60, s-maxage=60",
    },
  });
}
