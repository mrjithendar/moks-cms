import { z } from "zod";
import { json, parse, SeoApiError, seoRoute, UUID } from "@/lib/seo-intel/http";
import { runJob } from "@/lib/news/agent";
import { cloneJob, rollbackJob, setJobEnabled } from "@/lib/news/service";

export const dynamic = "force-dynamic";
const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("run") }),
  z.object({ action: z.literal("dry_run"), llm: z.boolean().default(true) }),
  z.object({ action: z.enum(["pause", "resume", "clone"]) }),
  z.object({ action: z.literal("rollback"), version: z.number().int().min(1) }),
]);

/** POST /api/admin/news/jobs/{id}/actions — run now, dry run, pause/resume, clone, roll back to a version. */
export const POST = seoRoute<{ id: string }>("news-job-action", { mutating: true, rate: { max: 20, windowSeconds: 60 } }, async (_req, ctx, p) => {
  if (!UUID.test(p.id)) throw new SeoApiError("Content flow not found.", 404, "not_found");
  const b = parse(body, ctx.body ?? {});
  if (b.action === "run") return json(await runJob(p.id, ctx.actor.label), 202);
  if (b.action === "dry_run") return json(await runJob(p.id, ctx.actor.label, { dryRun: true, llm: b.llm }), 202);
  if (b.action === "clone") return json({ job: await cloneJob(ctx.actor, p.id) }, 201);
  if (b.action === "rollback") return json(await rollbackJob(ctx.actor, p.id, b.version));
  return json(await setJobEnabled(ctx.actor, p.id, b.action === "resume"));
});
