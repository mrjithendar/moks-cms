import { draftNewArticle } from "@/lib/seo-agent/orchestrate";
import { json, SeoApiError, seoRoute, UUID } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/seo/calendar/{id}/draft — "Generate draft": the item's DRAFT post (never published; an outline post it
 * already has is reused). With SEO_ORCHESTRATOR=crewai the Editorial Crew then writes it (new_article_flow).
 */
export const POST = seoRoute<{ id: string }>("calendar-draft", { mutating: true, rate: { max: 10, windowSeconds: 600 } }, async (_req, ctx, { id }) => {
  if (!UUID.test(id)) throw new SeoApiError("Calendar item not found.", 404, "not_found");
  const r = await draftNewArticle(id, ctx.actor);
  await ctx.audit("calendar.draft", id, r);
  return json(r, 201);
});
