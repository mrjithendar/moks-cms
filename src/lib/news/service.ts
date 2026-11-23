import "server-only";
import { sql } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
import { audit } from "../audit";
import type { Actor } from "../posts";
import { seedCategories } from "../taxonomy-admin";
import { cronError, nextRuns } from "./cron";
import { imageProfileInput, jobConfigSchema, jobInput, MAX_NEWS_JOBS, newsSettingsSchema, sourceInput, writingProfileInput, type JobInput, type NewsSettings } from "./schema";

/**
 * News desk admin service (docs/news/JOBS.md): jobs with immutable versions, profiles with versions, sources, topics,
 * settings, run history read models and the review feedback the learning loop trains on. Every mutation is audit-logged
 * (`news.*`). Nothing here generates or publishes content: runs are started through the seo-agent (agent.ts).
 */
export class NewsError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly issues: string[] = [],
  ) {
    super(message);
  }
}

const j = (v: unknown) => JSON.stringify(v ?? null);
const asJson = <T>(v: unknown, fallback: T): T => (v == null ? fallback : typeof v === "string" ? (JSON.parse(v) as T) : (v as T));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const pgText = (a: string[]) => `{${a.map((x) => `"${x.replace(/(["\\])/g, "\\$1")}"`).join(",")}}`;

function parse<T>(schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } }, raw: unknown): T {
  const r = schema.safeParse(raw);
  if (!r.success) throw new NewsError("Invalid input.", 400, r.error.issues.map((i) => `${i.path.map(String).join(".")}: ${i.message}`).slice(0, 20));
  return r.data;
}

// --- defaults -------------------------------------------------------------------------------------------------------

export const DEFAULT_WRITING = {
  key: "news-default",
  name: "Default news analysis",
  system_style: "Plain, direct English for working DevOps, cloud and AI engineers. Lead with what changed in one or two sentences, then spend most of the article on what it means in practice. Short paragraphs. No hype.",
  structure_template: "Opening: what changed (1–2 short paragraphs).\n## Why it matters\n## Who is affected\n## What to do\n(Optional) ## Migration notes — only when a source describes a migration.",
  tone: "Calm, precise, practical. Explain trade-offs. Never speculate beyond the sources.",
  audience: "Platform, SRE, cloud and AI engineers who run production systems.",
  banned_phrases: ["game-changer", "game changer", "revolutionary", "in today's fast-paced world", "unlock the power", "delve", "seamlessly", "cutting-edge", "it's important to note"],
  required_sections: ["Why it matters", "What to do"],
};
export const DEFAULT_IMAGE = { key: "cover-template", name: "Template cover (free)", provider: "template" as const, style_prompt: "Flat, geometric technical illustration; abstract infrastructure shapes; calm gradients.", negative_prompt: "photorealistic people, faces, hands, logos, brand marks, text, letters, UI screenshots" };

/** First visit: the CMS categories become news topics (mapped 1:1), and the default profiles exist. Idempotent. */
export async function ensureNewsDefaults(db?: Db) {
  const d = db ?? (await getDb());
  await seedCategories();
  await d.execute(sql`
    insert into news_topics (slug, label, category_slug, keywords, tags, sort)
    select c.slug, c.label, c.slug, '{}'::text[], '{}'::text[], c.sort from category c on conflict (slug) do nothing`);
  await d.execute(sql`
    insert into news_writing_profiles (key, version, name, status, system_style, structure_template, tone, audience, banned_phrases, required_sections, created_by)
    values (${DEFAULT_WRITING.key}, 1, ${DEFAULT_WRITING.name}, 'active', ${DEFAULT_WRITING.system_style}, ${DEFAULT_WRITING.structure_template}, ${DEFAULT_WRITING.tone}, ${DEFAULT_WRITING.audience}, ${pgText(DEFAULT_WRITING.banned_phrases)}::text[], ${pgText(DEFAULT_WRITING.required_sections)}::text[], 'system')
    on conflict (key, version) do nothing`);
  await d.execute(sql`
    insert into news_image_profiles (key, version, name, status, provider, style_prompt, negative_prompt, created_by)
    values (${DEFAULT_IMAGE.key}, 1, ${DEFAULT_IMAGE.name}, 'active', 'template', ${DEFAULT_IMAGE.style_prompt}, ${DEFAULT_IMAGE.negative_prompt}, 'system')
    on conflict (key, version) do nothing`);
}

// --- settings -------------------------------------------------------------------------------------------------------

export async function getNewsSettings(db?: Db): Promise<NewsSettings> {
  const d = db ?? (await getDb());
  const [r] = rowsOf<{ value: unknown }>(await d.execute(sql`select value from setting where key = 'news'`));
  const v = newsSettingsSchema.safeParse(asJson(r?.value, {}));
  return v.success ? v.data : newsSettingsSchema.parse({});
}

