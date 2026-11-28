import { sql } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
import { readServiceAccount } from "./google/auth";
import { contentOverview } from "./content";
import { linkGraph, loadLinkCorpus } from "./internal-links";
import type { Filters, Period, SourceStatus } from "./queries";
import { getSeoSettings, submissionEnabled } from "./settings";
import { llmConfig } from "../llm/client";
import { addDays } from "./sqlutil";

/**
 * v2 Phase 7 overview data: daily series for the current and the previous period (KPI sparklines, dashed comparison
 * lines), top movers, the SEO health score with its inputs and weights, chart annotations from the audit log, the
 * review-queue count and the onboarding checklist. Read-only.
 */
export type Daily = { date: string; clicks: number; impressions: number; ctr: number | null; position: number | null; sessions: number | null };

export async function dailySeries(db: Db, f: Filters, p: Period): Promise<{ cur: Daily[]; prev: Daily[] }> {
  const load = async (start: string, end: string) => {
    const g = rowsOf<{ date: string; clicks: number; impressions: number; position: number | null }>(await db.execute(sql`select date::text as date, clicks::float8 as clicks, impressions::float8 as impressions, position from seo_gsc_daily_totals where search_type = ${f.searchType} and date between ${start} and ${end} order by date`));
    const a = rowsOf<{ date: string; s: number }>(await db.execute(sql`select date::text as date, sum(sessions) filter (where channel_group = 'Organic Search')::float8 as s from seo_ga4_page_daily where date between ${start} and ${end} group by date`));
    const sessions = new Map(a.map((r) => [r.date, Number(r.s ?? 0)]));
    const out: Daily[] = [];
    const byDate = new Map(g.map((r) => [r.date, r]));
    for (let d = start; d <= end; d = addDays(d, 1)) {
      const r = byDate.get(d);
      out.push({ date: d, clicks: Number(r?.clicks ?? 0), impressions: Number(r?.impressions ?? 0), ctr: r && Number(r.impressions) ? Number(r.clicks) / Number(r.impressions) : null, position: r?.position === null || r?.position === undefined ? null : Number(r.position), sessions: sessions.has(d) ? sessions.get(d)! : null });
    }
    return out;
  };
  const [cur, prev] = await Promise.all([load(p.start, p.end), load(p.prevStart, p.prevEnd)]);
  return { cur, prev };
}

export type Mover = { page: string; title: string | null; articleId: string | null; clicks: number; prev: number; delta: number };

export async function topMovers(db: Db, p: Period, limit = 5): Promise<{ up: Mover[]; down: Mover[] }> {
  const rows = rowsOf<{ page: string; c: number; p: number; title: string | null; article_id: string | null }>(
    await db.execute(sql`
      with cur as (select page, sum(clicks)::float8 as c from seo_gsc_page_daily where search_type = 'web' and date between ${p.start} and ${p.end} group by page),
      prev as (select page, sum(clicks)::float8 as p from seo_gsc_page_daily where search_type = 'web' and date between ${p.prevStart} and ${p.prevEnd} group by page)
      select coalesce(cur.page, prev.page) as page, coalesce(cur.c, 0) as c, coalesce(prev.p, 0) as p, po.title, m.article_id
      from cur full outer join prev on prev.page = cur.page
      left join seo_url_map m on m.url = coalesce(cur.page, prev.page) left join post po on po.id = m.article_id
      where coalesce(cur.c, 0) + coalesce(prev.p, 0) >= 5`),
  ).map((r) => ({ page: r.page, title: r.title, articleId: r.article_id, clicks: Number(r.c), prev: Number(r.p), delta: Number(r.c) - Number(r.p) }));
  return { up: rows.filter((r) => r.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, limit), down: rows.filter((r) => r.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, limit) };
}

export type HealthInput = { key: string; label: string; weight: number; score: number | null; detail: string };
export const HEALTH_WEIGHTS = { content: 35, technical: 30, links: 15, freshness: 10, data: 10 } as const;

/** Weighted mean of the measured inputs (unmeasured ones are left out and the weights renormalised). */
export function healthScore(inputs: HealthInput[]): { score: number | null; inputs: HealthInput[] } {
  const measured = inputs.filter((i) => i.score !== null);
  const w = measured.reduce((s, i) => s + i.weight, 0);
  return { score: w ? Math.round(measured.reduce((s, i) => s + i.score! * i.weight, 0) / w) : null, inputs };
}

