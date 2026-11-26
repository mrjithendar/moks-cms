import "server-only";
import { z } from "zod";
import { CallbackError } from "../seo-agent/callbacks";
import { agentAnalysis, agentData, agentPdf, notify, ReportError } from "./service";
import type { Analysis, AnalysisCheck } from "./types";

/**
 * The SEO agent's side of a console report (internal-server.ts /site-reports/{id}/…, seo-agent/app/flows/report.py).
 * Bodies are checked here; the analysis is the agent's already-checked answer and is stored as data (rendered escaped).
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const id = (v: string) => {
  if (!UUID.test(v)) throw new CallbackError("Invalid report id.", 400, "invalid");
  return v;
};
async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ReportError) throw new CallbackError(e.message, e.status, e.code);
    throw e;
  }
}
const text = (max: number) => z.string().max(max);
const ids = z.array(z.string().max(24)).max(8);
const analysis = z.object({
  executive_summary: text(3000).optional(),
  achievements: z.array(z.object({ text: text(600), evidence: ids })).max(10).optional(),
  risks: z.array(z.object({ text: text(600), evidence: ids })).max(10).optional(),
  root_causes: z.array(z.object({ issue: text(300), cause: text(900), status: z.enum(["confirmed", "probable", "investigate"]), evidence: ids, next_check: text(400).optional(), downgraded: z.boolean().optional() })).max(15).optional(),
  fixes: z.array(z.object({ issue: text(300), severity: z.enum(["critical", "high", "medium", "low"]), evidence: ids, impact: text(600), fix: text(900), steps: z.array(text(400)).max(8), expected_outcome: text(400).optional(), effort: text(120).optional() })).max(15).optional(),
  recommendations: z.array(z.object({ area: text(40), text: text(700), evidence: ids })).max(25).optional(),
  action_plan: z.array(z.object({ priority: z.enum(["critical", "high", "medium", "low"]), action: text(400), owner: text(120).optional(), evidence: ids })).max(25).optional(),
});
const body = z.object({ analysis: z.union([analysis, z.object({}).strict()]), check: z.record(z.string(), z.unknown()), crew: z.record(z.string(), z.unknown()).default({}) });

export const siteReportData = (rid: string) => wrap(() => agentData(id(rid)));

export async function siteReportAnalysis(rid: string, raw: unknown) {
  const b = body.safeParse(raw);
  if (!b.success) throw new CallbackError(`Invalid analysis: ${b.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, 400, "invalid");
  return wrap(() => agentAnalysis(id(rid), { analysis: b.data.analysis as Analysis, check: b.data.check as AnalysisCheck, crew: b.data.crew }));
}

export async function siteReportPdf(rid: string, raw: unknown) {
  const b = z.object({ pdf: z.string().max(17_000_000) }).safeParse(raw);
  if (!b.success) throw new CallbackError("Send {pdf: base64}.", 400, "invalid");
  return wrap(() => agentPdf(id(rid), Buffer.from(b.data.pdf, "base64")));
}

export const siteReportNotify = (rid: string) => wrap(() => notify(id(rid)));
