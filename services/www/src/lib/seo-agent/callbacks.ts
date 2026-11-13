import { sql } from "drizzle-orm";
import { diffWords } from "diff";
import { z } from "zod";
import { getDb, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
import { PermanentJobError } from "../jobs";
import { log } from "../log";
import { unsafeLinks } from "../posts";
import { blocksOf, linksIn, modelOutputSchema, toChanges, validateChangeSet, type Change, type Flag } from "../seo-intel/changeset";
import { docsFetcher } from "../seo-intel/crawler";
import { allowedCategories, buildPrompt, DRAFT_RULES, eligibleRecommendations, getDraft, loadBase, normalize, openDraft, renumber, reserveDraft, validationContext, type ExtraTask } from "../seo-intel/drafts";
import { linkChangesFor } from "../seo-intel/internal-links";
import { enqueueSeoJob } from "../seo-intel/jobs";
import { safeQueries } from "../seo-intel/llm";
import { publishWithApproval, verifyOnce } from "../seo-intel/publish";
import { generateRecommendations, windowMetrics } from "../seo-intel/recommendations";
import { DRAFT_CATEGORIES, getSeoSettings } from "../seo-intel/settings";
import { addDays } from "../seo-intel/sqlutil";
import { STYLE_GUIDE } from "../seo-intel/style-guide";
import { submitAfterPublish } from "../seo-intel/submission";
import { siteOrigin } from "../seo-intel/urls";
import { docsAllowlist } from "./config";
import { previewPercentFor, sitePreviewPercent, splitForMembers } from "../members";

/**
 * The web app side of the seo-agent's callback API (docs/seo/AGENTS.md "Callback API"). Served only on the
 * cluster-internal callback port (internal-server.ts) behind SEO_AGENT_CALLBACK_TOKEN.
 *
 * Every handler reuses a v2 function: prompts (buildPrompt, DRAFT_RULES, STYLE_GUIDE), validators (validateChangeSet),
 * the link planner, publishing, verification, submission, the SSRF-safe fetcher. The agent can write exactly one
 * thing here — its own drafts (save/status, only for drafts the agent owns) — and can publish only with an approval
 * an admin recorded (publishWithApproval). v4 additions are in callbacks-v4.ts.
 */
export class CallbackError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code = "error",
  ) {
    super(message);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uuid = (v: string, what = "id") => {
  if (!UUID.test(v)) throw new CallbackError(`Invalid ${what}.`, 400, "invalid");
  return v;
};

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw new CallbackError(`Invalid request: ${r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).slice(0, 5).join("; ")}`, 400, "invalid");
  return r.data;
}

const extraSchema = z.array(z.object({ id: z.string().max(80), category: z.enum(DRAFT_CATEGORIES), problem: z.string().max(500) })).max(20).default([]);

async function ga4For(db: Db, path: string, today: string) {
  const [r] = rowsOf<Record<string, number | null>>(
    await db.execute(sql`
      select sum(sessions)::float8 as sessions, sum(engaged_sessions)::float8 as engaged, sum(user_engagement_duration)::float8 as duration, sum(screen_page_views)::float8 as views
      from seo_ga4_page_daily where landing_page = ${path} and date between ${addDays(today, -28)} and ${addDays(today, -1)}`),
  );
  const sessions = Number(r?.sessions ?? 0);
  if (!sessions) return null;
  return { sessions, engagementRate: Number(r?.engaged ?? 0) / sessions, avgEngagementSeconds: Number(r?.duration ?? 0) / sessions, views: Number(r?.views ?? 0), window: "28d", source: "ga4" };
}