/**
 * Saves part of the row: the given fields are merged into what is saved (`quality` field by field), because each
 * group is edited on its own page (lib/news/settings-fields.ts). Unknown fields are refused, as before.
 */
export async function saveNewsSettings(actor: Actor, raw: unknown) {
  const db = await getDb();
  const before = await getNewsSettings(db);
  const patch = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const quality = patch.quality && typeof patch.quality === "object" ? { ...before.quality, ...(patch.quality as Record<string, unknown>) } : before.quality;
  const s = parse(newsSettingsSchema, { ...before, ...patch, quality });
  await db.execute(sql`insert into setting (key, value, updated_at, updated_by) values ('news', ${j(s)}::jsonb, now(), ${actor.label}) on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by`);
  await audit(actor, "news.settings.save", "news", { before, after: s });
  return s;
}

// --- jobs -----------------------------------------------------------------------------------------------------------

export type JobRow = { id: string; name: string; description: string; enabled: boolean; cron: string; timezone: string; mode: string; writing_profile_key: string; image_profile_key: string; review_priority: number; config: JobInput["config"]; version: number; next_run_at: string | null; last_run_at: string | null; created_at: string; updated_at: string };

function rowToJob(r: Record<string, unknown>): JobRow {
  return { ...(r as unknown as JobRow), config: jobConfigSchema.parse(asJson(r.config, {})) };
}

/** The snapshot stored per version: every user-editable field. */
function snapshotOf(j: JobInput) {
  return { name: j.name, description: j.description, enabled: j.enabled, cron: j.cron, timezone: j.timezone, mode: j.mode, writing_profile_key: j.writing_profile_key, image_profile_key: j.image_profile_key, review_priority: j.review_priority, config: j.config };
}

/** Flat diff of two snapshots: [{path, before, after}] for every changed leaf (arrays compared whole). */
export function diffSnapshots(a: unknown, b: unknown, path = ""): { path: string; before: unknown; after: unknown }[] {
  const isObj = (v: unknown) => v !== null && typeof v === "object" && !Array.isArray(v);
  if (isObj(a) && isObj(b)) {
    const keys = [...new Set([...Object.keys(a as object), ...Object.keys(b as object)])].sort();
    return keys.flatMap((k) => diffSnapshots((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k));
  }
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null) ? [] : [{ path, before: a ?? null, after: b ?? null }];
}

/** The editable fields of a stored job (rows carry ids and timestamps that the strict input schema refuses). */
function pickJob(r: JobRow) {
  return snapshotOf({ name: r.name, description: r.description, enabled: r.enabled, cron: r.cron, timezone: r.timezone, mode: r.mode as JobInput["mode"], writing_profile_key: r.writing_profile_key, image_profile_key: r.image_profile_key, review_priority: r.review_priority, config: r.config });
}

function validateJob(input: JobInput) {
  const err = cronError(input.cron, input.timezone);
  if (err) throw new NewsError(`Schedule: ${err}`, 400, [`cron: ${err}`]);
}

export async function listJobs(db?: Db) {
  const d = db ?? (await getDb());
  return rowsOf<Record<string, unknown>>(
    await d.execute(sql`
      select j.*, (select row_to_json(r) from (select id, status, started_at, finished_at, counters, cost_usd, image_cost_usd, error_summary from news_runs where job_id = j.id and kind = 'job' order by started_at desc limit 1) r) as last_run,
        (select count(*)::int from news_articles a where a.job_id = j.id and a.created_at >= date_trunc('day', now() at time zone j.timezone) at time zone j.timezone and a.status in ('drafting', 'ready_for_review', 'published', 'incomplete')) as drafts_today,
        (select coalesce(sum(cost_usd + image_cost_usd), 0)::float8 from news_runs r where r.job_id = j.id and r.started_at >= date_trunc('month', now() at time zone j.timezone) at time zone j.timezone) as month_cost
      from news_jobs j where j.deleted_at is null order by j.name`),
  ).map((r) => ({ ...rowToJob(r), last_run: asJson(r.last_run, null), drafts_today: Number(r.drafts_today ?? 0), month_cost: Number(r.month_cost ?? 0), next_runs: safeNext(String(r.cron), String(r.timezone)) }));
}

function safeNext(cron: string, tz: string) {
  try {
    return nextRuns(cron, tz, new Date(), 1).map((d) => d.toISOString());
  } catch {
    return [];
  }
}

export async function getJob(id: string, db?: Db) {
  const d = db ?? (await getDb());
  const [r] = rowsOf<Record<string, unknown>>(await d.execute(sql`select * from news_jobs where id = ${id} and deleted_at is null`));
  return r ? rowToJob(r) : null;
}

