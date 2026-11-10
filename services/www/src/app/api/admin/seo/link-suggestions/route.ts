import { getDb } from "@/db";
import { json, parse, seoRoute } from "@/lib/seo-intel/http";
import { suggestInput, suggestLinks } from "@/lib/seo-intel/link-suggestions";
import { getSeoSettings } from "@/lib/seo-intel/settings";

export const dynamic = "force-dynamic";

/** POST /api/admin/seo/link-suggestions { postId, body } — link suggestions for the editor's current text (nothing saved). */
export const POST = seoRoute("link-suggestions", { mutating: true, rate: { max: 60, windowSeconds: 60 } }, async (_req, ctx) => {
  const input = parse(suggestInput, ctx.body);
  return json({ suggestions: await suggestLinks(await getDb(), await getSeoSettings(), input) });
});