/** POST /articles/{id}/context — everything fetch_context needs, with v2's own prompt for this article. */
export async function articleContext(articleId: string, body: unknown, now = new Date()) {
  uuid(articleId, "article id");
  const b = parse(z.object({ recommendationIds: z.array(z.string()).max(20).optional(), extra: extraSchema }), body);
  const db = await getDb();
  const s = await getSeoSettings();
  let base;
  try {
    base = await loadBase(db, articleId);
  } catch (e) {
    if (e instanceof PermanentJobError) throw new CallbackError("Article not found.", 404, "not_found");
    throw e;
  }
  if (base.status !== "published") return { status: base.status, collection: base.collection };
  const recs = await eligibleRecommendations(db, s, articleId, base.collection, b.recommendationIds?.length ? b.recommendationIds : undefined);
  const extra = b.extra as ExtraTask[];
  const { user, categories: modelCategories } = await buildPrompt(db, base, recs, extra, []);
  const allCats = [...new Set([...recs.flatMap((r) => r.categories), ...extra.map((e) => e.category)])];
  const path = `/${base.collection}/${base.slug}`;
  const today = now.toISOString().slice(0, 10);
  const linksAllowed = s.links.enabled && (allCats.includes("internal_links") || allowedCategories(s, base.collection).has("internal_links"));
  return {
    status: base.status,
    collection: base.collection,
    path,
    prompt: { user, rules: DRAFT_RULES, styleGuide: STYLE_GUIDE, maxTokens: s.drafts.maxOutputTokens },
    recommendations: recs.map((r) => ({ id: r.id, category: r.category, problem: r.problem, categories: r.categories })),
    modelCategories,
    categories: allCats,
    linksAllowed,
    draftingEnabled: s.drafts.enabled,
    metrics: await windowMetrics(db, `${siteOrigin().origin}${path}`, addDays(today, -28), addDays(today, -1)),
    ga4: await ga4For(db, path, today),
  };
}

const MDX_H1 = /^#\s/m;

