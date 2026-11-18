import { sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
import { eq } from "drizzle-orm";
import { rowToForm, type PostFormValue } from "../post-form";
import type { Actor } from "../posts";
import { clearAutosave, getAutosave, saveAutosave } from "../revisions";
import { auditArticle, headingsOf } from "./audit-article";
import { loadArticles } from "./data";
import { llmJson, safeQueries } from "./llm";
import { getSeoSettings } from "./settings";

/**
 * Field-level optimisation proposals for one article, and their review.
 *
 * Accepting a proposal NEVER edits or publishes the post. It writes the proposed value into the accepting admin's
 * editor working copy (the CMS's own `autosave`, docs/seo/DECISIONS.md D-06). The editor then offers "You have
 * autosaved changes … Restore"; a human reviews the full diff there and saves or publishes with the editor's normal
 * buttons, which create a revision. Rollback restores the previous working copy (or reverts that field in it).
 * This module deliberately imports nothing that can write to `post`.
 */
export const OPTIMIZE_PROMPT_VERSION = "seo-optimize-v1";
export const FIELDS = ["seoTitle", "seoDescription", "body"] as const;
export type Field = (typeof FIELDS)[number];

export class OptimizeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type Proposal = { field: Field; current: string | null; proposed: string; rationale: string; source: "rule" | "llm"; recommendationId: string | null };

const trimAt = (s: string, max: number) => {
  if (s.length <= max) return s;
  const cut = s.slice(0, max + 1);
  const i = cut.lastIndexOf(" ");
  return (i > max * 0.6 ? cut.slice(0, i) : s.slice(0, max)).replace(/[\s,;:–-]+$/, "");
};
const capFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

async function postRow(db: Db, id: string) {
  const [row] = await db.select().from(schema.post).where(eq(schema.post.id, id));
  if (!row || row.deletedAt) throw new OptimizeError("Article not found.", 404);
  return row;
}

async function topQueries(db: Db, url: string, limit = 10) {
  return rowsOf<{ query: string; impressions: number; clicks: number; position: number | null }>(
    await db.execute(sql`
      select query, sum(impressions)::float8 as impressions, sum(clicks)::float8 as clicks,
        sum(position * impressions) filter (where position is not null) / nullif(sum(impressions) filter (where position is not null), 0) as position
      from seo_gsc_query_daily where page = ${url} and search_type = 'web' and date > (select max(date) - 28 from seo_gsc_query_daily)
      group by query order by impressions desc limit ${limit}`),
  ).map((r) => ({ ...r, impressions: Number(r.impressions), clicks: Number(r.clicks), position: r.position === null ? null : Number(r.position) }));
}

const llmSchema = z.object({
  titles: z.array(z.string().min(10).max(70)).min(1).max(3),
  metaDescription: z.string().min(50).max(170),
  rationale: z.string().min(10).max(600),
});
const llmJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["titles", "metaDescription", "rationale"],
  properties: { titles: { type: "array", items: { type: "string" } }, metaDescription: { type: "string" }, rationale: { type: "string" } },
};

