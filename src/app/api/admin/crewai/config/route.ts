import { z } from "zod";
import { siteUrl } from "@/config/site";
import { applyImport, bundleSchema, exportBundle, planImport, type AgentChecks } from "@/lib/crewai/config-io";
import { validateCrewConfigFor, validateFlowInputsFor } from "@/lib/crewai/agents";
import { json, parse, seoRoute } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

const agent: AgentChecks = { crew: (c, cfg) => validateCrewConfigFor(c, cfg), inputs: (f, i) => validateFlowInputsFor(f, i) };

/**
 * GET /api/admin/crewai/config?parts=schedules,crews,skills — the console's configuration as a JSON file to download
 * (lib/crewai/config-io.ts). No secrets, ids or run history. Audit-logged.
 */
export const GET = seoRoute("crewai-config-export", { rate: { max: 30, windowSeconds: 600 } }, async (_req, ctx) => {
  const want = new Set((ctx.query.get("parts") ?? "schedules,crews,skills").split(","));
  const parts = { schedules: want.has("schedules"), crews: want.has("crews"), skills: want.has("skills") };
  const host = new URL(siteUrl()).host;
  const bundle = await exportBundle(parts, host);
  await ctx.audit("crewai.config.export", host, { schedules: bundle.schedules.length, crews: bundle.crews.length, skills: bundle.skills.length });
  const date = bundle.exportedAt!.slice(0, 10);
  return json(bundle, 200, { "Content-Disposition": `attachment; filename="crewai-config-${host.replace(/[^a-z0-9.-]/gi, "")}-${date}.json"` });
});

const body = z.object({ bundle: z.unknown(), apply: z.boolean().default(false), activate: z.boolean().default(true) }).strict();

/**
 * POST /api/admin/crewai/config {bundle, apply, activate} — import. Without `apply`: the plan (what would be created,
 * changed, left alone or refused). With it: the plan computed again and applied; nothing is deleted. Crew versions are
 * made active when `activate`. Audit-logged.
 */
export const POST = seoRoute("crewai-config-import", { mutating: true, rate: { max: 20, windowSeconds: 600 } }, async (_req, ctx) => {
  const b = parse(body, ctx.body ?? {});
  const bundle = parse(bundleSchema, b.bundle);
  const plan = await planImport(bundle, agent);
  if (!b.apply) return json({ plan });
  const result = await applyImport(bundle, plan, { activate: b.activate }, ctx.actor);
  await ctx.audit("crewai.config.import", bundle.source ?? "file", { applied: result.applied, failed: result.failed.length, activate: b.activate });
  return json(result);
});
