import { agentApiError } from "@/lib/crewai/agent-http";
import { createSchedule, listSchedules, scheduleInput } from "@/lib/crewai/schedules";
import { validateFlowInputsFor } from "@/lib/crewai/agents";
import { AgentError } from "@/lib/seo-agent/client";
import { json, parse, seoRoute } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

/** GET /api/admin/crewai/schedules — every schedule with its next and last fire. */
export const GET = seoRoute("crewai-schedules", {}, async () => json({ schedules: await listSchedules() }));

/**
 * POST /api/admin/crewai/schedules — a new schedule {name, flow, cron, timezone, inputs, enabled, description}. The
 * inputs are checked by the agent that runs the flow (the news agent for news_* flows, else the seo-agent) when it answers (the dispatcher checks them again at every start). It never
 * fires a time that has already passed. Audit-logged.
 */
export const POST = seoRoute("crewai-schedule-create", { mutating: true }, async (_req, ctx) => {
  const v = parse(scheduleInput, ctx.body ?? {});
  try {
    v.inputs = (await validateFlowInputsFor(v.flow, v.inputs)).inputs;
  } catch (e) {
    if (!(e instanceof AgentError) || e.status !== 503) agentApiError(e);
  }
  const s = await createSchedule(v, ctx.actor.label);
  await ctx.audit("crewai.schedule.create", s.id, { name: s.name, flow: s.flow, cron: s.cron, timezone: s.timezone, enabled: s.enabled });
  return json({ schedule: s }, 201);
});
