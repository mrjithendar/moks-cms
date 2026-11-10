import { sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
import { recordSeoRecommendations } from "../metrics";
import { loadAnalysisData } from "./data";
import { generateEditorialSuggestions } from "./editorial";
import { llmJson, safeQueries, type LlmDeps } from "./llm";
import { runRules, type Candidate } from "./rules";
import { scoreOf } from "./scoring";
import { getSeoSettings, type SeoSettings } from "./settings";
import { addDays } from "./sqlutil";

/**
 * Recommendation lifecycle:
 *   generate (rules, no LLM needed) → pending → approved / rejected by an admin → implementation_status
 *   (not_started → in_progress → implemented) → baseline captured at "implemented" → outcomes at +28 and +56 days.
 * Re-running generation refreshes pending recommendations (same fingerprint) with new evidence and score; it never
 * resurrects rejected ones or touches approved/implemented ones.
 */
export const PROMPT_VERSION = "seo-rec-explain-v1";

export type GenerateResult = { created: number; refreshed: number; skipped: number; linkSuggestions: number; editorial: number; enriched: number; asOf: string | null };

export async function generateRecommendations(opts: { llm?: boolean; now?: Date; llmDeps?: LlmDeps } = {}): Promise<GenerateResult> {
  const db = await getDb();
  const s = await getSeoSettings();
  const now = opts.now ?? new Date();
  const data = await loadAnalysisData(db);
  const { candidates, linkSuggestions } = runRules(data, s, now);
  const bands = { high: s.thresholds.bandHigh, medium: s.thresholds.bandMedium };
  const analysisDate = data.asOf ?? now.toISOString().slice(0, 10);
  let created = 0;
  let refreshed = 0;
  let skipped = 0;
  const byCategory = new Map<string, number>();
  for (const c of candidates) {
    const sc = scoreOf(c.inputs, s.weights, bands);
    const [existing] = rowsOf<{ id: string; review_status: string }>(await db.execute(sql`select id, review_status from seo_recommendations where fingerprint = ${c.fingerprint}`));
    if (existing && existing.review_status !== "pending") {
      skipped++;
      continue;
    }
    const scoreInputs = { inputs: sc.inputs, used: sc.used, missing: sc.missing, renormalized: sc.renormalized, weights: sc.weights };
    const [row] = rowsOf<{ id: string; inserted: boolean }>(
      await db.execute(sql`
        insert into seo_recommendations (fingerprint, article_id, url, query, category, rule_key, problem, proposed_action, analysis_date, priority_score, priority_band, score_inputs, confidence, expected_impact)
        values (${c.fingerprint}, ${c.articleId}, ${c.url}, ${c.query}, ${c.category}, ${c.ruleKey}, ${c.problem}, ${c.proposedAction}, ${analysisDate}, ${sc.score}, ${sc.band}, ${JSON.stringify(scoreInputs)}::jsonb, ${c.confidence}, ${c.expectedImpact})
        on conflict (fingerprint) do update set article_id = excluded.article_id, url = excluded.url, rule_key = excluded.rule_key, problem = excluded.problem,
          proposed_action = excluded.proposed_action, analysis_date = excluded.analysis_date, priority_score = excluded.priority_score, priority_band = excluded.priority_band,
          score_inputs = excluded.score_inputs, confidence = excluded.confidence, expected_impact = excluded.expected_impact, updated_at = now()
        where seo_recommendations.review_status = 'pending'
        returning id, (xmax = 0) as inserted`),
    );
    if (!row) continue;
    if (row.inserted) created++;
    else refreshed++;
    byCategory.set(c.category, (byCategory.get(c.category) ?? 0) + 1);
    await writeEvidence(db, row.id, c);
  }
  for (const [cat, n] of byCategory) recordSeoRecommendations(cat, n);

  for (const l of linkSuggestions) {
    await db.execute(sql`
      insert into seo_internal_link_suggestions (source_article_id, target_article_id, anchor_text, reason, score, evidence)
      values (${l.sourceId}, ${l.targetId}, ${l.anchor}, ${l.reason}, ${l.score}, ${JSON.stringify(l.evidence)}::jsonb)
      on conflict (source_article_id, target_article_id) do update set anchor_text = excluded.anchor_text, reason = excluded.reason, score = excluded.score, evidence = excluded.evidence, updated_at = now()
      where seo_internal_link_suggestions.status = 'suggested'`);
  }
  const editorial = await generateEditorialSuggestions(db, s, data, candidates, now);
  const enriched = opts.llm === false ? 0 : await enrichRecommendations(db, s, 10, opts.llmDeps);
  return { created, refreshed, skipped, linkSuggestions: linkSuggestions.length, editorial, enriched, asOf: data.asOf };
}

async function writeEvidence(db: Db, id: string, c: Candidate) {
  await db.execute(sql`delete from seo_recommendation_evidence where recommendation_id = ${id}`);
  for (const e of c.evidence) {
    await db.execute(sql`
      insert into seo_recommendation_evidence (recommendation_id, metric, period, value, value_text, source, detail)
      values (${id}, ${e.metric}, ${e.period}, ${e.value}, ${e.valueText ?? null}, ${e.source}, ${JSON.stringify(e.detail ?? {})}::jsonb)`);
  }
}

// --- LLM explanation (optional) ------------------------------------------------------------------------------------

const explanationSchema = z.object({ explanation: z.string().min(20).max(1200), risks: z.array(z.string().max(300)).max(5) });
const explanationJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["explanation", "risks"],
  properties: { explanation: { type: "string" }, risks: { type: "array", items: { type: "string" } } },
};

