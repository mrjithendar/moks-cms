import { z } from "zod";
import { getDb } from "@/db";
import { fixBrokenLink } from "@/lib/seo-intel/broken-links";
import { DraftError } from "@/lib/seo-intel/drafts";
import { json, parse, SeoApiError, seoRoute } from "@/lib/seo-intel/http";
import { getSeoSettings } from "@/lib/seo-intel/settings";

export const dynamic = "force-dynamic";

const body = z.object({ postId: z.string().uuid(), url: z.string().min(1).max(2000), replacement: z.union([z.string().trim().min(1).max(500), z.null()]) });

/**
 * POST /api/admin/seo/broken-links/fix { postId, url, replacement | null } — re-point or unlink a broken link in one
 * published post. The clicking admin approves the link_fix draft at once (publish → verify → rollback as usual).
 */
export const POST = seoRoute("broken-links-fix", { mutating: true, rate: { max: 30, windowSeconds: 600 } }, async (_req, ctx) => {
  const b = parse(body, ctx.body);
  try {
    const r = await fixBrokenLink(await getDb(), await getSeoSettings(), ctx.actor, b.postId, b.url, b.replacement);
    await ctx.audit("links.fix", b.postId, { url: b.url, replacement: b.replacement, draftId: r.draftId });
    return json(r);
  } catch (e) {
    if (e instanceof DraftError) throw new SeoApiError(e.message, e.status, "invalid");
    throw e;
  }
});
