import { json, SeoApiError, seoRoute, UUID } from "@/lib/seo-intel/http";
import { newsArticleForDraft, getJob } from "@/lib/news/service";

export const dynamic = "force-dynamic";

/** GET — the next publishing slots of the draft's job (HH:MM in the job's time zone) as absolute times, for "Schedule". */
export const GET = seoRoute<{ id: string }>("news-draft-slots", {}, async (_req, _ctx, p) => {
  if (!UUID.test(p.id)) throw new SeoApiError("Draft not found.", 404, "not_found");
  const a = await newsArticleForDraft(p.id);
  const job = a?.job_id ? await getJob(String(a.job_id)) : null;
  if (!job) return json({ slots: [] });
  const { nextRuns } = await import("@/lib/news/cron");
  const slots = job.config.publishing_slots.flatMap((hm) => {
    const [h, m] = hm.split(":");
    try {
      return nextRuns(`${Number(m)} ${Number(h)} * * *`, job.timezone, new Date(), 2, 3).map((d) => d.toISOString());
    } catch {
      return [];
    }
  });
  return json({ slots: [...new Set(slots)].sort().slice(0, 6), timezone: job.timezone });
});
