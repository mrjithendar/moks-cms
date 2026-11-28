import { sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
import { ML_KIND_LABELS, ML_KINDS, mlDecision, STALE_AFTER_DAYS, type MlDecision, type MlKind, type MlOverride } from "./ml";
import { getSeoSettings, publicSettings, saveSeoSettings } from "./settings";

/**
 * Admin side of the v5 models (Models page, Labelling, Settings → Scoring proposals). The models themselves run in the
 * seo-agent; this only reads their registry and records the owner's decisions (overrides, reviews, labels, weight
 * approvals), each audit-logged by the route that calls it.
 */
export type ModelRow = {
  kind: MlKind;
  title: string;
  decision: MlDecision;
  latest: { version: string; trainedAt: string; nSamples: number; metrics: Record<string, unknown>; ruleMetrics: Record<string, unknown>; beatsRule: boolean; active: boolean; status: string; notes: string | null; reviewedBy: string | null; reviewedAt: string | null } | null;
  history: { version: string; trainedAt: string; active: boolean; beatsRule: boolean; status: string }[];
  outputAt: string | null;
  stale: boolean;
  pendingLabels: number;
};

const OUTPUT: Record<MlKind, string | null> = { decay: "seo_ml_decay_signals", query_clusters: "seo_ml_query_clusters", intent: "seo_ml_intent_predictions", priority: null, related: "seo_ml_related_articles" };
const LABEL_TASK: Partial<Record<MlKind, string>> = { query_clusters: "cluster", intent: "intent_check" };
const j = (v: unknown) => (typeof v === "string" ? (JSON.parse(v) as Record<string, unknown>) : ((v ?? {}) as Record<string, unknown>));
const iso = (v: unknown) => (v ? new Date(String(v)).toISOString() : null);

async function tryRows<T>(db: Db, q: ReturnType<typeof sql>): Promise<T[]> {
  try {
    return rowsOf<T>(await db.execute(q));
  } catch {
    return []; // migration 0019 not applied
  }
}

export async function modelsView(now = new Date()): Promise<{ models: ModelRow[]; ragEval: { at: string; metrics: Record<string, unknown> } | null; migrated: boolean }> {
  const db = await getDb();
  const migrated = (await tryRows<{ n: number }>(db, sql`select count(*)::int as n from seo_ml_models`)).length > 0;
  const models: ModelRow[] = [];
  for (const kind of ML_KINDS) {
    const rows = await tryRows<Record<string, unknown>>(
      db,
      sql`select version, trained_at, n_samples, metrics, rule_metrics, beats_rule, active, status, notes, reviewed_by, reviewed_at from seo_ml_models where kind = ${kind} order by trained_at desc, id desc limit 8`,
    );
    const latest = rows[0];
    const table = OUTPUT[kind];
    const [out] = table ? await tryRows<{ t: string | null }>(db, sql`select max(computed_at)::text as t from ${sql.raw(table)}`) : [];
    const task = LABEL_TASK[kind];
    const [pending] = task ? await tryRows<{ n: number }>(db, sql`select count(*)::int as n from seo_ml_labels where task = ${task} and status = 'pending'`) : [];
    const outputAt = out?.t ? new Date(out.t).toISOString() : null;
    models.push({
      kind,
      title: ML_KIND_LABELS[kind],
      decision: await mlDecision(db, kind, now),
      latest: latest
        ? {
            version: String(latest.version),
            trainedAt: iso(latest.trained_at)!,
            nSamples: Number(latest.n_samples),
            metrics: j(latest.metrics),
            ruleMetrics: j(latest.rule_metrics),
            beatsRule: Boolean(latest.beats_rule),
            active: Boolean(latest.active),
            status: String(latest.status),
            notes: (latest.notes as string | null) ?? null,
            reviewedBy: (latest.reviewed_by as string | null) ?? null,
            reviewedAt: iso(latest.reviewed_at),
          }
        : null,
      history: rows.map((r) => ({ version: String(r.version), trainedAt: iso(r.trained_at)!, active: Boolean(r.active), beatsRule: Boolean(r.beats_rule), status: String(r.status) })),
      outputAt,
      stale: outputAt !== null && now.getTime() - new Date(outputAt).getTime() > STALE_AFTER_DAYS * 86_400_000,
      pendingLabels: Number(pending?.n ?? 0),
    });
  }
  const [rag] = await tryRows<{ at: string; metrics: unknown }>(db, sql`select at::text, metrics from seo_rag_eval_runs where config = 'live' order by at desc limit 1`);
  return { models, ragEval: rag ? { at: new Date(rag.at).toISOString(), metrics: j(rag.metrics) } : null, migrated };
}

export const overrideSchema = z.object({ override: z.enum(["auto", "rule", "model"]).optional(), approveReview: z.literal(true).optional() }).refine((v) => v.override || v.approveReview, "nothing to change");
export const kindSchema = z.enum(ML_KINDS);

export async function setOverride(kind: MlKind, mode: MlOverride, actor: string) {
  const db = await getDb();
  const [before] = rowsOf<{ mode: string }>(await db.execute(sql`select mode from seo_ml_overrides where kind = ${kind}`));
  await db.execute(sql`insert into seo_ml_overrides (kind, mode, updated_by, updated_at) values (${kind}, ${mode}, ${actor}, now()) on conflict (kind) do update set mode = excluded.mode, updated_by = excluded.updated_by, updated_at = now()`);
  return { before: before?.mode ?? "auto", after: mode };
}

/** The owner's sign-off where the activation rule needs one (decay: the real back-test; intent: the spot-checks are
 * counted by the agent). Activates the latest version only if it beats the rule. */
export async function approveReview(kind: MlKind, actor: string) {
  const db = await getDb();
  const [m] = rowsOf<{ id: number; version: string; beats_rule: boolean }>(await db.execute(sql`select id, version, beats_rule from seo_ml_models where kind = ${kind} order by trained_at desc, id desc limit 1`));
  if (!m) return { reviewed: false, activated: false, reason: "no model version yet" };
  await db.transaction(async (tx) => {
    await tx.execute(sql`update seo_ml_models set reviewed_by = ${actor}, reviewed_at = now() where id = ${m.id}`);
    if (m.beats_rule) {
      await tx.execute(sql`update seo_ml_models set active = false where kind = ${kind} and active`);
      await tx.execute(sql`update seo_ml_models set active = true, status = 'trained' where id = ${m.id}`);
    }
  });
  return { reviewed: true, version: m.version, activated: Boolean(m.beats_rule), reason: m.beats_rule ? "beats the rule on held-out data" : "reviewed, but it does not beat the rule: stays inactive" };
}

// --- labelling -----------------------------------------------------------------------------------------------------

export type LabelRow = { id: number; task: string; item: string; suggestion: Record<string, unknown>; label: Record<string, unknown> | null; status: string; labelledBy: string | null };
export const labelPatchSchema = z.object({
  id: z.number().int().positive(),
  status: z.enum(["confirmed", "changed", "skipped", "pending"]),
  label: z.object({ group: z.string().trim().min(1).max(120).optional(), intent: z.enum(["informational", "navigational", "commercial", "troubleshooting", "comparison"]).optional() }).optional(),
});

export async function listLabels(task: "cluster" | "intent_check", status?: string, limit = 300): Promise<{ rows: LabelRow[]; counts: Record<string, number>; groups: string[] }> {
  const db = await getDb();
  const rows = await tryRows<Record<string, unknown>>(db, sql`select id, task, item, suggestion, label, status, labelled_by from seo_ml_labels where task = ${task} ${status ? sql`and status = ${status}` : sql``} order by status = 'pending' desc, id limit ${limit}`);
  const counts = Object.fromEntries((await tryRows<{ status: string; n: number }>(db, sql`select status, count(*)::int as n from seo_ml_labels where task = ${task} group by status`)).map((r) => [r.status, Number(r.n)]));
  const groups = (await tryRows<{ g: string }>(db, sql`select distinct coalesce(label ->> 'group', suggestion ->> 'group') as g from seo_ml_labels where task = 'cluster' order by 1`)).map((r) => r.g).filter(Boolean);
  return { rows: rows.map((r) => ({ id: Number(r.id), task: String(r.task), item: String(r.item), suggestion: j(r.suggestion), label: r.label ? j(r.label) : null, status: String(r.status), labelledBy: (r.labelled_by as string | null) ?? null })), counts, groups };
}

/** Pending tasks per labelling task, for the Labelling tabs. */
export async function pendingLabelCounts(): Promise<{ cluster: number; intent_check: number }> {
  const db = await getDb();
  const rows = await tryRows<{ task: string; n: number }>(db, sql`select task, count(*)::int as n from seo_ml_labels where status = 'pending' group by task`);
  const by = Object.fromEntries(rows.map((r) => [r.task, Number(r.n)]));
  return { cluster: by.cluster ?? 0, intent_check: by.intent_check ?? 0 };
}

export async function saveLabel(p: z.infer<typeof labelPatchSchema>, actor: string) {
  const db = await getDb();
  const [row] = rowsOf<{ task: string; suggestion: unknown }>(await db.execute(sql`select task, suggestion from seo_ml_labels where id = ${p.id}`));
  if (!row) return null;
  const sug = j(row.suggestion);
  // "confirmed" stores the suggestion as the label (cluster: Claude's group; intent check: Haiku's intent)
  const label = p.status === "confirmed" ? (row.task === "cluster" ? { group: String(sug.group ?? "") } : { intent: String(sug.haiku ?? "") }) : p.status === "changed" ? (p.label ?? null) : null;
  if (p.status === "changed" && !label) return null;
  await db.execute(sql`update seo_ml_labels set status = ${p.status}, label = ${label ? JSON.stringify(label) : null}::jsonb, labelled_by = ${p.status === "pending" ? null : actor}, labelled_at = ${p.status === "pending" ? null : new Date().toISOString()} where id = ${p.id}`);
  return { id: p.id, status: p.status, label };
}

// --- weight proposals ----------------------------------------------------------------------------------------------

export type Proposal = { id: string; createdAt: string; modelVersion: string; weights: Record<string, number>; currentWeights: Record<string, number>; metrics: Record<string, unknown>; nOutcomes: number; status: string };

export async function listProposals(limit = 5): Promise<Proposal[]> {
  const db = await getDb();
  return (await tryRows<Record<string, unknown>>(db, sql`select id, created_at, model_version, weights, current_weights, metrics, n_outcomes, status from seo_ml_weight_proposals order by created_at desc limit ${limit}`)).map((r) => ({
    id: String(r.id),
    createdAt: iso(r.created_at)!,
    modelVersion: String(r.model_version),
    weights: j(r.weights) as Record<string, number>,
    currentWeights: j(r.current_weights) as Record<string, number>,
    metrics: j(r.metrics),
    nOutcomes: Number(r.n_outcomes),
    status: String(r.status),
  }));
}

/** Approve: the proposal's weights become the scoring weights (a new weights version in the audited settings
 * document); dismiss: nothing changes. Only a "proposed" proposal can be decided. */
export async function decideProposal(id: string, decision: "approve" | "dismiss", actor: string) {
  const db = await getDb();
  const [p] = rowsOf<{ weights: unknown; status: string; model_version: string }>(await db.execute(sql`select weights, status, model_version from seo_ml_weight_proposals where id = ${id}`));
  if (!p || p.status !== "proposed") return null;
  let settingsChange: { before: unknown; after: unknown } | null = null;
  if (decision === "approve") {
    const doc = publicSettings(await getSeoSettings());
    settingsChange = await saveSeoSettings({ ...doc, weights: { ...doc.weights, ...(j(p.weights) as Record<string, number>) } }, actor);
  }
  await db.execute(sql`update seo_ml_weight_proposals set status = ${decision === "approve" ? "approved" : "dismissed"}, decided_by = ${actor}, decided_at = now() where id = ${id}`);
  return { id, decision, modelVersion: p.model_version, settingsChange };
}