/** Adds an AI explanation to the top pending recommendations that lack one. Failures leave the rule text as is. */
export async function enrichRecommendations(db: Db, s: SeoSettings, limit: number, deps: LlmDeps = {}): Promise<number> {
  if (!s.llm.enabled) return 0;
  const recs = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select r.id, r.category, r.problem, r.proposed_action, r.query, r.url, p.title, p.seo_title, p.seo_description, p.description
      from seo_recommendations r left join post p on p.id = r.article_id
      where r.review_status = 'pending' and r.ai_explanation is null and r.priority_band in ('high', 'medium')
      order by r.priority_score desc limit ${limit}`),
  );
  let n = 0;
  for (const r of recs) {
    const ev = rowsOf<Record<string, unknown>>(await db.execute(sql`select metric, period, value, value_text, source from seo_recommendation_evidence where recommendation_id = ${r.id}`));
    const res = await llmJson(
      db,
      s,
      {
        promptVersion: PROMPT_VERSION,
        task: "Explain to the editor, in 2–4 plain sentences, why this recommendation matters and how to act on it, using only the evidence given. List up to 3 risks or caveats (e.g. seasonality, partial query coverage).",
        blocks: [
          { name: "recommendation", content: { category: r.category, problem: r.problem, proposedAction: r.proposed_action, query: r.query ? safeQueries([String(r.query)])[0] ?? null : null, path: r.url ? new URL(String(r.url)).pathname : null } },
          { name: "evidence", content: ev },
          { name: "article", content: r.title ? { title: r.title, seoTitle: r.seo_title, metaDescription: r.seo_description ?? r.description } : null },
        ],
        jsonSchema: explanationJsonSchema,
        schema: explanationSchema,
      },
      deps,
    );
    if (!res.ok) {
      if (res.reason === "limit" || res.reason === "disabled") break;
      continue;
    }
    const text = res.value.risks.length ? `${res.value.explanation}\n\nCaveats: ${res.value.risks.join("; ")}` : res.value.explanation;
    await db.execute(sql`update seo_recommendations set ai_explanation = ${text}, ai_prompt_version = ${res.promptVersion}, updated_at = now() where id = ${r.id}`);
    n++;
  }
  return n;
}

// --- Listing and review --------------------------------------------------------------------------------------------

export const listFilter = z.object({
  status: z.enum(["pending", "approved", "rejected", "all"]).catch("pending"),
  category: z.string().regex(/^[a-z_]{1,40}$/).optional().catch(undefined),
  band: z.enum(["high", "medium", "low"]).optional().catch(undefined),
  articleId: z.string().uuid().optional().catch(undefined),
  limit: z.coerce.number().int().min(1).max(100).catch(25),
  offset: z.coerce.number().int().min(0).catch(0),
});

/** Counts per review status for the Recommendations status tabs. */
export async function recommendationStatusCounts(): Promise<{ pending: number; approved: number; rejected: number; all: number }> {
  const db = await getDb();
  const rows = rowsOf<{ s: string; n: number }>(await db.execute(sql`select review_status as s, count(*)::int as n from seo_recommendations group by 1`));
  const by = Object.fromEntries(rows.map((r) => [r.s, Number(r.n)]));
  return { pending: by.pending ?? 0, approved: by.approved ?? 0, rejected: by.rejected ?? 0, all: rows.reduce((a, r) => a + Number(r.n), 0) };
}

export async function listRecommendations(raw: Record<string, unknown>) {
  const f = listFilter.parse(raw);
  const db = await getDb();
  const parts = [sql`true`];
  if (f.status !== "all") parts.push(sql`r.review_status = ${f.status}`);
  if (f.category) parts.push(sql`r.category = ${f.category}`);
  if (f.band) parts.push(sql`r.priority_band = ${f.band}`);
  if (f.articleId) parts.push(sql`r.article_id = ${f.articleId}`);
  const rows = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select r.*, p.title as article_title, count(*) over ()::int as total
      from seo_recommendations r left join post p on p.id = r.article_id
      where ${sql.join(parts, sql` and `)} order by r.priority_score desc, r.created_at desc limit ${f.limit} offset ${f.offset}`),
  );
  const ids = rows.map((r) => String(r.id));
  const ev = ids.length ? rowsOf<Record<string, unknown>>(await db.execute(sql`select * from seo_recommendation_evidence where recommendation_id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`)) : [];
  return {
    total: Number(rows[0]?.total ?? 0),
    rows: rows.map((r) => ({
      id: String(r.id),
      articleId: (r.article_id as string | null) ?? null,
      articleTitle: (r.article_title as string | null) ?? null,
      url: (r.url as string | null) ?? null,
      query: (r.query as string | null) ?? null,
      category: String(r.category),
      ruleKey: String(r.rule_key),
      problem: String(r.problem),
      proposedAction: String(r.proposed_action),
      analysisDate: String(r.analysis_date).slice(0, 10),
      priorityScore: Number(r.priority_score),
      priorityBand: String(r.priority_band),
      scoreInputs: r.score_inputs as Record<string, unknown>,
      confidence: String(r.confidence),
      expectedImpact: String(r.expected_impact),
      aiExplanation: (r.ai_explanation as string | null) ?? null,
      aiPromptVersion: (r.ai_prompt_version as string | null) ?? null,
      reviewStatus: String(r.review_status),
      implementationStatus: String(r.implementation_status),
      reviewNote: (r.review_note as string | null) ?? null,
      reviewedBy: (r.reviewed_by as string | null) ?? null,
      implementedAt: r.implemented_at ? new Date(String(r.implemented_at)).toISOString() : null,
      baseline: r.baseline_metrics ?? null,
      after28: r.post_metrics_28d ?? null,
      after56: r.post_metrics_56d ?? null,
      evidence: ev.filter((e) => e.recommendation_id === r.id).map((e) => ({ metric: String(e.metric), period: String(e.period), value: e.value === null ? null : Number(e.value), valueText: (e.value_text as string | null) ?? null, source: String(e.source), detail: e.detail })),
    })),
  };
}

