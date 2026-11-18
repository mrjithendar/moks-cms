import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import { rowsOf } from "@/db/rows";

/**
 * SEO v5 ML outputs, read-only (docs/seo/ML.md). The models run in the seo-agent (seo_ml_flow, weekly) and write
 * `seo_ml_*` tables; nothing here trains or runs a model. Every reader decides "model" or "rule" the same way:
 *
 *   override "rule"  → rule
 *   override "model" → model when its outputs exist and are fresh, else rule ("model forced, no fresh output")
 *   override "auto"  → model when a version is ACTIVE (it beat the rule on held-out data, ML.md) and its outputs
 *                      are fresh, else rule
 *
 * Fresh = computed within 2 × the weekly schedule (14 days). Missing tables (migration 0019 not applied) = rule.
 * The returned `label` ("model v3", "rule", "rule (stale model output)") is what the UI shows next to the number.
 */
export const ML_KINDS = ["decay", "query_clusters", "intent", "priority", "related"] as const;
export type MlKind = (typeof ML_KINDS)[number];
export type MlOverride = "auto" | "rule" | "model";
export const STALE_AFTER_DAYS = 14;

export const ML_KIND_LABELS: Record<MlKind, string> = {
  decay: "Content decay (STL)",
  query_clusters: "Query clusters (HDBSCAN)",
  intent: "Intent classifier",
  priority: "Learned priority (weight proposals)",
  related: "Related articles",
};

const OUTPUT_TABLE: Record<MlKind, string | null> = {
  decay: "seo_ml_decay_signals",
  query_clusters: "seo_ml_query_clusters",
  intent: "seo_ml_intent_predictions",
  priority: null, // proposals only: never used without the owner's approval
  related: "seo_ml_related_articles",
};

export type MlDecision = { kind: MlKind; mode: "model" | "rule"; label: string; version: string | null; reason: string; override: MlOverride };

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback; // migration 0019 not applied yet
  }
}

export async function mlOverride(db: Db, kind: MlKind): Promise<MlOverride> {
  const [r] = await safe(async () => rowsOf<{ mode: MlOverride }>(await db.execute(sql`select mode from seo_ml_overrides where kind = ${kind}`)), []);
  return r?.mode ?? "auto";
}

export async function mlDecision(db: Db, kind: MlKind, now = new Date()): Promise<MlDecision> {
  const override = await mlOverride(db, kind);
  const rule = (reason: string, label = "rule"): MlDecision => ({ kind, mode: "rule", label, version: null, reason, override });
  if (override === "rule") return rule("forced to the rule on the Models page");
  const table = OUTPUT_TABLE[kind];
  if (!table) return rule("this model only proposes; nothing is applied without approval");
  const [latest] = await safe(
    async () => rowsOf<{ version: string; active: boolean }>(await db.execute(sql`select version, active from seo_ml_models where kind = ${kind} order by active desc, trained_at desc limit 1`)),
    [],
  );
  if (!latest) return rule("no model trained yet");
  const [fresh] = await safe(
    async () => rowsOf<{ t: string | null }>(await db.execute(sql`select max(computed_at)::text as t from ${sql.raw(table)}`)),
    [{ t: null }],
  );
  const t = fresh?.t ? new Date(fresh.t) : null;
  const isFresh = t !== null && now.getTime() - t.getTime() <= STALE_AFTER_DAYS * 86_400_000;
  if (override === "model") {
    return isFresh ? { kind, mode: "model", label: `model ${latest.version}`, version: latest.version, reason: "forced to the model on the Models page", override } : rule("model forced, but its output is missing or stale", "rule (stale model output)");
  }
  if (!latest.active) return rule("the model has not beaten the rule on held-out data (or awaits review)");
  if (!isFresh) return rule(`model output older than ${STALE_AFTER_DAYS} days`, "rule (stale model output)");
  return { kind, mode: "model", label: `model ${latest.version}`, version: latest.version, reason: "active: beat the rule on held-out data", override };
}

// --- readers -------------------------------------------------------------------------------------------------------

export type DecaySignal = { page: string; decaying: boolean; trendSlope: number | null; dropPct: number | null; confidence: number | null; methodVersion: string; evidence: { dates?: string[]; actual?: number[]; trend?: number[]; reason?: string; z?: number; falling_days?: number } };

export async function decaySignals(db: Db): Promise<Map<string, DecaySignal>> {
  const rows = await safe(
    async () =>
      rowsOf<Record<string, unknown>>(await db.execute(sql`select page, decaying, trend_slope, drop_pct, confidence, method_version, evidence from seo_ml_decay_signals`)),
    [],
  );
  return new Map(
    rows.map((r) => [
      String(r.page),
      {
        page: String(r.page),
        decaying: Boolean(r.decaying),
        trendSlope: r.trend_slope === null ? null : Number(r.trend_slope),
        dropPct: r.drop_pct === null ? null : Number(r.drop_pct),
        confidence: r.confidence === null ? null : Number(r.confidence),
        methodVersion: String(r.method_version),
        evidence: (typeof r.evidence === "string" ? JSON.parse(r.evidence) : r.evidence) as DecaySignal["evidence"],
      },
    ]),
  );
}