export async function createJob(actor: Actor, raw: unknown) {
  const input = parse(jobInput, raw);
  validateJob(input);
  const db = await getDb();
  const [{ n }] = rowsOf<{ n: number }>(await db.execute(sql`select count(*)::int as n from news_jobs where deleted_at is null`)) as [{ n: number }];
  if (n >= MAX_NEWS_JOBS) throw new NewsError(`At most ${MAX_NEWS_JOBS} content flows (keeps the metrics' label bounded). Delete or reuse one.`, 409);
  const snap = snapshotOf(input);
  const [row] = rowsOf<{ id: string }>(
    await db.execute(sql`
      insert into news_jobs (name, description, enabled, cron, timezone, mode, writing_profile_key, image_profile_key, review_priority, config, version, created_by)
      values (${input.name}, ${input.description}, ${input.enabled}, ${input.cron}, ${input.timezone}, ${input.mode}, ${input.writing_profile_key}, ${input.image_profile_key}, ${input.review_priority}, ${j(input.config)}::jsonb, 1, ${actor.label}) returning id`),
  );
  await db.execute(sql`insert into news_job_versions (job_id, version, snapshot, diff, note, created_by) values (${row!.id}, 1, ${j(snap)}::jsonb, '[]'::jsonb, 'created', ${actor.label})`);
  await audit(actor, "news.job.create", row!.id, { name: input.name });
  return getJob(row!.id, db);
}

/** Every save is a new immutable version with its diff against the previous one; runs record the version they used. */
export async function updateJob(actor: Actor, id: string, raw: unknown, note: string | null = null) {
  const input = parse(jobInput, raw);
  validateJob(input);
  const db = await getDb();
  const current = await getJob(id, db);
  if (!current) throw new NewsError("Content flow not found.", 404);
  const before = pickJob(current);
  const after = snapshotOf(input);
  const diff = diffSnapshots(before, after);
  if (!diff.length) return { job: current, version: current.version, changed: false };
  const version = current.version + 1;
  await db.execute(sql`
    update news_jobs set name = ${input.name}, description = ${input.description}, enabled = ${input.enabled}, cron = ${input.cron}, timezone = ${input.timezone}, mode = ${input.mode},
      writing_profile_key = ${input.writing_profile_key}, image_profile_key = ${input.image_profile_key}, review_priority = ${input.review_priority}, config = ${j(input.config)}::jsonb,
      version = ${version}, updated_at = now(), next_run_at = null where id = ${id} and version = ${current.version}`);
  await db.execute(sql`insert into news_job_versions (job_id, version, snapshot, diff, note, created_by) values (${id}, ${version}, ${j(after)}::jsonb, ${j(diff)}::jsonb, ${note}, ${actor.label})`);
  await audit(actor, "news.job.update", id, { version, diff: diff.slice(0, 50) });
  return { job: await getJob(id, db), version, changed: true, diff };
}

export async function jobVersions(id: string) {
  const db = await getDb();
  return rowsOf<{ version: number; snapshot: unknown; diff: unknown; note: string | null; created_by: string | null; created_at: string }>(await db.execute(sql`select version, snapshot, diff, note, created_by, created_at from news_job_versions where job_id = ${id} order by version desc`)).map((r) => ({ ...r, snapshot: asJson(r.snapshot, {}), diff: asJson(r.diff, []) }));
}

/** Roll back = save the old snapshot as a new version (history is never rewritten). */
export async function rollbackJob(actor: Actor, id: string, toVersion: number) {
  const db = await getDb();
  const [v] = rowsOf<{ snapshot: unknown }>(await db.execute(sql`select snapshot from news_job_versions where job_id = ${id} and version = ${toVersion}`));
  if (!v) throw new NewsError("Version not found.", 404);
  const r = await updateJob(actor, id, asJson(v.snapshot, {}), `rollback to v${toVersion}`);
  await audit(actor, "news.job.rollback", id, { to: toVersion, version: r.version });
  return r;
}

export async function cloneJob(actor: Actor, id: string) {
  const j0 = await getJob(id);
  if (!j0) throw new NewsError("Content flow not found.", 404);
  return createJob(actor, { ...pickJob(j0), name: `${j0.name} (copy)`.slice(0, 120), enabled: false });
}

export async function setJobEnabled(actor: Actor, id: string, enabled: boolean) {
  const j0 = await getJob(id);
  if (!j0) throw new NewsError("Content flow not found.", 404);
  return updateJob(actor, id, { ...pickJob(j0), enabled }, enabled ? "resumed" : "paused");
}

export async function deleteJob(actor: Actor, id: string) {
  const db = await getDb();
  await db.execute(sql`update news_jobs set deleted_at = now(), enabled = false, updated_at = now() where id = ${id} and deleted_at is null`);
  await audit(actor, "news.job.delete", id, {});
}

// --- profiles -------------------------------------------------------------------------------------------------------

type Kind = "writing" | "image";
const table = (k: Kind) => (k === "writing" ? sql.raw("news_writing_profiles") : sql.raw("news_image_profiles"));

export async function listProfiles(kind: Kind) {
  const db = await getDb();
  return rowsOf<Record<string, unknown>>(await db.execute(sql`select * from ${table(kind)} order by key, version desc`));
}