export const patchSchema = z
  .object({
    reviewStatus: z.enum(["pending", "approved", "rejected"]).optional(),
    implementationStatus: z.enum(["not_started", "in_progress", "implemented", "dismissed"]).optional(),
    note: z.string().trim().max(1000).optional(),
  })
  .refine((v) => v.reviewStatus || v.implementationStatus || v.note !== undefined, "Nothing to change.");

export class NotFound extends Error {
  readonly status = 404;
}
export class InvalidTransition extends Error {
  readonly status = 409;
}

/** Review / implementation update. Returns before/after for the audit log. Baseline metrics are captured at "implemented". */
export async function updateRecommendation(id: string, patch: z.output<typeof patchSchema>, actor: string, now = new Date()) {
  const db = await getDb();
  const [before] = rowsOf<Record<string, unknown>>(await db.execute(sql`select id, review_status, implementation_status, review_note, url from seo_recommendations where id = ${id}`));
  if (!before) throw new NotFound("Recommendation not found.");
  if (patch.implementationStatus && patch.implementationStatus !== "not_started" && patch.implementationStatus !== "dismissed" && (patch.reviewStatus ?? before.review_status) !== "approved") {
    throw new InvalidTransition("Approve the recommendation before marking it in progress or implemented.");
  }
  let baseline: unknown = null;
  if (patch.implementationStatus === "implemented" && before.implementation_status !== "implemented" && before.url) baseline = await windowMetrics(db, String(before.url), addDays(now.toISOString().slice(0, 10), -28), addDays(now.toISOString().slice(0, 10), -1));
  await db.execute(sql`
    update seo_recommendations set
      review_status = coalesce(${patch.reviewStatus ?? null}, review_status),
      reviewed_by = case when ${patch.reviewStatus ?? null}::text is not null then ${actor} else reviewed_by end,
      reviewed_at = case when ${patch.reviewStatus ?? null}::text is not null then now() else reviewed_at end,
      review_note = coalesce(${patch.note ?? null}, review_note),
      implementation_status = coalesce(${patch.implementationStatus ?? null}, implementation_status),
      implemented_at = case when ${patch.implementationStatus ?? null}::text = 'implemented' and implemented_at is null then ${now.toISOString()}::timestamptz else implemented_at end,
      baseline_metrics = coalesce(baseline_metrics, ${baseline ? JSON.stringify(baseline) : null}::jsonb),
      updated_at = now()
    where id = ${id}`);
  const [after] = rowsOf<Record<string, unknown>>(await db.execute(sql`select id, review_status, implementation_status, review_note from seo_recommendations where id = ${id}`));
  return { before: { reviewStatus: before.review_status, implementationStatus: before.implementation_status, note: before.review_note }, after: { reviewStatus: after!.review_status, implementationStatus: after!.implementation_status, note: after!.review_note } };
}