export async function mlQueryClusters(db: Db): Promise<Map<string, { clusterId: number; label: string }>> {
  const rows = await safe(async () => rowsOf<{ query: string; cluster_id: number; cluster_label: string }>(await db.execute(sql`select query, cluster_id, cluster_label from seo_ml_query_clusters`)), []);
  return new Map(rows.map((r) => [r.query, { clusterId: Number(r.cluster_id), label: r.cluster_label }]));
}

/** The intent model's predictions with its confidence threshold (stored with the model version). */
export async function mlIntents(db: Db): Promise<{ threshold: number; byQuery: Map<string, { intent: string; confidence: number }> }> {
  const [m] = await safe(async () => rowsOf<{ t: number | null }>(await db.execute(sql`select (metrics ->> 'threshold')::float8 as t from seo_ml_models where kind = 'intent' order by active desc, trained_at desc limit 1`)), []);
  const rows = await safe(async () => rowsOf<{ query: string; intent: string; confidence: number }>(await db.execute(sql`select query, intent, confidence from seo_ml_intent_predictions`)), []);
  return { threshold: Number(m?.t ?? 0.7), byQuery: new Map(rows.map((r) => [r.query, { intent: r.intent, confidence: Number(r.confidence) }])) };
}

/**
 * The search intent of a brief's queries according to the intent model (D-96: the crews pick the matching writing
 * skill from it). Only when the model is in use (mlDecision "model") and only a prediction at or above the model's
 * confidence threshold; the first such query wins (a brief lists its main query first). null otherwise.
 */
export async function mlIntentFor(db: Db, queries: string[]): Promise<{ intent: string; query: string; label: string } | null> {
  const qs = queries.map((q) => q.trim()).filter(Boolean).slice(0, 10);
  if (qs.length === 0) return null;
  const decision = await mlDecision(db, "intent");
  if (decision.mode !== "model") return null;
  const { threshold, byQuery } = await mlIntents(db);
  for (const q of qs) {
    const p = byQuery.get(q) ?? byQuery.get(q.toLowerCase().replace(/\s+/g, " "));
    if (p && p.confidence >= threshold) return { intent: p.intent, query: q, label: decision.label };
  }
  return null;
}

/** A/B arm by article-id parity, the same as the agent's app/seo_ml/related.py experiment_arm. */
export function relatedArm(articleId: string): "model" | "rule" {
  const last = articleId.replace(/-/g, "").slice(-1).toLowerCase() || "0";
  return parseInt(last, 16) % 2 === 0 ? "model" : "rule";
}

export async function mlRelated(db: Db, articleId: string, limit: number): Promise<{ id: string; score: number }[]> {
  return safe(
    async () =>
      rowsOf<{ related_id: string; score: number }>(await db.execute(sql`select related_id::text, score from seo_ml_related_articles where article_id = ${articleId} order by rank limit ${limit}`)).map((r) => ({
        id: r.related_id,
        score: Number(r.score),
      })),
    [],
  );
}

/**
 * Which list the public "Related articles" block shows for an article (v5 3.5). While the related-articles model is
 * an A/B experiment (status experiment_running, fresh output), even article-id parity gets the model's list and odd
 * parity the existing rule; a forced override or an active model applies to every article. Explicit `related`
 * front-matter entries stay first in both arms (editor intent).
 */
export async function relatedPlan(db: Db, articleId: string, now = new Date()): Promise<{ use: "model" | "rule"; arm: "model" | "rule" | null; label: string }> {
  const d = await mlDecision(db, "related", now);
  if (d.override === "rule") return { use: "rule", arm: null, label: "rule" };
  if (d.mode === "model") return { use: "model", arm: null, label: d.label };
  const [m] = await safe(
    async () =>
      rowsOf<{ version: string; status: string; t: string | null }>(
        await db.execute(sql`select version, status, (select max(computed_at)::text from seo_ml_related_articles) as t from seo_ml_models where kind = 'related' order by trained_at desc limit 1`),
      ),
    [],
  );
  const fresh = m?.t ? now.getTime() - new Date(m.t).getTime() <= STALE_AFTER_DAYS * 86_400_000 : false;
  if (m?.status !== "experiment_running" || !fresh) return { use: "rule", arm: null, label: "rule" };
  const arm = relatedArm(articleId);
  return { use: arm, arm, label: arm === "model" ? `model ${m.version} (A/B)` : "rule (A/B)" };
}