/** Generate proposals (rules always; LLM alternatives when enabled). Replaces this article's still-open proposals. */
export async function proposeOptimizations(articleId: string, opts: { llm?: boolean; fetchImpl?: typeof fetch } = {}): Promise<number> {
  const db = await getDb();
  const s = await getSeoSettings();
  const row = await postRow(db, articleId);
  const article = (await loadArticles(db, { includeDrafts: true })).find((a) => a.id === articleId)!;
  const queries = await topQueries(db, article.url);
  const recs = rowsOf<{ id: string; category: string; query: string | null }>(await db.execute(sql`select id, category, query from seo_recommendations where article_id = ${articleId} and review_status <> 'rejected' order by priority_score desc`));
  const lowCtr = recs.find((r) => r.category === "low_ctr" && r.query);
  const linkRec = recs.find((r) => r.category === "internal_links");
  const proposals: Proposal[] = [];
  const currentTitle = row.seoTitle ?? null;
  const effectiveTitle = (row.seoTitle || row.title).trim();
  const effectiveDesc = (row.seoDescription || row.description).trim();

  // Search title
  if (effectiveTitle.length > 60) proposals.push({ field: "seoTitle", current: currentTitle, proposed: trimAt(effectiveTitle, 60), rationale: `The search title is ${effectiveTitle.length} characters; this keeps it within ~60 so Google is less likely to truncate it.`, source: "rule", recommendationId: null });
  if (lowCtr?.query && !effectiveTitle.toLowerCase().includes(lowCtr.query.toLowerCase())) {
    const q = safeQueries([lowCtr.query])[0];
    if (q) proposals.push({ field: "seoTitle", current: currentTitle, proposed: trimAt(`${capFirst(q)}: ${row.title}`, 60), rationale: `"${q}" brings impressions but few clicks; leading with the searcher's words can make the result easier to recognise.`, source: "rule", recommendationId: lowCtr.id });
  }
  // Meta description
  if (effectiveDesc.length < 70 || effectiveDesc.length > 160) {
    const base = effectiveDesc.length > 160 ? trimAt(effectiveDesc, 155) : effectiveDesc;
    if (base !== effectiveDesc) proposals.push({ field: "seoDescription", current: row.seoDescription ?? null, proposed: base, rationale: `The description is ${effectiveDesc.length} characters; trimmed to a complete phrase under 160.`, source: "rule", recommendationId: null });
  }
  // Body: H1 inside the body → H2 (the title is already the page's H1). Deterministic and reviewable in the diff.
  if (headingsOf(row.body).some((h) => h.level === 1)) {
    let fence = false;
    const fixed = row.body.split("\n").map((l) => {
      if (/^\s*(```|~~~)/.test(l)) fence = !fence;
      return !fence && /^#\s+/.test(l) ? `#${l}` : l;
    }).join("\n");
    proposals.push({ field: "body", current: row.body, proposed: fixed, rationale: "Demote H1 headings in the body to H2: the article title is the page's only H1.", source: "rule", recommendationId: null });
  }
  // Body: related reading from internal-link suggestions.
  const links = rowsOf<{ title: string; collection: string; slug: string }>(
    await db.execute(sql`select t.title, t.collection, t.slug from seo_internal_link_suggestions l join post t on t.id = l.target_article_id where l.source_article_id = ${articleId} and l.status = 'suggested' order by l.score desc limit ${s.thresholds.maxLinksPerPage}`),
  );
  if (links.length) {
    const section = `\n\n## Related reading\n\n${links.map((l) => `- [${l.title}](/${l.collection}/${l.slug})`).join("\n")}\n`;
    proposals.push({ field: "body", current: row.body, proposed: row.body.replace(/\s+$/, "") + section, rationale: "Link related articles that readers of this one also search for. Prefer moving each link into the paragraph where the topic comes up.", source: "rule", recommendationId: linkRec?.id ?? null });
  }
  // LLM alternatives (optional; validated; never auto-applied).
  if (opts.llm !== false && s.llm.enabled) {
    const audit = auditArticle(article);
    const res = await llmJson(
      db,
      s,
      {
        promptVersion: OPTIMIZE_PROMPT_VERSION,
        task: "Propose up to 3 alternative search titles (≤ 60 characters, accurate, no clickbait, no year unless in the data) and one meta description (120–155 characters) for this article, based only on the data. Explain the reasoning briefly.",
        blocks: [
          { name: "article", content: { title: row.title, seoTitle: row.seoTitle, description: row.description, headings: audit.headings.slice(0, 30).map((h) => `${"#".repeat(h.level)} ${h.text}`), category: row.category, tags: row.tags } },
          { name: "search_queries", content: safeQueries(queries.map((q) => q.query)).map((q) => ({ query: q, ...queries.find((x) => x.query === q) })) },
        ],
        jsonSchema: llmJsonSchema,
        schema: llmSchema,
      },
      { fetchImpl: opts.fetchImpl },
    );
    if (res.ok) {
      for (const t of res.value.titles) proposals.push({ field: "seoTitle", current: currentTitle, proposed: t.trim(), rationale: `AI-generated alternative (verify accuracy): ${res.value.rationale}`, source: "llm", recommendationId: lowCtr?.id ?? null });
      proposals.push({ field: "seoDescription", current: row.seoDescription ?? null, proposed: res.value.metaDescription.trim(), rationale: `AI-generated (verify accuracy): ${res.value.rationale}`, source: "llm", recommendationId: null });
    }
  }
  await db.execute(sql`delete from seo_article_optimizations where article_id = ${articleId} and status = 'proposed'`);
  for (const p of proposals) {
    await db.execute(sql`
      insert into seo_article_optimizations (article_id, recommendation_id, field, current_value, proposed_value, rationale, source, prompt_version, base_version)
      values (${articleId}, ${p.recommendationId}, ${p.field}, ${p.current}, ${p.proposed}, ${p.rationale}, ${p.source}, ${p.source === "llm" ? OPTIMIZE_PROMPT_VERSION : null}, ${row.version})`);
  }
  return proposals.length;
}

export async function listOptimizations(articleId: string) {
  const db = await getDb();
  return rowsOf<Record<string, unknown>>(await db.execute(sql`select * from seo_article_optimizations where article_id = ${articleId} order by status = 'proposed' desc, created_at desc limit 100`)).map((r) => ({
    id: String(r.id),
    field: String(r.field) as Field,
    current: (r.current_value as string | null) ?? null,
    proposed: String(r.proposed_value),
    rationale: String(r.rationale),
    source: String(r.source),
    promptVersion: (r.prompt_version as string | null) ?? null,
    baseVersion: Number(r.base_version),
    status: String(r.status),
    decidedBy: (r.decided_by as string | null) ?? null,
    decidedAt: r.decided_at ? new Date(String(r.decided_at)).toISOString() : null,
  }));
}

async function loadOptimization(db: Db, id: string) {
  const [o] = rowsOf<Record<string, unknown>>(await db.execute(sql`select * from seo_article_optimizations where id = ${id}`));
  if (!o) throw new OptimizeError("Proposal not found.", 404);
  return o;
}

const fieldValue = (v: PostFormValue, f: Field) => (v[f] ?? null) as string | null;

/** Accept: proposed value → the actor's editor working copy. The post row is not touched. */
export async function acceptOptimization(id: string, actor: Actor) {
  const db = await getDb();
  const o = await loadOptimization(db, id);
  if (o.status !== "proposed") throw new OptimizeError(`This proposal is already ${o.status}.`, 409);
  const field = String(o.field) as Field;
  const post = await postRow(db, String(o.article_id));
  const live = rowToForm(post);
  // The article changed since the proposal was made and this field no longer matches what the proposal was based on.
  if (post.version !== Number(o.base_version) && fieldValue(live, field) !== ((o.current_value as string | null) ?? null)) {
    throw new OptimizeError("The article changed since this proposal was made. Generate proposals again.", 409);
  }
  const existing = await getAutosave(actor, "post", post.id);
  const workingCopy: PostFormValue = existing ? rowToForm(existing.payload as Record<string, unknown>) : live;
  const next: PostFormValue = { ...workingCopy, [field]: String(o.proposed_value) };
  await saveAutosave(actor, "post", post.id, existing?.baseVersion ?? post.version, next);
  await db.execute(sql`
    update seo_article_optimizations set status = 'accepted', decided_by = ${actor.label}, decided_at = now(),
      previous_working_copy = ${existing ? JSON.stringify({ baseVersion: existing.baseVersion, payload: existing.payload }) : null}::jsonb
    where id = ${id}`);
  return { articleId: post.id, field, editorUrl: `/admin/posts/${post.id}` };
}

export async function rejectOptimization(id: string, actor: Actor) {
  const db = await getDb();
  const o = await loadOptimization(db, id);
  if (o.status !== "proposed") throw new OptimizeError(`This proposal is already ${o.status}.`, 409);
  await db.execute(sql`update seo_article_optimizations set status = 'rejected', decided_by = ${actor.label}, decided_at = now() where id = ${id}`);
  return { articleId: String(o.article_id) };
}

/**
 * Rollback of an accepted proposal, through the same versioning:
 * - working copy still holds exactly what accept wrote → restore the previous working copy (or discard it if there was none);
 * - otherwise (edited further, or already saved) → write a working copy with that field set back to its old value, for a
 *   human to review and save. Committed revisions are never rewritten; the editor's revision history stays intact.
 */
export async function rollbackOptimization(id: string, actor: Actor) {
  const db = await getDb();
  const o = await loadOptimization(db, id);
  if (o.status !== "accepted") throw new OptimizeError("Only accepted proposals can be rolled back.", 409);
  const field = String(o.field) as Field;
  const post = await postRow(db, String(o.article_id));
  const wc = await getAutosave(actor, "post", post.id);
  const prev = o.previous_working_copy as { baseVersion: number; payload: Record<string, unknown> } | null;
  const untouched = wc && fieldValue(rowToForm(wc.payload as Record<string, unknown>), field) === String(o.proposed_value);
  if (untouched && prev) await saveAutosave(actor, "post", post.id, prev.baseVersion, prev.payload);
  else if (untouched && !prev && post.version === wc!.baseVersion && JSON.stringify({ ...rowToForm(wc!.payload as Record<string, unknown>), [field]: fieldValue(rowToForm(post), field) }) === JSON.stringify(rowToForm(post))) await clearAutosave(actor, "post", post.id);
  else {
    const base: PostFormValue = wc ? rowToForm(wc.payload as Record<string, unknown>) : rowToForm(post);
    await saveAutosave(actor, "post", post.id, wc?.baseVersion ?? post.version, { ...base, [field]: (o.current_value as string | null) ?? null });
  }
  await db.execute(sql`update seo_article_optimizations set status = 'rolled_back', decided_by = ${actor.label}, decided_at = now() where id = ${id}`);
  return { articleId: post.id, field };
}

/** Line diff (LCS) for the side-by-side view. */
export function lineDiff(a: string, b: string): { type: "same" | "del" | "add"; text: string }[] {
  const x = a.split("\n");
  const y = b.split("\n");
  if (x.length * y.length > 4_000_000) return [...x.map((t) => ({ type: "del" as const, text: t })), ...y.map((t) => ({ type: "add" as const, text: t }))];
  const dp = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) dp[i]![j] = x[i] === y[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: { type: "same" | "del" | "add"; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      out.push({ type: "same", text: x[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) out.push({ type: "del", text: x[i++]! });
    else out.push({ type: "add", text: y[j++]! });
  }
  while (i < x.length) out.push({ type: "del", text: x[i++]! });
  while (j < y.length) out.push({ type: "add", text: y[j++]! });
  return out;
}
