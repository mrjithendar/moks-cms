import { z } from "zod";
import { agentApiError } from "@/lib/crewai/agent-http";
import { activateVersion, CREW_ID, listVersions, saveVersion } from "@/lib/crewai/crews";
import { runDetail } from "@/lib/crewai/runs";
import { kickoff, validateCrewConfig } from "@/lib/seo-agent/client";
import { json, parse, SeoApiError, seoRoute, UUID } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

const config = z.record(z.string(), z.unknown()).refine((v) => JSON.stringify(v).length <= 120_000, "at most 120,000 characters of JSON");
const action = z.discriminatedUnion("action", [
  z.object({ action: z.literal("validate"), config }),
  z.object({ action: z.literal("save"), config, note: z.string().trim().max(500).default(""), activate: z.boolean().default(false), fromRun: z.string().regex(UUID).optional() }),
  z.object({ action: z.literal("activate"), version: z.number().int().positive() }),
  z.object({ action: z.literal("defaults") }),
  z.object({ action: z.literal("test"), config, sourceRunId: z.string().regex(UUID), version: z.number().int().positive().optional(), note: z.string().trim().max(500).optional() }),
]);

/** GET /api/admin/crewai/crews/{crew} — the crew's saved versions, newest first. */
export const GET = seoRoute<{ crew: string }>("crewai-crew", {}, async (_req, _ctx, p) => {
  if (!CREW_ID.test(p.crew)) throw new SeoApiError("Unknown crew.", 404, "not_found");
  return json({ versions: await listVersions(p.crew) });
});

/**
 * POST /api/admin/crewai/crews/{crew}
 * - {action: "validate", config}: the SEO agent checks it against the crew's code and returns it as it would be stored.
 * - {action: "save", config, note, activate}: version N+1 (checked by the agent first, which must answer); active at once
 *   when `activate`. Versions are never edited.
 * - {action: "activate", version}: make a saved version the one the crew runs (also a rollback).
 * - {action: "defaults"}: no active version, so the crew runs the code's defaults again.
 * - {action: "test", config, sourceRunId}: a crew test run (crew_test_flow) of the unsaved configuration on the inputs of
 *   an earlier run, like Jenkins Replay. It saves nothing; the new run opens in the console.
 * All of them are audit-logged.
 */
export const POST = seoRoute<{ crew: string }>("crewai-crew-action", { mutating: true, rate: { max: 30, windowSeconds: 600 } }, async (_req, ctx, p) => {
  if (!CREW_ID.test(p.crew)) throw new SeoApiError("Unknown crew.", 404, "not_found");
  const b = parse(action, ctx.body ?? {});
  try {
    switch (b.action) {
      case "validate": {
        const r = await validateCrewConfig(p.crew, b.config);
        return json({ config: r.config, defaultHash: r.default_hash, promptVersion: r.prompt_version });
      }
      case "save": {
        const r = await validateCrewConfig(p.crew, b.config);
        const v = await saveVersion({ crew: p.crew, config: r.config, note: b.note, source: b.fromRun ? "test" : "editor", baseHash: r.default_hash, promptVersion: r.prompt_version, activate: b.activate, actor: ctx.actor.label });
        await ctx.audit("crewai.crew.save", `${p.crew}@v${v.version}`, { crew: p.crew, version: v.version, active: v.active, fromRun: b.fromRun ?? null, agents: Object.keys((r.config.agents as object) ?? {}), tasks: Object.keys((r.config.tasks as object) ?? {}) });
        return json({ version: v }, 201);
      }
      case "activate": {
        const v = await activateVersion(p.crew, b.version, ctx.actor.label);
        if (!v) throw new SeoApiError("That version does not exist.", 404, "not_found");
        await ctx.audit("crewai.crew.activate", `${p.crew}@v${v.version}`, { crew: p.crew, version: v.version });
        return json({ version: v });
      }
      case "defaults": {
        await activateVersion(p.crew, null, ctx.actor.label);
        await ctx.audit("crewai.crew.defaults", p.crew, { crew: p.crew });
        return json({ version: null });
      }
      case "test": {
        const src = await runDetail(b.sourceRunId);
        if (!src) throw new SeoApiError("The run to replay was not found.", 404, "not_found");
        if (src.status === "queued" || src.status === "running") throw new SeoApiError("That run has not finished yet.", 409, "running");
        const r = await kickoff("crew_test_flow", { crew: p.crew, source_run_id: b.sourceRunId, config: b.config, ...(b.version ? { version: b.version } : {}), ...(b.note ? { note: b.note } : {}) }, { triggeredBy: "manual", actor: ctx.actor.label });
        await ctx.audit("crewai.crew.test", p.crew, { crew: p.crew, sourceRunId: b.sourceRunId, sourceFlow: src.flow, runId: r.run_id, existing: r.existing, version: b.version ?? null });
        return json({ runId: r.run_id, status: r.status, existing: r.existing }, r.existing ? 200 : 202);
      }
    }
  } catch (e) {
    agentApiError(e);
  }
});