/** Saving a profile always creates a new version; `activate` makes it the one jobs use (unless a job pins a version). */
export async function saveProfile(actor: Actor, kind: Kind, raw: unknown, activate: boolean) {
  const db = await getDb();
  if (kind === "writing") {
    const p = parse(writingProfileInput, raw);
    const [r] = rowsOf<{ version: number }>(
      await db.execute(sql`
        insert into news_writing_profiles (key, version, name, status, system_style, structure_template, tone, audience, banned_phrases, required_sections, examples, temperature, model, created_by)
        select ${p.key}, coalesce(max(version), 0) + 1, ${p.name}, 'archived', ${p.system_style}, ${p.structure_template}, ${p.tone}, ${p.audience}, ${pgText(p.banned_phrases)}::text[], ${pgText(p.required_sections)}::text[], ${j(p.examples)}::jsonb, ${p.temperature}, ${p.model}, ${actor.label}
        from news_writing_profiles where key = ${p.key} returning version`),
    );
    if (activate) await activateProfile(actor, kind, p.key, r!.version);
    await audit(actor, "news.profile.save", `writing:${p.key}`, { version: r!.version, activate });
    return { key: p.key, version: r!.version };
  }
  const p = parse(imageProfileInput, raw);
  const [r] = rowsOf<{ version: number }>(
    await db.execute(sql`
      insert into news_image_profiles (key, version, name, status, provider, style_prompt, negative_prompt, aspect_ratios, palette, template_fallback, variants, safety_rules, created_by)
      select ${p.key}, coalesce(max(version), 0) + 1, ${p.name}, 'archived', ${p.provider}, ${p.style_prompt}, ${p.negative_prompt}, ${pgText(p.aspect_ratios)}::text[], ${j(p.palette)}::jsonb, ${p.template_fallback}, ${p.variants}, ${j(p.safety_rules)}::jsonb, ${actor.label}
      from news_image_profiles where key = ${p.key} returning version`),
  );
  if (activate) await activateProfile(actor, kind, p.key, r!.version);
  await audit(actor, "news.profile.save", `image:${p.key}`, { version: r!.version, activate });
  return { key: p.key, version: r!.version };
}

/** Approving a proposed version (from the weekly style review) is the same action: the owner activates it. */
export async function activateProfile(actor: Actor, kind: Kind, key: string, version: number) {
  const db = await getDb();
  const [exists] = rowsOf<{ n: number }>(await db.execute(sql`select count(*)::int as n from ${table(kind)} where key = ${key} and version = ${version}`));
  if (!exists?.n) throw new NewsError("Profile version not found.", 404);
  await db.execute(sql`update ${table(kind)} set status = 'archived' where key = ${key} and status = 'active'`);
  await db.execute(sql`update ${table(kind)} set status = 'active' where key = ${key} and version = ${version}`);
  await audit(actor, "news.profile.activate", `${kind}:${key}`, { version });
}

// --- sources --------------------------------------------------------------------------------------------------------

