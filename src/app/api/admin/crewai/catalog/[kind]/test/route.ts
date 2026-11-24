import { z } from "zod";
import { agentApiError } from "@/lib/crewai/agent-http";
import { checkSpec, getItem } from "@/lib/crewai/catalog";
import { CatalogError } from "@/lib/crewai/catalog-shared";
import { customApiError } from "@/lib/crewai/custom";
import { kickoff } from "@/lib/seo-agent/client";
import { json, parse, SeoApiError, seoRoute } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

const spec = z.record(z.string(), z.unknown()).refine((v) => JSON.stringify(v).length <= 120_000, "at most 120,000 characters of JSON");
const body = z
  .object({ flow: z.string().max(40).optional(), draft: spec.optional(), crewDraft: spec.optional(), inputs: z.record(z.string(), z.string().max(4000)).default({}) })
  .strict()
  .refine((b) => b.flow || b.draft, "a saved flow's key or a draft");

/**
 * POST /api/admin/crewai/catalog/flows/test {flow | draft, crewDraft?, inputs} — a test run (dry run) of a flow defined by
 * steps: a saved one, or the draft in the editor (and a crew draft its steps use: a crew's Test run). Crews run; no draft
 * is created and no other flow is started. Drafts are checked by the SEO agent first. Audit-logged.
 */
export const POST = seoRoute<{ kind: string }>("crewai-catalog-test", { mutating: true, rate: { max: 20, windowSeconds: 600 } }, async (_req, ctx, p) => {
  if (p.kind !== "flows") throw new SeoApiError("Test runs are of flows; a crew is tested through a one-step draft flow.", 404, "not_found");
  const b = parse(body, ctx.body ?? {});
  let key: string;
  let extra: Record<string, unknown> = {};
  try {
    if (b.draft) {
      const crew = b.crewDraft ? await checkSpec("crew", b.crewDraft) : null;
      const draft = await checkSpec("flow", b.draft, crew ? [String(crew.key)] : []);
      key = String(draft.key);
      extra = { draft, ...(crew ? { crew_draft: crew } : {}) };
    } else {
      const item = await getItem("flow", b.flow!);
      if (!item || item.deletedAt || item.definition !== "spec") throw new CatalogError("Only flows defined by steps have a test run here; open a code flow to start it.", 404);
      key = item.key;
    }
  } catch (e) {
    customApiError(e);
  }
  try {
    const r = await kickoff("custom_flow", { flow: key, inputs: b.inputs, dry_run: true, ...extra }, { triggeredBy: "manual", actor: ctx.actor.label });
    await ctx.audit("crewai.flow.test", key, { runId: r.run_id, draft: Boolean(b.draft), crewDraft: Boolean(b.crewDraft) });
    return json({ runId: r.run_id, status: r.status, existing: r.existing }, r.existing ? 200 : 202);
  } catch (e) {
    agentApiError(e);
  }
});
