import "server-only";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
import { generateImage, ImageGenError } from "../gemini";
import { resolveGeminiImageConfig } from "../integrations";
import { log } from "../log";
import { storeUpload } from "../media";
import { createPost, type Actor } from "../posts";
import { CallbackError, saveDraft, validateNewArticle } from "../seo-agent/callbacks";
import { docsAllowlist } from "../seo-agent/config";
import { headerFetcher, parseRobots, robotsAllows, type Robots } from "../seo-intel/crawler";
import { loadBase, reserveDraft } from "../seo-intel/drafts";
import { sendSeoAlert } from "../seo-intel/notify";
import { siteOrigin } from "../seo-intel/urls";
import { getNewsSettings } from "./service";

/**
 * The web side of the news desk's callback API (served on the cluster-internal callback port, internal-server.ts,
 * behind SEO_AGENT_CALLBACK_TOKEN). What the agent can do here:
 * - fetch a feed or primary source through the v1 SSRF-safe fetcher (allowlisted hosts only, robots.txt honoured,
 *   paywalled hosts refused, conditional GET, size/time limits, a User-Agent that identifies the site);
 * - create a CMS **draft** post (collection news) + its review draft (seo_drafts kind new_article, owned by the agent),
 *   after the same validators as v4 new articles (MDX compiles, internal links exist, unique title);
 * - store a cover image in the existing media library (R2), generate one with the existing Gemini integration;
 * - notify (the existing SEO alert recipients, only if configured).
 * It cannot publish: publishing is only the existing approval → publish_flow path.
 */
export const NEWS_USER_AGENT = "JithendarNewsDesk/1.0 (+https://jithendar.com; feed reader for the site's news desk)";
const UA_TOKEN = "jithendarnewsdesk";
const DEFAULT_PRIMARY_HOSTS = ["github.com", "kubernetes.io", "cncf.io", "aws.amazon.com", "docs.aws.amazon.com", "learn.microsoft.com", "azure.microsoft.com", "cloud.google.com", "developer.hashicorp.com", "hashicorp.com", "nvd.nist.gov", "cisa.gov", "istio.io", "prometheus.io", "grafana.com", "argo-cd.readthedocs.io", "docs.crewai.com", "modelcontextprotocol.io", "anthropic.com", "docs.anthropic.com", "openai.com"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw new CallbackError(`Invalid request: ${r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).slice(0, 5).join("; ")}`, 400, "invalid");
  return r.data;
}

const hostOf = (u: string) => new URL(u).hostname.toLowerCase().replace(/^www\./, "");
const under = (host: string, list: string[]) => list.some((d) => host === d || host.endsWith(`.${d}`));

// --- fetch ----------------------------------------------------------------------------------------------------------

const robotsCache = new Map<string, { at: number; robots: Robots | "deny" | "allow" }>();
const ROBOTS_TTL = 6 * 3600_000;

export type FetchDeps = { fetcher?: (url: string, headers: Record<string, string>) => Promise<{ status: number; finalUrl: string; headers: Record<string, string>; body: string; truncated: boolean; error?: string }>; now?: number };

async function robotsFor(origin: string, fetch: NonNullable<FetchDeps["fetcher"]>, now: number) {
  const hit = robotsCache.get(origin);
  if (hit && now - hit.at < ROBOTS_TTL) return hit.robots;
  const r = await fetch(`${origin}/robots.txt`, { "User-Agent": NEWS_USER_AGENT, Accept: "text/plain" });
  // Google's rules: 4xx = no restrictions, except 429 (too many requests), which like 5xx or unreachable means "treat the
  // whole site as disallowed for now"; those are cached for 30 minutes only.
  const transient = (r.error && r.status === 0) || r.status === 429 || r.status >= 500;
  const robots: Robots | "deny" | "allow" = transient ? "deny" : r.status >= 400 ? "allow" : parseRobots(r.body);
  robotsCache.set(origin, { at: transient ? now - ROBOTS_TTL + 30 * 60_000 : now, robots });
  return robots;
}