/** Search Console metrics for one page over a window (clicks, impressions, CTR, impression-weighted position). */
export async function windowMetrics(db: Db, url: string, start: string, end: string) {
  const [r] = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select sum(clicks)::float8 as clicks, sum(impressions)::float8 as impressions,
        sum(position * impressions) filter (where position is not null) / nullif(sum(impressions) filter (where position is not null), 0) as position
      from seo_gsc_page_daily where page = ${url} and search_type = 'web' and date between ${start} and ${end}`),
  );
  const clicks = Number(r?.clicks ?? 0);
  const impressions = Number(r?.impressions ?? 0);
  return { start, end, clicks, impressions, ctr: impressions ? clicks / impressions : null, position: r?.position === null || r?.position === undefined ? null : Number(r.position), source: "gsc" };
}

/** Daily job: fill post-change metrics for implemented recommendations 28 and 56 days after implementation. */
export async function captureOutcomes(now = new Date()): Promise<number> {
  const db = await getDb();
  const today = now.toISOString().slice(0, 10);
  const due = rowsOf<{ id: string; url: string; implemented_at: string; post_metrics_28d: unknown; post_metrics_56d: unknown }>(
    await db.execute(sql`
      select id, url, implemented_at, post_metrics_28d, post_metrics_56d from seo_recommendations
      where implementation_status = 'implemented' and url is not null and implemented_at is not null
        and ((post_metrics_28d is null and implemented_at <= ${now.toISOString()}::timestamptz - interval '31 days')
          or (post_metrics_56d is null and implemented_at <= ${now.toISOString()}::timestamptz - interval '59 days'))`),
  );
  let n = 0;
  for (const r of due) {
    // +3 days so Search Console's lag has passed for the whole window.
    const start = addDays(new Date(r.implemented_at).toISOString().slice(0, 10), 1);
    if (!r.post_metrics_28d && addDays(start, 30) <= today) {
      await db.execute(sql`update seo_recommendations set post_metrics_28d = ${JSON.stringify(await windowMetrics(db, r.url, start, addDays(start, 27)))}::jsonb where id = ${r.id}`);
      n++;
    }
    if (!r.post_metrics_56d && addDays(start, 58) <= today) {
      await db.execute(sql`update seo_recommendations set post_metrics_56d = ${JSON.stringify(await windowMetrics(db, r.url, addDays(start, 28), addDays(start, 55)))}::jsonb where id = ${r.id}`);
      n++;
    }
  }
  return n;
}