export async function siteHealth(db: Db, gsc: SourceStatus, now = new Date()) {
  const content = await contentOverview(now);
  const [scan] = rowsOf<{ id: string; pages: number }>(await db.execute(sql`select id, pages_crawled as pages from seo_technical_scans where status = 'succeeded' order by started_at desc limit 1`));
  const errPages = scan ? Number(rowsOf<{ n: number }>(await db.execute(sql`select count(distinct url)::int as n from seo_technical_issues where scan_id = ${scan.id} and severity = 'error'`))[0]?.n ?? 0) : 0;
  const corpus = await loadLinkCorpus(db);
  const g = linkGraph(corpus);
  const orphans = corpus.filter((d) => (g.inbound.get(d.path) ?? 0) === 0).length;
  const fresh = content.filter((c) => c.updatedAt && now.getTime() - Date.parse(c.updatedAt) < 548 * 86_400_000).length;
  return healthScore([
    { key: "content", label: "Content quality (average audit score)", weight: HEALTH_WEIGHTS.content, score: content.length ? Math.round((content.reduce((s, c) => s + c.score, 0) / content.length) * 100) : null, detail: `${content.length} published articles` },
    { key: "technical", label: "Technical (pages without crawl errors)", weight: HEALTH_WEIGHTS.technical, score: scan && Number(scan.pages) ? Math.round((1 - errPages / Number(scan.pages)) * 100) : null, detail: scan ? `${errPages} of ${scan.pages} crawled pages have errors` : "no technical scan yet" },
    { key: "links", label: "Internal linking (articles with inbound links)", weight: HEALTH_WEIGHTS.links, score: corpus.length ? Math.round((1 - orphans / corpus.length) * 100) : null, detail: `${orphans} orphan${orphans === 1 ? "" : "s"}` },
    { key: "freshness", label: "Freshness (updated within 18 months)", weight: HEALTH_WEIGHTS.freshness, score: content.length ? Math.round((fresh / content.length) * 100) : null, detail: `${fresh} of ${content.length}` },
    { key: "data", label: "Data (Search Console sync)", weight: HEALTH_WEIGHTS.data, score: gsc.state === "ok" ? 100 : gsc.state === "stale" ? 50 : gsc.state === "disconnected" ? null : 0, detail: gsc.message },
  ]);
}

export type Annotation = { date: string; label: string };

/** "Article updated on X" markers: SEO drafts published or rolled back, and editor updates of published posts. */
export async function annotations(db: Db, start: string, end: string): Promise<Annotation[]> {
  const rows = rowsOf<{ d: string; action: string; n: number }>(
    await db.execute(sql`
      select created_at::date::text as d, action, count(*)::int as n from audit_log
      where created_at::date between ${start} and ${end}
        and (action in ('seo.draft.publish', 'seo.draft.rollback') or (action = 'post.update' and detail->>'status' = 'published'))
      group by 1, 2 order by 1`),
  );
  const by = new Map<string, string[]>();
  for (const r of rows) by.set(r.d, [...(by.get(r.d) ?? []), r.action === "seo.draft.publish" ? `${r.n} SEO draft${r.n === 1 ? "" : "s"} published` : r.action === "seo.draft.rollback" ? `${r.n} rollback${r.n === 1 ? "" : "s"}` : `${r.n} article update${r.n === 1 ? "" : "s"}`]);
  return [...by].map(([date, labels]) => ({ date, label: labels.join(", ") }));
}

export type Step = { key: string; label: string; done: boolean; href: string; hint: string };

export async function onboarding(db: Db, gsc: SourceStatus): Promise<Step[]> {
  const s = await getSeoSettings();
  const [dr] = rowsOf<{ n: number }>(await db.execute(sql`select count(*)::int as n from seo_drafts`));
  return [
    { key: "sa", label: "Add the Google service account", done: Boolean(readServiceAccount(process.env)), href: "/admin/settings/seo?section=search-console", hint: "GOOGLE_SEO_SERVICE_ACCOUNT_JSON in the jithendar-com-env Secret (MANUAL_SETUP.md)." },
    { key: "gsc", label: "Set the Search Console property", done: Boolean(s.google.gscProperty), href: "/admin/settings/seo?section=data", hint: "sc-domain:jithendar.com or the URL-prefix property." },
    { key: "sync", label: "Run the first sync", done: gsc.state === "ok" || gsc.state === "stale", href: "/admin/sync", hint: gsc.state === "never_synced" ? "Configured but not synced yet: start a backfill." : gsc.message },
    { key: "ga4", label: "Set the GA4 property (optional)", done: Boolean(s.google.ga4PropertyId), href: "/admin/settings/seo?section=data", hint: "Numeric property id, not the G- measurement id." },
    { key: "litellm", label: "Connect LiteLLM (the LLM gateway)", done: llmConfig() !== null, href: "/admin/settings/ai?section=llm", hint: "LITELLM_BASE_URL and LITELLM_API_KEY in the jithendar-com-env Secret (docs/LLM_GATEWAY.md). Without them nothing is drafted. Models and budgets are set in LiteLLM." },
    { key: "digest", label: "Choose who gets the review digest", done: s.drafts.digest.recipients.length > 0, href: "/admin/settings/ai?section=ai", hint: "Settings → Drafts → digest recipients." },
    { key: "submit", label: "Search-engine submission", done: submissionEnabled(), href: "/admin/settings/seo?section=content", hint: "On in production by default; SEO_SUBMISSION_ENABLED=false turns it off." },
    { key: "draft", label: "First draft generated", done: Number(dr?.n ?? 0) > 0, href: "/admin/review", hint: "Approve a recommendation for drafting, or wait for the weekly run." },
  ];
}

export async function overviewExtras(f: Filters, gp: Period, gsc: SourceStatus) {
  const db = await getDb();
  const [series, movers, health, notes, steps, rq] = await Promise.all([
    dailySeries(db, f, gp),
    topMovers(db, gp),
    siteHealth(db, gsc),
    annotations(db, gp.start, gp.end),
    onboarding(db, gsc),
    db.execute(sql`select count(*) filter (where status = 'ready_for_review')::int as ready, count(*) filter (where status = 'generation_failed')::int as failed, count(*) filter (where status = 'scheduled')::int as scheduled from seo_drafts`),
  ]);
  const [q] = rowsOf<{ ready: number; failed: number; scheduled: number }>(rq);
  return { series, movers, health, annotations: notes, steps, queue: { ready: Number(q?.ready ?? 0), failed: Number(q?.failed ?? 0), scheduled: Number(q?.scheduled ?? 0) } };
}
