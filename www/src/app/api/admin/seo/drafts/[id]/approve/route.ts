import { z } from "zod";
import { json, parse, SeoApiError, seoRoute, UUID } from "@/lib/seo-intel/http";
import { approveDraft } from "@/lib/seo-intel/publish";

export const dynamic = "force-dynamic";

const body = z.object({ publishAt: z.string().datetime({ offset: true }).nullable().optional() });

/**
 * POST /api/admin/seo/drafts/{id}/approve — approve ONE draft: publish now, or schedule with publishAt.
 * There is intentionally no bulk-approve endpoint.
 */
export const POST = seoRoute<{ id: string }>("drafts-approve", { mutating: true, rate: { max: 20, windowSeconds: 600 } }, async (_req, ctx, { id }) => {
  if (!UUID.test(id)) throw new SeoApiError("Draft not found.", 404, "not_found");
  const b = parse(body, ctx.body ?? {});
  return json(await approveDraft(id, ctx.actor, { publishAt: b.publishAt ?? null }));
});