export async function newsFetch(body: unknown, deps: FetchDeps = {}) {
  const b = parse(z.object({ url: z.string().url().max(2000), sourceId: z.string().regex(UUID).optional(), etag: z.string().max(300).nullable().optional(), lastModified: z.string().max(100).nullable().optional(), purpose: z.enum(["feed", "primary_source"]) }), body);
  if (!b.url.startsWith("https://")) return { status: 0, error: "Only https URLs are fetched." };
  const db = await getDb();
  const settings = await getNewsSettings(db);
  const host = hostOf(b.url);
  if (under(host, settings.paywalled_hosts)) return { status: 0, error: `${host} is on the paywalled list; not fetched.` };
  const sources = rowsOf<{ id: string; url: string }>(await db.execute(sql`select id::text, url from news_sources where deleted_at is null`));
  let allow: string[];
  if (b.purpose === "feed") {
    const s = sources.find((x) => x.id === b.sourceId);
    if (!s) throw new CallbackError("Unknown source.", 404, "not_found");
    allow = [hostOf(s.url)];
  } else allow = [...new Set([...sources.map((s) => hostOf(s.url)), ...DEFAULT_PRIMARY_HOSTS, ...settings.primary_source_hosts, ...docsAllowlist()])];
  if (!under(host, allow)) return { status: 0, error: `${host} is not on the allowlist.` };
  const fetcher = deps.fetcher ?? headerFetcher(allow, { timeoutMs: 15_000, maxBytes: b.purpose === "feed" ? 3_000_000 : 1_500_000, maxRedirects: 3 });
  const url = new URL(b.url);
  const robots = await robotsFor(url.origin, fetcher, deps.now ?? Date.now());
  if (robots === "deny" || (robots !== "allow" && !robotsAllows(robots, url.pathname + url.search, UA_TOKEN))) return { status: 0, error: `robots.txt of ${url.host} does not allow fetching ${url.pathname}.`, robots: "disallowed" };
  const headers: Record<string, string> = { "User-Agent": NEWS_USER_AGENT, Accept: b.purpose === "feed" ? "application/rss+xml, application/atom+xml, application/feed+json, application/json, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.1" : "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8" };
  if (b.etag) headers["If-None-Match"] = b.etag;
  if (b.lastModified) headers["If-Modified-Since"] = b.lastModified;
  const r = await fetcher(b.url, headers);
  if (r.error) return { status: r.status, finalUrl: r.finalUrl, error: r.error };
  if (r.status === 304) return { status: 304, finalUrl: r.finalUrl, notModified: true, headers: { etag: r.headers.etag ?? b.etag ?? "", "last-modified": r.headers["last-modified"] ?? b.lastModified ?? "" } };
  if (r.status !== 200) return { status: r.status, finalUrl: r.finalUrl, error: `HTTP ${r.status}` };
  const type = r.headers["content-type"] ?? "";
  if (/\b(paywall|subscribe-wall)\b/i.test(r.headers["x-paywall"] ?? "")) return { status: r.status, error: "Paywalled content is not fetched." };
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(r.body)?.[1]?.trim().slice(0, 300) ?? "";
  return { status: 200, finalUrl: r.finalUrl, headers: { etag: r.headers.etag ?? "", "last-modified": r.headers["last-modified"] ?? "", "content-type": type.slice(0, 100) }, title, body: r.body.slice(0, 3_000_000), truncated: r.truncated };
}

// --- drafts ---------------------------------------------------------------------------------------------------------

/** The CMS author for desk drafts: the job's author slug if it maps to a user, else the first admin (a person). */
async function deskActor(db: Db, authorSlug: string | null): Promise<Actor> {
  const [byAuthor] = authorSlug ? rowsOf<{ id: string }>(await db.execute(sql`select u.id from author_profile p join "user" u on u.id = p.user_id where p.slug = ${authorSlug} and u.role in ('admin', 'author') limit 1`)) : [];
  const [admin] = byAuthor ? [byAuthor] : rowsOf<{ id: string }>(await db.execute(sql`select id from "user" where role = 'admin' order by created_at limit 1`));
  if (!admin) throw new CallbackError("No admin user exists to own news drafts.", 409, "no_author");
  return { id: admin.id, role: "admin", label: "news-desk" };
}

