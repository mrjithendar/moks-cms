import { getDb } from "@/db";
import { json, parse, SeoApiError, seoRoute } from "@/lib/seo-intel/http";
import { applyInput, applySuggestion, SuggestionError } from "@/lib/seo-intel/link-suggestions";
import { getSeoSettings } from "@/lib/seo-intel/settings";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/seo/link-suggestions/apply { postId, body, change } — insert one suggested link into the editor's
 * text (validated server-side) and return the new body. Nothing is saved; the author saves in the editor as usual.
 */
export const POST = seoRoute("link-suggestions-apply", { mutating: true, rate: { max: 60, windowSeconds: 60 } }, async (_req, ctx) => {
  try {
    return json({ body: await applySuggestion(await getDb(), await getSeoSettings(), parse(applyInput, ctx.body)) });
  } catch (e) {
    if (e instanceof SuggestionError) throw new SeoApiError(e.message, e.status, "invalid");
    throw e;
  }
});
