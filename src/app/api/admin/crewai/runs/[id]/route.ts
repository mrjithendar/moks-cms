import { z } from "zod";
import { rerunBlocked } from "@/lib/crewai/flows";
import { runDetail } from "@/lib/crewai/runs";
import { AgentError, cancelRun, kickoff, type FlowName } from "@/lib/seo-agent/client";
import { json, parse, SeoApiError, seoRoute, UUID } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

const action = z.discriminatedUnion("action", [
  // Inputs are checked by the agent against the flow's own input model (422 with the reason when they do not fit).
  z.object({ action: z.literal("rerun"), inputs: z.record(z.string(), z.unknown()).optional() }),
  z.object({ action: z.literal("cancel") }),
]);

function agentError(e: unknown): never {
  if (e instanceof AgentError) throw new SeoApiError(e.message, [403, 404, 409, 422, 429].includes(e.status) ? e.status : 503, "agent");
  throw e;
}

/** GET /api/admin/crewai/runs/{id} — one run with its steps, cost per agent and model, parent and child runs. */
export const GET = seoRoute<{ id: string }>("crewai-run", {}, async (_req, _ctx, p) => {
  const run = UUID.test(p.id) ? await runDetail(p.id) : null;
  if (!run) throw new SeoApiError("Run not found.", 404, "not_found");
  return json({ run });
});

/**
 * POST /api/admin/crewai/runs/{id} — {action: "rerun", inputs?} starts the run's flow again as a manual run (same inputs
 * unless edited); {action: "cancel"} stops a queued or running run. Both go through the SEO agent and are audit-logged.
 * Drafting, publish and per-story news runs are not started from here (lib/crewai/flows.ts rerunBlocked).
 */
export const POST = seoRoute<{ id: string }>("crewai-run-action", { mutating: true, rate: { max: 20, windowSeconds: 600 } }, async (_req, ctx, p) => {
  const b = parse(action, ctx.body ?? {});
  const run = UUID.test(p.id) ? await runDetail(p.id) : null;
  if (!run) throw new SeoApiError("Run not found.", 404, "not_found");
  if (b.action === "cancel") {
    if (!["queued", "running"].includes(run.status)) throw new SeoApiError("This run has already finished.", 409, "finished");
    try {
      const r = await cancelRun(run.runId);
      await ctx.audit("crewai.cancel", run.runId, { flow: run.flow, number: run.number });
      return json(r);
    } catch (e) {
      agentError(e);
    }
  }
  const blocked = rerunBlocked(run.flow);
  if (blocked) throw new SeoApiError(blocked, 409, "not_rerunnable");
  const inputs = b.action === "rerun" && b.inputs ? b.inputs : run.inputs;
  try {
    const r = await kickoff(run.flow as FlowName, inputs, { triggeredBy: "manual", actor: ctx.actor.label });
    await ctx.audit("crewai.rerun", run.runId, { flow: run.flow, number: run.number, newRunId: r.run_id, existing: r.existing, editedInputs: Boolean(b.action === "rerun" && b.inputs) });
    return json({ runId: r.run_id, status: r.status, existing: r.existing }, r.existing ? 200 : 202);
  } catch (e) {
    agentError(e);
  }
});