/** New-article document checks (the crew's NewArticleDraft). Errors block; flags are shown to the reviewer. */
export async function validateNewArticle(db: Db, articleId: string, doc: Record<string, unknown>) {
  const errors: string[] = [];
  const flags: Flag[] = [];
  const title = String(doc.title ?? "").trim();
  const meta = String(doc.meta_description ?? "").trim();
  const body = String(doc.body_mdx ?? "");
  const sources = (Array.isArray(doc.sources) ? doc.sources : []) as { url?: string }[];
  if (!title) errors.push("title: missing");
  if (title.length > 60) flags.push({ code: "title_length", severity: "warning", message: `Title is ${title.length} characters (≤ 60 shows fully in results).` });
  if (meta.length < 120 || meta.length > 155) flags.push({ code: "meta_length", severity: "warning", message: `Meta description is ${meta.length} characters (aim for 120–155).` });
  if (!body.trim()) errors.push("body: empty");
  if (MDX_H1.test(body.replace(/(```|~~~)[\s\S]*?\1/g, ""))) errors.push("body: contains an H1 (the title is the H1)");
  if (body.trim()) {
    try {
      const { compileMdx } = await import("../mdx/compile");
      await compileMdx(body);
    } catch (e) {
      errors.push(`body: MDX does not compile (${(e as Error).message.split("\n")[0]!.slice(0, 160)})`);
    }
  }
  for (const l of unsafeLinks(body)) errors.push(`body: link "${l.slice(0, 80)}" uses a scheme that is not allowed`);
  const known = new Set(rowsOf<{ p: string }>(await db.execute(sql`select '/' || collection || '/' || slug as p from post where status = 'published' and deleted_at is null`)).map((r) => r.p));
  const cited = new Set(sources.map((x) => String(x.url ?? "").replace(/\/+$/, "")));
  for (const href of linksIn(body)) {
    const u = href.split("#")[0]!.replace(/\/+$/, "");
    if (u.startsWith("/") && u && !known.has(u)) errors.push(`body: internal link ${u} does not point to a published article`);
    if (/^https?:/i.test(u) && !cited.has(u)) flags.push({ code: "unsourced_link", severity: "warning", message: `External link ${u.slice(0, 120)} is not among the cited sources.` });
  }
  const dup = rowsOf<{ id: string }>(await db.execute(sql`select id from post where deleted_at is null and status = 'published' and lower(coalesce(nullif(seo_title, ''), title)) = ${title.toLowerCase()} and id <> ${articleId} limit 1`));
  if (dup.length) errors.push("title: another published article already uses this title");
  for (const f of (Array.isArray(doc.fact_check_flags) ? doc.fact_check_flags : []) as { claim?: string; reason?: string; severity?: string }[]) {
    flags.push({ code: "needs_fact_check", severity: f.severity === "error" ? "error" : "warning", message: `${String(f.claim ?? "").slice(0, 160)}: ${String(f.reason ?? "").slice(0, 200)}` });
  }
  if (doc.incomplete) flags.push({ code: "incomplete", severity: "error", message: `The crew stopped early: ${String(doc.incomplete_reason ?? "limit reached")}. Regenerate or finish it in the editor.` });
  return { errors, flags, changes: [] as Change[] };
}

/** POST /articles/{id}/validate — model output → v2 changes (+ planner links) → v2 validators. */
export async function validate(articleId: string, body: unknown) {
  uuid(articleId, "article id");
  const db = await getDb();
  const b = parse(
    z.object({
      draftId: z.string(),
      kind: z.enum(["optimize", "new_article"]).default("optimize"),
      output: z.unknown().optional(),
      document: z.record(z.string(), z.unknown()).optional(),
      recommendationIds: z.array(z.string()).max(20).default([]),
      extra: extraSchema,
      includeLinks: z.boolean().default(false),
    }),
    body,
  );
  if (b.kind === "new_article") return validateNewArticle(db, articleId, b.document ?? {});
  const out = modelOutputSchema.safeParse(b.output);
  if (!out.success) return { errors: out.error.issues.slice(0, 10).map((i) => `schema: ${i.path.join(".")} ${i.message}`), flags: [], changes: [] };
  const s = await getSeoSettings();
  const base = await loadBase(db, articleId);
  const recs = await eligibleRecommendations(db, s, articleId, base.collection, b.recommendationIds.length ? b.recommendationIds : undefined);
  const cats = [...new Set([...recs.flatMap((r) => r.categories), ...b.extra.map((e) => e.category)])];
  const vctx = await validationContext(db, s, articleId, cats);
  const modelChanges = toChanges(out.data, base, 1);
  const links = b.includeLinks && s.links.enabled ? await linkChangesFor(db, s, base, articleId, recs.filter((r) => r.categories.includes("internal_links")).map((r) => `rec:${r.id}`), modelChanges.length + 1) : [];
  const all = renumber([...modelChanges, ...links]);
  const v = validateChangeSet(base, all, vctx, diffWords);
  return { errors: v.errors, flags: v.flags.filter((f) => !f.changeId), changes: all };
}

/** A draft a graph run owns (thread_id = draft id) and that is not approved/published. */
async function ownedDraft(draftId: string) {
  uuid(draftId, "draft id");
  const d = await getDraft(draftId);
  if (!d) throw new CallbackError("Draft not found.", 404, "not_found");
  if (d.thread_id !== draftId) throw new CallbackError("This draft is not managed by an agent run.", 403, "not_owned");
  return d;
}

const WRITABLE = ["generating", "ready_for_review", "generation_failed"];

/** POST /drafts/{id}/save — the only write an agent makes: its change set (or new-article document) for review. */
export async function saveDraft(draftId: string, body: unknown) {
  const d = await ownedDraft(draftId);
  if (!WRITABLE.includes(d.status)) throw new CallbackError(`This draft is ${d.status.replace(/_/g, " ")}.`, 409, "conflict");
  const b = parse(
    z.object({
      kind: z.enum(["optimize", "new_article"]).default("optimize"),
      document: z.record(z.string(), z.unknown()).optional(),
      changes: z.array(z.record(z.string(), z.unknown())).max(60),
      flags: z.array(z.object({ code: z.string().max(60), severity: z.enum(["error", "warning"]), message: z.string().max(1000) })).max(60).default([]),
      summary: z.string().max(2000).nullable().default(null),
      recommendationIds: z.array(z.string().regex(UUID)).max(20).default([]),
      categories: z.array(z.enum(DRAFT_CATEGORIES)).max(10).default([]),
      model: z.string().max(80).nullable().default(null),
      promptVersion: z.string().max(40).nullable().default(null),
      threadId: z.string().max(80),
    }),
    body,
  );
  if (b.threadId !== draftId) throw new CallbackError("Thread and draft do not match.", 400, "invalid");
  if (b.kind !== (d.kind ?? "optimize")) throw new CallbackError("Draft kind mismatch.", 400, "invalid");
  // Every change starts pending: decisions belong to the reviewer, never to the agent.
  const changes = b.changes.map((c) => ({ ...c, decision: "pending", edited: null }));
  const db = await getDb();
  await db.execute(sql`
    update seo_drafts set status = 'ready_for_review', changes = ${JSON.stringify(changes)}::jsonb, flags = ${JSON.stringify(b.flags)}::jsonb, summary = ${b.summary},
      recommendation_ids = ${`{${b.recommendationIds.join(",")}}`}::uuid[], categories = ${`{${b.categories.join(",")}}`}::text[], document = ${b.document ? JSON.stringify(b.document) : null}::jsonb,
      failure_reason = null, model = ${b.model}, prompt_version = ${b.promptVersion}, generated_at = now(), updated_at = now(), attempts = attempts + 1
    where id = ${draftId} and status in ('generating', 'ready_for_review', 'generation_failed')`);
  // Calendar articles go straight into their CMS draft post (no separate review step); see seo-intel/handoff.ts.
  if (b.kind === "new_article" && d.calendar_id) {
    const { handOffToCms } = await import("../seo-intel/handoff");
    await handOffToCms(draftId, db).catch((err) => log.warn("calendar draft handoff failed", { err, operation: "seo_handoff" }));
  }
  return { ok: true, changes: changes.length };
}

/** POST /drafts/{id}/status — generation outcomes only (generating / generation_failed / superseded). */
export async function setDraftStatus(draftId: string, body: unknown) {
  const d = await ownedDraft(draftId);
  const b = parse(z.object({ status: z.enum(["generating", "generation_failed", "superseded"]), reason: z.string().max(1000).nullable().optional() }), body);
  if (!WRITABLE.includes(d.status)) throw new CallbackError(`This draft is ${d.status.replace(/_/g, " ")}.`, 409, "conflict");
  const db = await getDb();
  await db.execute(sql`update seo_drafts set status = ${b.status}, failure_reason = ${b.reason ?? null}, updated_at = now() where id = ${draftId}`);
  return { ok: true };
}

/**
 * POST /drafts/{id}/publish. `idempotencyKey` (header Idempotency-Key) must be the approval id when given: a retry of
 * a publish that already committed (the agent's request timed out after the write) then gets the earlier success
 * back instead of a 403 for the used approval (publishWithApproval).
 */
export async function publish(draftId: string, body: unknown, idempotencyKey?: string) {
  uuid(draftId, "draft id");
  const b = parse(z.object({ approvalId: z.string().max(80), acceptedChangeIds: z.array(z.string().max(12)).max(200), edits: z.record(z.string().max(12), z.string().max(20_000)).default({}) }), body);
  if (idempotencyKey !== undefined && idempotencyKey !== b.approvalId) throw new CallbackError("Idempotency-Key must be the approval id.", 400, "invalid");
  // v4: the reviewer's edits travel with the decision; they must be exactly what the review UI stored on the draft
  // (the approval covers the stored draft, so a different edit would publish something the admin never saw).
  if (Object.keys(b.edits).length) {
    const d = await getDraft(draftId);
    const stored = new Map((d?.changes ?? []).map((c) => [c.id, c.edited ?? null]));
    const bad = Object.entries(b.edits).filter(([id, text]) => stored.get(id) !== text).map(([id]) => id);
    if (bad.length) throw new CallbackError(`Edits differ from the reviewed draft: ${bad.slice(0, 5).join(", ")}.`, 409, "approval_mismatch");
  }
  return publishWithApproval(draftId, b.approvalId, b.acceptedChangeIds, new Date(), { idempotent: idempotencyKey === b.approvalId });
}

export async function verify(draftId: string, body: unknown) {
  await ownedDraft(draftId);
  const b = parse(z.object({ attempt: z.number().int().min(1).max(10), final: z.boolean() }), body);
  return verifyOnce(draftId, b.attempt, b.final);
}

/** POST /drafts/{id}/submit — only for a published draft whose live page passed verification. */
export async function submit(draftId: string) {
  const d = await ownedDraft(draftId);
  const verification = (typeof d.verification === "string" ? JSON.parse(d.verification) : d.verification) as { state?: string } | null;
  if (d.status !== "published" || verification?.state !== "passed") throw new CallbackError("Only verified, published drafts are submitted.", 409, "conflict");
  const db = await getDb();
  const [p] = rowsOf<{ path: string }>(await db.execute(sql`select '/' || collection || '/' || slug as path from post where id = ${d.article_id}`));
  await submitAfterPublish(db, { draftId, articleId: d.article_id, path: p!.path, reason: "publish" });
  const rows = rowsOf<{ engine: string; kind: string; status: string }>(await db.execute(sql`select engine, kind, status from seo_search_submissions where draft_id = ${draftId} order by requested_at`));
  return { ok: true, submissions: rows };
}

export async function readArticle(ref: string) {
  const db = await getDb();
  const r = ref.trim();
  const m = /^\/?(blog|news|projects)\/([a-z0-9-]+)\/?$/.exec(r);
  const rows = rowsOf<{ id: string; title: string; path: string; body: string }>(
    await db.execute(sql`
      select id, title, '/' || collection || '/' || slug as path, body from post
      where status = 'published' and deleted_at is null and ${m ? sql`collection = ${m[1]} and slug = ${m[2]}` : UUID.test(r) ? sql`id = ${r}` : sql`false`} limit 1`),
  );
  if (!rows.length) throw new CallbackError("Article not found.", 404, "not_found");
  return { ...rows[0]!, body: rows[0]!.body.slice(0, 50_000) };
}

export async function publishedArticles() {
  const db = await getDb();
  const rows = rowsOf<{ id: string; title: string; path: string; body: string; members_only: boolean; preview_percent: number | null }>(await db.execute(sql`select id, title, '/' || collection || '/' || slug as path, body, members_only, preview_percent from post where status = 'published' and deleted_at is null and noindex = false order by published_at desc nulls last`));
  // The public "Ask" answers and MCP tools quote from this index, so a members-only article contributes only the part
  // every reader can see.
  const site = sitePreviewPercent(await (await import("../runtime-settings")).effectiveEnv());
  const articles = rows.map(({ members_only, preview_percent, ...a }) => (members_only ? { ...a, body: splitForMembers(a.body, previewPercentFor(preview_percent, site)).preview } : a));
  return { articles };
}

/** Search Console queries, 28 days, aggregated (never row-level), personal-data-looking queries removed. */
export async function gscQueries(q: URLSearchParams) {
  const db = await getDb();
  const limit = Math.min(50, Math.max(1, Number(q.get("limit") ?? 20) || 20));
  const articleId = q.get("articleId");
  const topic = (q.get("topic") ?? "").toLowerCase().replace(/[^a-z0-9 .+#-]/g, " ").trim().slice(0, 120);
  let where;
  if (articleId) {
    uuid(articleId, "article id");
    const [p] = rowsOf<{ path: string }>(await db.execute(sql`select '/' || collection || '/' || slug as path from post where id = ${articleId}`));
    if (!p) return { queries: [] };
    where = sql`page = ${`${siteOrigin().origin}${p.path}`}`;
  } else if (topic) {
    const words = topic.split(/\s+/).filter((w) => w.length > 1).slice(0, 6);
    where = words.length ? sql.join(words.map((w) => sql`query ilike ${`%${w}%`}`), sql` and `) : sql`false`;
  } else return { queries: [] };
  const rows = rowsOf<{ query: string; impressions: number; clicks: number; position: number | null }>(
    await db.execute(sql`
      select query, sum(impressions)::float8 as impressions, sum(clicks)::float8 as clicks,
        sum(position * impressions) filter (where position is not null) / nullif(sum(impressions) filter (where position is not null), 0) as position
      from seo_gsc_query_daily where search_type = 'web' and ${where} and date > (select max(date) - 28 from seo_gsc_query_daily)
      group by query order by impressions desc limit ${limit}`),
  );
  const keep = new Set(safeQueries(rows.map((r) => r.query)));
  return { queries: rows.filter((r) => keep.has(r.query)).map((r) => ({ query: r.query, impressions: Number(r.impressions), clicks: Number(r.clicks), position: r.position === null ? null : Number(Number(r.position).toFixed(1)) })) };
}

/** POST /fetch-docs — the crew's only way out to the internet: allowlisted documentation domains, SSRF-guarded. */
export async function fetchDocs(body: unknown, fetcher = docsFetcher(docsAllowlist(), { timeoutMs: 15_000, maxBytes: 1_500_000, maxRedirects: 3 })) {
  const b = parse(z.object({ url: z.string().url().max(2000) }), body);
  const r = await fetcher(b.url);
  if (r.error) return { status: r.status, finalUrl: r.finalUrl, error: r.error };
  const type = r.headers["content-type"] ?? "";
  if (!/text\/html|text\/plain|application\/xhtml/.test(type)) return { status: r.status, finalUrl: r.finalUrl, error: `Unsupported content type ${type.slice(0, 60)}.` };
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(r.body)?.[1]?.trim().slice(0, 200) ?? "";
  return { status: r.status, finalUrl: r.finalUrl, title, body: r.body.slice(0, 300_000), truncated: r.truncated };
}

/**
 * POST /weekly/candidates — weekly_recommendations' prepare step: freshness (queue a Search Console sync when the
 * data is stale), v1 rules + scoring, then the top N published articles with eligible recommendations and **no open
 * draft**, each with a draft reserved for its graph run.
 */
export async function weeklyCandidates(body: unknown, now = new Date()) {
  const b = parse(z.object({ limit: z.number().int().min(1).max(50).default(10) }), body);
  const db = await getDb();
  const s = await getSeoSettings();
  const [last] = rowsOf<{ at: string | null }>(await db.execute(sql`select max(finished_at)::text as at from seo_sync_jobs where job_type = 'gsc_sync' and status in ('succeeded', 'partial')`));
  const fresh = Boolean(last?.at && now.getTime() - new Date(last.at).getTime() < 3 * 86_400_000);
  if (!fresh) await enqueueSeoJob({ type: "gsc_sync", trigger: "schedule" }, `seo:gsc_sync:agent:${now.toISOString().slice(0, 10)}`);
  const recs = await generateRecommendations({ llm: false, now });
  const candidates = rowsOf<{ article_id: string }>(
    await db.execute(sql`
      select r.article_id from seo_recommendations r join post p on p.id = r.article_id
      where r.review_status in ('pending', 'approved') and r.implementation_status <> 'done' and p.status = 'published' and p.deleted_at is null
        and not exists (select 1 from seo_drafts d where d.article_id = r.article_id and d.status in ('generating', 'ready_for_review', 'generation_failed', 'scheduled', 'publishing'))
      group by r.article_id order by max(r.priority_score) desc limit ${b.limit * 3}`),
  );
  const items: { articleId: string; draftId: string; recommendationIds: string[] }[] = [];
  for (const { article_id } of candidates) {
    if (items.length >= b.limit) break;
    const base = await loadBase(db, article_id);
    const eligible = await eligibleRecommendations(db, s, article_id, base.collection);
    if (!eligible.length) continue;
    const d = await reserveDraft(db, article_id, base, "weekly", { threadManaged: true });
    if (d.status !== "generating" || d.thread_id !== d.id) continue; // someone else got there first
    items.push({ articleId: article_id, draftId: d.id, recommendationIds: eligible.map((r) => r.id) });
  }
  return { items, fresh, recommendations: { created: recs.created, refreshed: recs.refreshed } };
}

/** POST /articles/{id}/links — merge planner links (fed with semantic scores) into the article's open draft. */
export async function planArticleLinks(articleId: string, body: unknown) {
  uuid(articleId, "article id");
  const b = parse(z.object({ candidates: z.array(z.object({ path: z.string().max(300), score: z.number().min(0).max(2) })).max(50) }), body);
  const db = await getDb();
  const s = await getSeoSettings();
  if (!s.links.enabled) return { added: 0, reason: "Internal linking is off (Settings → Links)." };
  const base = await loadBase(db, articleId);
  if (base.status !== "published") return { added: 0, reason: "Article is not published." };
  let d = await openDraft(db, articleId);
  if (d && !["ready_for_review", "generating"].includes(d.status)) return { added: 0, reason: `Open draft is ${d.status}.` };
  if (d && d.changes.some((c) => c.type === "internal_link")) return { added: 0, reason: "The open draft already has link changes." };
  const semantic = new Map(b.candidates.map((c) => [c.path, c.score]));
  const keep = d ? d.changes : [];
  const links = await linkChangesFor(db, s, base, articleId, [], keep.length + 1, semantic);
  if (!links.length) return { added: 0, reason: "No link passes the limits." };
  d ??= await reserveDraft(db, articleId, base, "links");
  const all = renumber([...keep, ...links]);
  const v = validateChangeSet(d.base_snapshot, all, await validationContext(db, s, articleId, ["internal_links"]), diffWords);
  if (v.errors.length) {
    log.warn("seo agent link plan invalid", { operation: "seo_agent_links", outcome: "invalid" });
    return { added: 0, reason: v.errors.slice(0, 3).join("; ") };
  }
  await db.execute(sql`
    update seo_drafts set status = 'ready_for_review', changes = ${JSON.stringify(all)}::jsonb, flags = ${JSON.stringify(v.flags.filter((f) => !f.changeId))}::jsonb,
      summary = coalesce(summary, 'Internal link suggestions.'), categories = array(select distinct unnest(categories || '{internal_links}'::text[])), updated_at = now()
    where id = ${d.id}`);
  return { added: links.length, draftId: d.id };
}

/** GET /calendar/{id}/brief — the content-gap idea the crew writes up (and its CMS draft post). */
export async function calendarBrief(calendarId: string) {
  uuid(calendarId, "calendar id");
  const db = await getDb();
  const [item] = rowsOf<Record<string, unknown>>(await db.execute(sql`select id, title, kind, category, brief, post_id, status from seo_editorial_calendar where id = ${calendarId}`));
  if (!item) throw new CallbackError("Calendar item not found.", 404, "not_found");
  const brief = (typeof item.brief === "string" ? JSON.parse(item.brief) : item.brief ?? {}) as Record<string, unknown>;
  return { id: calendarId, postId: item.post_id ?? null, title: String(item.title), kind: String(item.kind), category: item.category ?? null, styleGuide: STYLE_GUIDE, ...brief };
}

/** Exported for tests and the route table. */
export const _internal = { normalize, blocksOf };
