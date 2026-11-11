import { site } from "@/config/site";
import { getCategoryMap, labelOf } from "@/lib/categories";
import { getPublishedContent } from "@/lib/content";
import { buildRss, rssResponse } from "@/lib/seo/feed";

// ISR (lib/page-cache.ts): rendered once, served from the page cache, re-rendered after 300 s (PAGE_REVALIDATE_SECONDS)
// and cleared on every replica when content or settings change.
export const revalidate = 300;

export async function GET() {
  const cats = await getCategoryMap();
  return rssResponse(
    buildRss({ title: site.name, description: site.description, path: "/", selfPath: "/feed.xml", articles: await getPublishedContent(), categoryLabel: (s) => labelOf(cats, s) }),
  );
}
