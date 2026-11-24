import { z } from "zod";
import { agentApiError } from "@/lib/crewai/agent-http";
import { getItem } from "@/lib/crewai/catalog";
import { START_LABELS } from "@/lib/crewai/catalog-shared";
import { flowInfo, rerunBlocked } from "@/lib/crewai/flows";
import { kickoff, type FlowName } from "@/lib/seo-agent/client";
import { json, parse, SeoApiError, seoRoute } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

const body = z.object({ inputs: z.record(z.string(), z.unknown()).default({}) }).strict();

/**
 * POST /api/admin/crewai/flows/{name} {inputs} — Run with parameters (Jenkins' "Build with Parameters"): start the flow
 * as a manual run in the admin's name. The agent checks the inputs against the flow's input model (422 with the
 * reason). Flows started elsewhere (drafting flows from the review queue, publish from an approval, per-story news
 * runs) are refused here, as for Re-run. Audit-logged.
 */
export const POST = seoRoute<{ name: string }>("crewai-flow-run", { mutating: true, rate: { max: 20, windowSeconds: 600 } }, async (_req, ctx, p) => {
  const b = parse(body, ctx.body ?? {});
  if (!/^[a-z][a-z0-9_]{2,39}_flow$/.test(p.name)) throw new SeoApiError("Unknown flow.", 404, "not_found");
  // The catalogue's row (migration 0041) decides first: switched off or deleted there, nobody starts it; its start rule
  // comes from the agent. A flow the catalogue does not list (the runners) falls back to the console's own rules.
  const row = await getItem("flow", p.name).catch(() => null);
  if (row?.deletedAt) throw new SeoApiError(`${row.label} is deleted: restore it under AI & SEO → Flows first.`, 409, "not_startable");
  if (row && !row.enabled) throw new SeoApiError(`${row.label} is switched off${row.disabledReason ? `: ${row.disabledReason}` : ""}.`, 409, "not_startable");
  if (!row && flowInfo(p.name).group === "Other") throw new SeoApiError("Unknown flow.", 404, "not_found");
  const blocked = p.name === "crew_test_flow" ? "Start a crew test run from Crews → Test run." : row && row.start && row.start !== "manual" ? `This flow starts ${START_LABELS[row.start] ?? row.start}.` : rerunBlocked(p.name);
  if (blocked) throw new SeoApiError(blocked, 409, "not_startable");
  try {
    const r = await kickoff(p.name as FlowName, b.inputs, { triggeredBy: "manual", actor: ctx.actor.label });
    await ctx.audit("crewai.run", p.name, { runId: r.run_id, existing: r.existing, inputs: Object.keys(b.inputs) });
    return json({ runId: r.run_id, status: r.status, existing: r.existing }, r.existing ? 200 : 202);
  } catch (e) {
    agentApiError(e);
  }
});
