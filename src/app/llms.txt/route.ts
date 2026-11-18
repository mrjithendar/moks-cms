import { getCategoryMap, labelOf } from "@/lib/categories";
import { getPublishedContent } from "@/lib/content";
import { publicMcpEnabled } from "@/lib/seo-agent/config";
import { buildLlmsTxt } from "@/lib/seo/llms";

// ISR (lib/page-cache.ts): rendered once, served from the page cache, re-rendered after 300 s (PAGE_REVALIDATE_SECONDS)
// and cleared on every replica when content or settings change.
export const revalidate = 300;

export async function GET() {
  const cats = await getCategoryMap();
  const body = buildLlmsTxt({ articles: await getPublishedContent(), categoryLabel: (s) => labelOf(cats, s), mcpEnabled: publicMcpEnabled() });
  return new Response(body, { headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
}
