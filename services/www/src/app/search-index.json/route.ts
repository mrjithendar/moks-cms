import { getCategoryMap, labelOf } from "@/lib/categories";
import { getPublishedContent } from "@/lib/content";
import { buildSearchIndex } from "@/lib/seo/search-index";

// ISR (lib/page-cache.ts): rendered once, served from the page cache, re-rendered after 300 s (PAGE_REVALIDATE_SECONDS)
// and cleared on every replica when content or settings change.
export const revalidate = 300;

export async function GET() {
  const cats = await getCategoryMap();
  return Response.json(buildSearchIndex(await getPublishedContent(), (s) => labelOf(cats, s)), {
    headers: { "Cache-Control": "public, max-age=300", "X-Robots-Tag": "noindex" },
  });
}