const imageSchema = z.object({ src: z.string().max(400).optional(), alt: z.string().max(300).optional(), width: z.number().int().positive().optional(), height: z.number().int().positive().optional(), variants: z.record(z.string(), z.string().max(400)).optional() }).passthrough().nullable().optional();

export async function newsSaveDraft(body: unknown) {
  const b = parse(
    z.object({
      articleId: z.string().regex(UUID),
      jobId: z.string().regex(UUID),
      jobName: z.string().max(200),
      reviewPriority: z.number().int().min(0).max(100).default(50),
      author: z.string().max(80).nullable().optional(),
      document: z.record(z.string(), z.unknown()),
      flags: z.array(z.object({ code: z.string().max(60), severity: z.enum(["error", "warning"]), message: z.string().max(1000) })).max(60).default([]),
      categories: z.array(z.string().max(60)).max(3).default([]),
      tags: z.array(z.string().max(60)).max(10).default([]),
      image: imageSchema,
      runId: z.string().max(80),
      model: z.string().max(80).nullable().default(null),
      promptVersion: z.string().max(40).nullable().default(null),
    }),
    body,
  );
  const db = await getDb();
  const doc = b.document;
  const v = await validateNewArticle(db, "00000000-0000-0000-0000-000000000000", doc);
  if (v.errors.length) return { errors: v.errors, flags: v.flags };
  const [cat] = b.categories.length ? rowsOf<{ slug: string }>(await db.execute(sql`select slug from category where slug = ${b.categories[0]!}`)) : [];
  const [fallback] = cat ? [cat] : rowsOf<{ slug: string }>(await db.execute(sql`select slug from category order by sort limit 1`));
  const news = (doc.news ?? {}) as { sources?: { title: string; url: string; publisher: string }[]; image?: { src?: string; alt?: string; width?: number; height?: number } | null };
  const actor = await deskActor(db, b.author ?? null);
  const slugBase = String(doc.slug_suggestion || "news").replace(/[^a-z0-9-]/g, "").slice(0, 70) || "news";
  const img = b.image?.src && /^\/media\/[0-9a-f-]{36}\//.test(b.image.src) ? { src: b.image.src, alt: String(b.image.alt || doc.title).slice(0, 300), width: b.image.width ?? 1600, height: b.image.height ?? 900 } : null;
  const post = await createPost(
    actor,
    {
      collection: "news",
      slug: `${slugBase}-${Date.now().toString(36).slice(-4)}`,
      title: String(doc.title).slice(0, 110),
      description: String(doc.meta_description ?? ""),
      body: String(doc.body_mdx ?? ""),
      category: (cat ?? fallback)?.slug ?? "devops-sre",
      tags: b.tags,
      contentType: "news",
      status: "draft",
      sources: (news.sources ?? []).filter((s) => /^https?:\/\//.test(s.url)).map((s) => ({ title: s.title || s.url, url: s.url, publisher: s.publisher || hostOf(s.url) })),
      ...(img ? { featuredImage: img } : {}),
    },
    { incompleteDrafts: true },
  );
  const base = await loadBase(db, post.id);
  const d = await reserveDraft(db, post.id, base, "news", { kind: "new_article", threadManaged: true });
  await saveDraft(d.id, { kind: "new_article", document: doc, changes: [], flags: [...v.flags, ...b.flags].slice(0, 60), summary: `News · ${b.jobName}: ${String(doc.title).slice(0, 200)}`, model: b.model, promptVersion: b.promptVersion, threadId: d.id });
  await db.execute(sql`update news_articles set draft_id = ${d.id}, post_id = ${post.id}, updated_at = now() where id = ${b.articleId}`);
  log.info("news draft saved", { operation: "news_save_draft", outcome: "ready_for_review" });
  return { draftId: d.id, postId: post.id, errors: [], flags: v.flags };
}

/** Regenerated cover from the review page: replaces the draft's image (only while it waits for review). */
export async function newsUpdateDraftImage(draftId: string, body: unknown) {
  if (!UUID.test(draftId)) throw new CallbackError("Invalid draft id.", 400, "invalid");
  const b = parse(z.object({ image: imageSchema }), body);
  const db = await getDb();
  const r = rowsOf<{ id: string }>(await db.execute(sql`update seo_drafts set document = jsonb_set(document, '{news,image}', ${JSON.stringify(b.image ?? null)}::jsonb, true), updated_at = now() where id = ${draftId} and thread_id = id and status = 'ready_for_review' and kind = 'new_article' returning id`));
  if (!r.length) throw new CallbackError("Draft is not waiting for review.", 409, "conflict");
  return { ok: true };
}

// --- media ----------------------------------------------------------------------------------------------------------

export async function newsStoreMedia(body: unknown) {
  const b = parse(
    z.object({
      articleId: z.string().regex(UUID),
      imageId: z.string().max(80),
      alt: z.string().trim().min(1).max(300),
      aiGenerated: z.boolean(),
      decorative: z.boolean().default(false),
      provider: z.string().max(40),
      files: z.record(z.enum(["og", "hero", "w800", "w400"]), z.object({ data: z.string().max(14_000_000), width: z.number().int(), height: z.number().int() })),
    }),
    body,
  );
  const db = await getDb();
  const actor = await deskActor(db, null);
  const out: Record<string, string> = {};
  let hero: { id: string; src: string } | null = null;
  for (const [k, f] of Object.entries(b.files)) {
    const r = await storeUpload({ name: `news-cover-${k}.webp`, bytes: Buffer.from(f.data, "base64") }, b.alt, actor.id, "news/covers");
    if (!r.ok) throw new CallbackError(r.error, 409, "storage");
    out[k] = r.src;
    if (k === "hero") hero = { id: r.id, src: r.src };
    // The CMS record says what the image is: AI-generated or a template cover, and whether it is decorative.
    await db.execute(sql`update media set description = ${`${b.aiGenerated ? `AI-generated image (${b.provider}).` : "Generated template cover (not AI)."}${b.decorative ? " Decorative." : ""} News desk article ${b.articleId}.`}, title = ${`News cover ${k}`} where id = ${r.id}`);
  }
  if (!hero) throw new CallbackError("No hero image in the upload.", 400, "invalid");
  return { mediaId: hero.id, src: hero.src, variants: out };
}

export async function newsGenerateImage(body: unknown) {
  const b = parse(z.object({ prompt: z.string().min(10).max(2000), aspectRatio: z.literal("16:9"), variant: z.number().int().min(1).max(4) }), body);
  const config = await resolveGeminiImageConfig();
  if (!config) return { error: "Gemini image generation is not configured (Admin → Integrations)." };
  try {
    const r = await generateImage(config, { prompt: b.prompt, aspectRatio: b.aspectRatio, model: config.model, imageSize: config.imageSize });
    return { data: r.bytes.toString("base64"), mimeType: r.mimeType, model: config.model };
  } catch (e) {
    return { error: e instanceof ImageGenError ? e.message : "Image generation failed." };
  }
}

// --- signals, notifications, performance ----------------------------------------------------------------------------

/** For the audience and keyword features: top articles by Search Console clicks (28 days) and top queries. */
export async function newsSiteSignals() {
  const db = await getDb();
  const origin = siteOrigin().origin;
  const top = rowsOf<{ page: string; clicks: number }>(await db.execute(sql`select page, sum(clicks)::float8 as clicks from seo_gsc_page_daily where search_type = 'web' and date > (select coalesce(max(date), current_date) - 28 from seo_gsc_page_daily) group by page order by clicks desc limit 50`));
  const queries = rowsOf<{ query: string; impressions: number }>(await db.execute(sql`select query, sum(impressions)::float8 as impressions from seo_gsc_query_daily where search_type = 'web' and date > (select coalesce(max(date), current_date) - 28 from seo_gsc_query_daily) group by query order by impressions desc limit 300`));
  return { topArticles: top.map((t) => ({ path: t.page.startsWith(origin) ? t.page.slice(origin.length) || "/" : t.page, clicks28: Number(t.clicks) })), queries: queries.filter((q) => !/@|\d{7,}/.test(q.query)).map((q) => ({ query: q.query, impressions: Number(q.impressions) })) };
}

export async function newsNotify(body: unknown, send = sendSeoAlert) {
  const b = parse(z.object({ kind: z.enum(["run_summary", "job_failed", "budget"]), jobId: z.string().optional(), jobName: z.string().max(200).optional(), runId: z.string().optional(), ready: z.number().int().optional(), failedQuality: z.number().int().optional(), other: z.number().int().optional(), error: z.string().max(1000).optional(), detail: z.string().max(1000).optional() }), body);
  const link = `${siteOrigin().origin}/admin/news/runs/${b.runId ?? ""}`;
  let subject = "";
  let text = "";
  if (b.kind === "run_summary") {
    if (!b.ready && !b.failedQuality) return { sent: false, reason: "nothing to report" };
    subject = `News desk: ${b.ready ?? 0} draft${b.ready === 1 ? "" : "s"} ready${b.failedQuality ? `, ${b.failedQuality} failed quality` : ""} (${b.jobName})`;
    text = `${subject}\n\nReview: ${siteOrigin().origin}/admin/seo/review?tab=news\nRun: ${link}`;
  } else if (b.kind === "job_failed") {
    subject = `News desk job failed: ${b.jobName}`;
    text = `${b.error ?? "Unknown error"}\n\nRun: ${link}`;
  } else {
    subject = "News desk budget threshold reached";
    text = `${b.detail ?? ""}\n\nSettings: ${siteOrigin().origin}/admin/news/settings`;
  }
  return { sent: await send(subject, text) };
}

/** Learning-loop input: GSC clicks/impressions and GA4 engagement at +7 and +28 days for published news. */
export async function newsCollectPerformance(now = new Date()) {
  const db = await getDb();
  const origin = siteOrigin().origin;
  let rows = 0;
  for (const days of [7, 28]) {
    const due = rowsOf<{ id: string; path: string; published_at: string }>(
      await db.execute(sql`
        select a.id, '/' || p.collection || '/' || p.slug as path, a.published_at::text from news_articles a join post p on p.id = a.post_id
        where a.status = 'published' and a.published_at <= ${new Date(now.getTime() - days * 86_400_000).toISOString()} and a.published_at > ${new Date(now.getTime() - (days + 30) * 86_400_000).toISOString()}
          and not exists (select 1 from news_feedback f where f.article_id = a.id and f.kind = 'performance' and f.payload->>'window' = ${`${days}d`}) limit 100`),
    );
    for (const a of due) {
      const from = a.published_at.slice(0, 10);
      const to = new Date(Date.parse(a.published_at) + days * 86_400_000).toISOString().slice(0, 10);
      const [g] = rowsOf<{ clicks: number | null; impressions: number | null }>(await db.execute(sql`select sum(clicks)::float8 as clicks, sum(impressions)::float8 as impressions from seo_gsc_page_daily where page = ${origin + a.path} and date between ${from} and ${to}`));
      const [ga] = rowsOf<{ s: number | null; e: number | null }>(await db.execute(sql`select sum(sessions)::float8 as s, sum(engaged_sessions)::float8 as e from seo_ga4_page_daily where landing_page = ${a.path} and date between ${from} and ${to}`));
      const payload = { window: `${days}d`, clicks: Number(g?.clicks ?? 0), impressions: Number(g?.impressions ?? 0), engagementRate: ga?.s ? Number(ga.e ?? 0) / Number(ga.s) : null };
      await db.execute(sql`insert into news_feedback (article_id, kind, payload) values (${a.id}, 'performance', ${JSON.stringify(payload)}::jsonb) on conflict do nothing`);
      rows++;
    }
  }
  return { rows };
}