export async function listSources() {
  const db = await getDb();
  return rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select s.*, (select count(*)::int from news_items i where i.source_id = s.id and i.fetched_at > now() - interval '7 days') as items_7d,
        (select count(distinct a.id)::int from news_articles a join news_items i on i.cluster_id = a.cluster_id where i.source_id = s.id and a.review_outcome = 'approved') as approved_articles,
        (select count(distinct a.id)::int from news_articles a join news_items i on i.cluster_id = a.cluster_id where i.source_id = s.id and a.reject_category = 'inaccurate') as inaccurate_articles
      from news_sources s where s.deleted_at is null order by s.name`),
  );
}

export async function saveSource(actor: Actor, id: string | null, raw: unknown) {
  const s = parse(sourceInput, raw);
  const db = await getDb();
  const settings = await getNewsSettings(db);
  const host = new URL(s.url).hostname.toLowerCase();
  if (settings.paywalled_hosts.some((h) => host === h || host.endsWith(`.${h}`))) throw new NewsError(`${host} is on the paywalled list; it cannot be a source.`, 400);
  if (id) {
    await db.execute(sql`update news_sources set name = ${s.name}, type = ${s.type}, url = ${s.url}, topic_hints = ${pgText(s.topic_hints)}::text[], credibility = ${s.credibility}, fetch_interval_minutes = ${s.fetch_interval_minutes}, enabled = ${s.enabled}, terms_note = ${s.terms_note}, updated_at = now() where id = ${id} and deleted_at is null`);
    await audit(actor, "news.source.update", id, { ...s });
    return { id };
  }
  const [r] = rowsOf<{ id: string }>(
    await db.execute(sql`insert into news_sources (name, type, url, topic_hints, credibility, fetch_interval_minutes, enabled, terms_note, created_by) values (${s.name}, ${s.type}, ${s.url}, ${pgText(s.topic_hints)}::text[], ${s.credibility}, ${s.fetch_interval_minutes}, ${s.enabled}, ${s.terms_note}, ${actor.label}) returning id`),
  );
  await audit(actor, "news.source.create", r!.id, { ...s });
  return { id: r!.id };
}

export async function deleteSource(actor: Actor, id: string) {
  const db = await getDb();
  await db.execute(sql`update news_sources set deleted_at = now(), enabled = false where id = ${id}`);
  await audit(actor, "news.source.delete", id, {});
}

/** Suggested credibility from the owner's decisions (approval rate and "inaccurate" rejections). Owner approves. */
export async function credibilitySuggestions() {
  const rows = await listSources();
  return rows
    .map((s) => {
      const ok = Number(s.approved_articles ?? 0);
      const bad = Number(s.inaccurate_articles ?? 0);
      const n = ok + bad;
      if (n < 5) return null;
      const suggested = Math.round(Math.min(1, Math.max(0.1, (ok + 1) / (n + 2))) * 100) / 100;
      return Math.abs(suggested - Number(s.credibility)) >= 0.1 ? { id: String(s.id), name: String(s.name), current: Number(s.credibility), suggested, basis: `${ok} approved, ${bad} rejected as inaccurate` } : null;
    })
    .filter(Boolean);
}

// --- topics ---------------------------------------------------------------------------------------------------------

export async function listTopics() {
  const db = await getDb();
  return rowsOf<Record<string, unknown>>(await db.execute(sql`select t.*, c.label as category_label from news_topics t left join category c on c.slug = t.category_slug order by t.sort, t.slug`));
}

export async function saveTopic(actor: Actor, raw: { slug: string; label: string; category_slug: string | null; keywords: string[]; tags: string[]; enabled: boolean }) {
  if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(raw.slug)) throw new NewsError("Invalid topic slug.", 400);
  const db = await getDb();
  await db.execute(sql`
    insert into news_topics (slug, label, category_slug, keywords, tags, enabled, updated_at) values (${raw.slug}, ${raw.label.slice(0, 120)}, ${raw.category_slug}, ${pgText(raw.keywords.slice(0, 50))}::text[], ${pgText(raw.tags.slice(0, 20))}::text[], ${raw.enabled}, now())
    on conflict (slug) do update set label = excluded.label, category_slug = excluded.category_slug, keywords = excluded.keywords, tags = excluded.tags, enabled = excluded.enabled, updated_at = now()`);
  await audit(actor, "news.topic.save", raw.slug, { ...raw });
}

// --- runs (read models) ---------------------------------------------------------------------------------------------

export async function listRuns(q: { jobId?: string | null; status?: string | null; trigger?: string | null; kind?: string | null; before?: string | null; limit?: number }) {
  const db = await getDb();
  const where = [sql`true`];
  if (q.jobId) where.push(sql`r.job_id = ${q.jobId}`);
  if (q.status) where.push(sql`r.status = ${q.status}`);
  if (q.trigger) where.push(sql`r.trigger = ${q.trigger}`);
  if (q.kind) where.push(sql`r.kind = ${q.kind}`);
  if (q.before) where.push(sql`r.started_at < ${q.before}`);
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
  return rowsOf<Record<string, unknown>>(
    await db.execute(sql`select r.*, j.name as job_name, extract(epoch from (coalesce(r.finished_at, now()) - r.started_at))::float8 as seconds from news_runs r left join news_jobs j on j.id = r.job_id where ${sql.join(where, sql` and `)} order by r.started_at desc limit ${limit}`),
  ).map((r) => ({ ...r, counters: asJson<Record<string, number>>(r.counters, {}) }) as Record<string, unknown> & { counters: Record<string, number> });
}

export type ContentOfRun = { flowId: string | null; name: string | null; kind: string; dryRun: boolean; counters: Record<string, number>; costUsd: number };

/** The content flow behind each of these flow runs, for the one Runs list (a content flow's run has its flow run's id). */
export async function contentOfRuns(ids: string[], db?: Db): Promise<Map<string, ContentOfRun>> {
  const ok = ids.filter((id) => UUID.test(id));
  if (ok.length === 0) return new Map();
  const d = db ?? (await getDb());
  const rows = rowsOf<Record<string, unknown>>(
    await d.execute(sql`select r.id::text as id, r.job_id::text as job_id, j.name as job_name, r.kind, r.dry_run, r.counters, r.cost_usd, r.image_cost_usd from news_runs r left join news_jobs j on j.id = r.job_id where r.id = any(${pgText(ok)}::uuid[])`),
  );
  return new Map(rows.map((r) => [String(r.id), { flowId: r.job_id ? String(r.job_id) : null, name: r.job_name ? String(r.job_name) : null, kind: String(r.kind), dryRun: Boolean(r.dry_run), counters: asJson<Record<string, number>>(r.counters, {}), costUsd: Number(r.cost_usd ?? 0) + Number(r.image_cost_usd ?? 0) }]));
}

export async function runDetail(id: string) {
  const db = await getDb();
  const [run] = rowsOf<Record<string, unknown>>(await db.execute(sql`select r.*, j.name as job_name from news_runs r left join news_jobs j on j.id = r.job_id where r.id = ${id}`));
  if (!run) return null;
  const steps = rowsOf<Record<string, unknown>>(await db.execute(sql`select * from news_run_steps where run_id = ${id} order by seq, id`));
  const candidates = rowsOf<Record<string, unknown>>(await db.execute(sql`select k.*, c.title, c.source_count, c.topics from news_candidates k join news_clusters c on c.id = k.cluster_id where k.run_id = ${id} order by k.score desc limit 300`));
  const articles = rowsOf<Record<string, unknown>>(await db.execute(sql`select id, status, mode, draft_id, post_id, cluster_id, score, cost_usd, quality, generated_doc->>'title' as title from news_articles where run_id = ${id} order by created_at`));
  type Row = Record<string, unknown>;
  return {
    run: { ...run, counters: asJson<Record<string, number>>(run.counters, {}) } as Row & { counters: Record<string, number> },
    steps: steps.map((s) => ({ ...s, detail: asJson<Row>(s.detail, {}) }) as Row & { detail: Row }),
    candidates: candidates.map((c) => ({ ...c, breakdown: asJson<Row>(c.breakdown, {}), features: asJson<Record<string, number>>(c.features, {}), topics: asJson<{ slug: string }[]>(c.topics, []) }) as Row & { breakdown: Row; features: Record<string, number>; topics: { slug: string }[] }),
    articles: articles.map((a) => ({ ...a, quality: asJson<Row>(a.quality, {}) }) as Row & { quality: Row }),
  };
}

export async function runLogs(id: string, afterId = 0, level?: string | null, search?: string | null) {
  const db = await getDb();
  const levels = { debug: ["debug", "info", "warning", "error"], info: ["info", "warning", "error"], warning: ["warning", "error"], error: ["error"] }[level ?? "debug"] ?? ["debug", "info", "warning", "error"];
  return rowsOf<{ id: number; step: string | null; level: string; message: string; context: unknown; at: string }>(
    await db.execute(sql`select id, step, level, message, context, at from news_run_logs where run_id = ${id} and id > ${afterId} and level = any(${pgText(levels)}::text[]) ${search ? sql`and message ilike ${`%${search.replace(/[%_]/g, "")}%`}` : sql``} order by id limit 500`),
  ).map((l) => ({ ...l, id: Number(l.id), context: asJson(l.context, {}) }));
}

// --- review integration ---------------------------------------------------------------------------------------------

export type NewsArticleView = Record<string, unknown> & {
  sources: { title?: string; publisher?: string; url: string; accessed_at?: string }[];
  fact_sheet: { claims?: { id?: string; claim: string; source_url: string; snippet?: string; kind?: string }[] };
  fact_check: { checked?: number; removed?: string[]; flagged?: { claim: string; reason: string; severity: string }[] };
  similarity: { passed?: boolean; failures?: string[]; detail?: { top_matches?: { paragraph: number; source: string; overlap?: number; cosine?: number; longest_run?: number; excerpt: string }[] } };
  quality: { passed?: boolean; failed?: string[]; gates?: Record<string, { passed: boolean; failures: string[]; warnings: string[] }> };
  images: Record<string, unknown>[];
  candidate: { breakdown: Record<string, unknown>; features: Record<string, number>; score: number; model_version: string; reason: string } | null;
};

export async function newsArticleForDraft(draftId: string, db?: Db): Promise<NewsArticleView | null> {
  const d = db ?? (await getDb());
  const [a] = rowsOf<Record<string, unknown>>(await d.execute(sql`select a.*, j.name as job_name from news_articles a left join news_jobs j on j.id = a.job_id where a.draft_id = ${draftId} order by a.created_at desc limit 1`));
  if (!a) return null;
  const images = rowsOf<Record<string, unknown>>(await d.execute(sql`select id, variant, provider, model, src, alt, decorative, ai_generated, safety, score, selected, status, width, height, created_at from news_images where article_id = ${String(a.id)} order by created_at`));
  const [cand] = a.cluster_id ? rowsOf<{ breakdown: unknown; features: unknown; score: number; model_version: string; reason: string }>(await d.execute(sql`select breakdown, features, score, model_version, reason from news_candidates where run_id = ${String(a.run_id)} and cluster_id = ${String(a.cluster_id)}`)) : [];
  return { ...a, sources: asJson(a.sources, []), fact_sheet: asJson(a.fact_sheet, {}), fact_check: asJson(a.fact_check, {}), similarity: asJson(a.similarity, {}), quality: asJson(a.quality, {}), images: images.map((i) => ({ ...i, safety: asJson(i.safety, {}) })), candidate: cand ? { ...cand, score: Number(cand.score), breakdown: asJson<Record<string, unknown>>(cand.breakdown, {}), features: asJson<Record<string, number>>(cand.features, {}) } : null };
}

function wordDistance(a: string, b: string) {
  const x = a.split(/\s+/).filter(Boolean);
  const y = b.split(/\s+/).filter(Boolean);
  if (!x.length && !y.length) return 0;
  // LCS on words (bounded: drafts are ≤ ~2,000 words)
  const n = Math.min(x.length, 3000);
  const m = Math.min(y.length, 3000);
  let prev = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    const cur = new Array<number>(m + 1).fill(0);
    for (let k = 1; k <= m; k++) cur[k] = x[i - 1] === y[k - 1] ? prev[k - 1]! + 1 : Math.max(prev[k]!, cur[k - 1]!);
    prev = cur;
  }
  return Math.round((1 - (2 * prev[m]!) / (n + m)) * 10_000) / 10_000;
}

/** Review outcomes feed the learning loop (ranker labels, reject categories, edit distance for the style review). */
export async function recordReview(actor: Actor, draftId: string, outcome: "approved" | "rejected" | "scheduled", opts: { category?: string | null; reason?: string | null; finalBody?: string | null } = {}) {
  const db = await getDb();
  const a = await newsArticleForDraft(draftId, db);
  if (!a) return null;
  const gen = asJson<{ body_mdx?: string }>(a.generated_doc, {});
  const dist = opts.finalBody != null && gen.body_mdx != null ? wordDistance(gen.body_mdx, opts.finalBody) : null;
  await db.execute(sql`
    update news_articles set review_outcome = ${outcome}, reject_category = ${opts.category ?? null}, reject_reason = ${opts.reason?.slice(0, 2000) ?? null}, reviewed_at = now(),
      status = ${outcome === "rejected" ? "rejected" : String(a.status)}, edit_distance = coalesce(${dist}, edit_distance), updated_at = now() where id = ${String(a.id)}`);
  await db.execute(sql`
    insert into news_feedback (article_id, cluster_id, job_id, kind, reason_category, reason, payload, actor)
    values (${String(a.id)}, ${(a.cluster_id as string | null) ?? null}, ${(a.job_id as string | null) ?? null}, ${outcome === "rejected" ? "reject" : "approve"}, ${opts.category ?? null}, ${opts.reason?.slice(0, 2000) ?? null}, ${j({ edit_distance: dist, score: a.score })}::jsonb, ${actor.label})`);
  if (opts.category === "duplicate" && a.cluster_id) await db.execute(sql`update news_clusters set status = 'covered' where id = ${String(a.cluster_id)}`);
  return { articleId: String(a.id), editDistance: dist };
}

/** Category/tag corrections in review become human labels for the classifier. */
export async function recordCategoryCorrection(actor: Actor, draftId: string, categories: string[]) {
  const db = await getDb();
  const a = await newsArticleForDraft(draftId, db);
  if (!a?.cluster_id) return;
  const topics = rowsOf<{ slug: string }>(await db.execute(sql`select slug from news_topics where category_slug = any(${pgText(categories)}::text[])`)).map((t) => t.slug);
  if (!topics.length) return;
  await db.execute(sql`insert into news_labels (cluster_id, item_id, topics, source) select ${String(a.cluster_id)}, i.id, ${pgText(topics)}::text[], 'human' from news_items i where i.cluster_id = ${String(a.cluster_id)} and i.duplicate_of is null on conflict do nothing`);
  await db.execute(sql`insert into news_feedback (article_id, cluster_id, job_id, kind, payload, actor) values (${String(a.id)}, ${String(a.cluster_id)}, ${(a.job_id as string | null) ?? null}, 'category_correction', ${j({ categories, topics })}::jsonb, ${actor.label})`);
}

// --- analytics ------------------------------------------------------------------------------------------------------

/** Content analytics filters (AI & SEO → Content analytics), from the address. Every one is optional. */
export type AnalyticsFilter = { days: number; jobId?: string | null; output?: "news" | "article" | null; category?: string | null; topic?: string | null; sourceId?: string | null };
export const ANALYTICS_PERIODS = [7, 30, 90, 365] as const;

/**
 * What crew jobs drafted and how it did, over every job's drafts (news stories and blog articles alike), narrowed by
 * the filters: period, job, what it writes, category, topic, source. The same filter applies to every number, so a
 * filtered page never mixes in the rest. Drafts the Editorial crew wrote from content ideas are counted apart (they
 * are calendar drafts, not news_articles rows): per job, sent and published.
 */
export async function analytics(f: AnalyticsFilter | number = 90) {
  const filter: AnalyticsFilter = typeof f === "number" ? { days: f } : f;
  const db = await getDb();
  const since = new Date(Date.now() - filter.days * 86_400_000).toISOString();
  const q = <T>(s: ReturnType<typeof sql>) => db.execute(s).then((r) => rowsOf<T>(r));
  // One condition on news_articles a (and its job j), used by every query below.
  const parts = [sql`a.created_at >= ${since}`];
  if (filter.jobId) parts.push(sql`a.job_id = ${filter.jobId}`);
  if (filter.output) parts.push(sql`coalesce(j.config->>'output', 'news') = ${filter.output}`);
  if (filter.category) parts.push(sql`exists (select 1 from post p where p.id = a.post_id and p.category = ${filter.category})`);
  if (filter.topic) parts.push(sql`exists (select 1 from news_clusters c2 cross join lateral jsonb_array_elements(c2.topics) t2 where c2.id = a.cluster_id and t2->>'slug' = ${filter.topic})`);
  if (filter.sourceId) parts.push(sql`exists (select 1 from news_items i2 where i2.cluster_id = a.cluster_id and i2.source_id = ${filter.sourceId})`);
  const where = sql.join(parts, sql` and `);
  const from = sql`news_articles a left join news_jobs j on j.id = a.job_id`;
  const ok = sql`a.review_outcome in ('approved', 'scheduled')`;
  const no = sql`a.review_outcome = 'rejected'`;
  const runJobs = filter.jobId ? sql`and r.job_id = ${filter.jobId}` : filter.output ? sql`and r.job_id in (select id from news_jobs where coalesce(config->>'output', 'news') = ${filter.output})` : sql``;
  const [byJob, bySource, byTopic, byCategory, editTrend, review, perf, cost, ideas, models] = await Promise.all([
    q<Record<string, unknown>>(sql`select coalesce(j.name, 'deleted job') as name, count(*) filter (where ${ok})::int as approved, count(*) filter (where ${no})::int as rejected from ${from} where ${where} group by 1 order by 1`),
    q<Record<string, unknown>>(sql`select s.name, count(distinct a.id) filter (where ${ok})::int as approved, count(distinct a.id) filter (where ${no})::int as rejected from ${from} join news_items i on i.cluster_id = a.cluster_id join news_sources s on s.id = i.source_id where ${where} group by 1 order by 1`),
    q<Record<string, unknown>>(sql`select t->>'slug' as topic, count(*) filter (where ${ok})::int as approved, count(*) filter (where ${no})::int as rejected from ${from} join news_clusters c on c.id = a.cluster_id cross join lateral jsonb_array_elements(c.topics) t where ${where} group by 1 order by 1`),
    q<Record<string, unknown>>(sql`select coalesce(p.category, 'not saved') as name, count(*) filter (where ${ok})::int as approved, count(*) filter (where ${no})::int as rejected from ${from} left join post p on p.id = a.post_id where ${where} group by 1 order by 1`),
    q<Record<string, unknown>>(sql`select date_trunc('week', a.reviewed_at)::date::text as week, avg(a.edit_distance)::float8 as avg, count(*)::int as n from ${from} where ${where} and a.edit_distance is not null and a.reviewed_at is not null group by 1 order by 1`),
    q<Record<string, unknown>>(sql`select avg(extract(epoch from (a.reviewed_at - a.created_at)) / 3600)::float8 as hours, count(*)::int as n from ${from} where ${where} and a.reviewed_at is not null`),
    q<Record<string, unknown>>(sql`select f.payload->>'window' as window, avg((f.payload->>'clicks')::float8)::float8 as clicks, avg((f.payload->>'engagementRate')::float8)::float8 as engagement, count(*)::int as n from news_feedback f join ${from} on a.id = f.article_id where f.kind = 'performance' and f.at >= ${since} and ${where} group by 1 order by 1`),
    q<Record<string, unknown>>(sql`select (select coalesce(sum(r.cost_usd + r.image_cost_usd), 0)::float8 from news_runs r where r.started_at >= ${since} ${runJobs}) as spend, (select count(*)::int from ${from} where ${where} and ${ok}) as approved`),
    q<Record<string, unknown>>(sql`select coalesce(j.name, 'deleted job') as name, count(*)::int as sent, count(*) filter (where p.status = 'published')::int as published from seo_content_ideas i join news_runs r on r.id::text = i.run_id left join news_jobs j on j.id = r.job_id left join seo_editorial_calendar cal on cal.id = i.calendar_id left join post p on p.id = cal.post_id where i.status = 'sent' and i.updated_at >= ${since} ${runJobs} group by 1 order by 1`).catch(() => []),
    q<Record<string, unknown>>(sql`select kind, version, active, metrics, n_samples, trained_at, notes from news_models order by trained_at desc limit 20`),
  ]);
  const c = cost[0] ?? { spend: 0, approved: 0 };
  return { byJob, bySource, byTopic, byCategory, editTrend, review: review[0] ?? null, perf, ideas, costPerApproved: Number(c.approved) ? Number(c.spend) / Number(c.approved) : null, spend: Number(c.spend ?? 0), approved: Number(c.approved ?? 0), models: models.map((m) => ({ ...m, metrics: asJson(m.metrics, {}) })) };
}
