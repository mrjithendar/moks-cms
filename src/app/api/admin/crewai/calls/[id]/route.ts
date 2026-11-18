import { transcript } from "@/lib/crewai/runs";
import { json, SeoApiError, seoRoute } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/crewai/calls/{id} — one model call of a run: the system prompt, prompt and answer, with tokens, cost
 * and time. Kept while Run history → transcripts is on, for the transcript retention period (default 14 days).
 */
export const GET = seoRoute<{ id: string }>("crewai-call", { rate: { max: 120, windowSeconds: 60 } }, async (_req, _ctx, p) => {
  const t = /^\d{1,15}$/.test(p.id) ? await transcript(Number(p.id)) : null;
  if (!t) throw new SeoApiError("This transcript is not kept (transcripts were off, or it is past the retention period).", 404, "not_found");
  return json({ call: t });
});
