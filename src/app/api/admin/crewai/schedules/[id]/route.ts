import { z } from "zod";
import { agentApiError } from "@/lib/crewai/agent-http";
import { deleteSchedule, getSchedule, resetSchedule, schedulePatch, updateSchedule } from "@/lib/crewai/schedules";
import { AgentError, kickoff, validateFlowInputs, type FlowName } from "@/lib/seo-agent/client";
import { json, parse, SeoApiError, seoRoute } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

async function load(id: string) {
  const s = await getSchedule(id);
  if (!s) throw new SeoApiError("Schedule not found.", 404, "not_found");
  return s;
}

/** PATCH /api/admin/crewai/schedules/{id} — change the time, time zone, inputs, description or pause/resume. */
export const PATCH = seoRoute<{ id: string }>("crewai-schedule-update", { mutating: true }, async (_req, ctx, p) => {
  const before = await load(p.id);
  const v = parse(schedulePatch, ctx.body ?? {});
  if (v.inputs) {
    try {
      v.inputs = (await validateFlowInputs(before.flow, v.inputs)).inputs;
    } catch (e) {
      if (!(e instanceof AgentError) || e.status !== 503) agentApiError(e);
    }
  }
  const s = await updateSchedule(p.id, v, ctx.actor.label);
  await ctx.audit("crewai.schedule.update", s.id, { name: s.name, before: { cron: before.cron, timezone: before.timezone, enabled: before.enabled }, after: { cron: s.cron, timezone: s.timezone, enabled: s.enabled }, inputsChanged: v.inputs !== undefined });
  return json({ schedule: s });
});

/** DELETE /api/admin/crewai/schedules/{id} — an admin's own schedule (built-in ones are paused instead). */
export const DELETE = seoRoute<{ id: string }>("crewai-schedule-delete", { mutating: true }, async (_req, ctx, p) => {
  const s = await deleteSchedule(p.id);
  await ctx.audit("crewai.schedule.delete", s.id, { name: s.name, flow: s.flow, cron: s.cron });
  return json({ deleted: true });
});

const action = z.discriminatedUnion("action", [z.object({ action: z.literal("run") }), z.object({ action: z.literal("reset") })]);

/**
 * POST /api/admin/crewai/schedules/{id} — {action: "run"}: start the schedule's flow now with its inputs (a manual run
 * in the admin's name; the schedule's own times do not change). {action: "reset"}: a built-in schedule back to its
 * shipped time, zone and inputs.
 */
export const POST = seoRoute<{ id: string }>("crewai-schedule-action", { mutating: true, rate: { max: 20, windowSeconds: 600 } }, async (_req, ctx, p) => {
  const b = parse(action, ctx.body ?? {});
  const s = await load(p.id);
  if (b.action === "reset") {
    const r = await resetSchedule(s.id, ctx.actor.label);
    await ctx.audit("crewai.schedule.reset", s.id, { name: s.name, before: { cron: s.cron, timezone: s.timezone }, after: { cron: r.cron, timezone: r.timezone } });
    return json({ schedule: r });
  }
  try {
    const r = await kickoff(s.flow as FlowName, s.inputs, { triggeredBy: "manual", actor: ctx.actor.label });
    await ctx.audit("crewai.schedule.run", s.id, { name: s.name, flow: s.flow, runId: r.run_id, existing: r.existing });
    return json({ runId: r.run_id, status: r.status, existing: r.existing }, r.existing ? 200 : 202);
  } catch (e) {
    agentApiError(e);
  }
});
