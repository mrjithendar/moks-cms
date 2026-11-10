import { site } from "@/config/site";
import { getCategoryMap, labelOf } from "@/lib/categories";
import { getPublishedContent } from "@/lib/content";
import { buildRss, rssResponse } from "@/lib/seo/feed";

export const dynamic = "force-dynamic";

/** RSS for the news collection (/news/feed.xml), alongside the site feed and the per-category feeds. */
export async function GET() {
  const cats = await getCategoryMap();
  const news = (await getPublishedContent()).filter((a) => a.collection === "news");
  return rssResponse(buildRss({ title: `News | ${site.name}`, description: "News analysis for DevOps, cloud and AI engineers.", path: "/news", selfPath: "/news/feed.xml", articles: news, categoryLabel: (s) => labelOf(cats, s) }));
}
