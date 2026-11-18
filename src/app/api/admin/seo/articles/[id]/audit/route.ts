import { articlePanel } from "@/lib/seo-intel/article-panel";
import { json, SeoApiError, seoRoute, UUID } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

/** GET /api/admin/seo/articles/{id}/audit — performance, queries, audit findings, links, recommendations, proposals. */
export const GET = seoRoute<{ id: string }>("article-audit", {}, async (_req, _ctx, { id }) => {
  if (!UUID.test(id)) throw new SeoApiError("Article not found.", 404, "not_found");
  const panel = await articlePanel(id);
  if (!panel) throw new SeoApiError("Article not found.", 404, "not_found");
  return json(panel);
});
