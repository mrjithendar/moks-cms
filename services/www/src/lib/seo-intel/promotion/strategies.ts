import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { rowsOf } from "@/db/rows";
import { siteOrigin } from "../urls";
import { promoLink, type Thread } from "./channels";
import { getPromotionSettings } from "./settings";

/**
 * Promotion strategies (owner request 2026-11-18: "improve content promotion, add different strategies to promote
 * content"). Promotion already drafts one post per channel for a new article; these are the other ways an article
 * earns readers, each computed from data the site already has, with the action that carries it out through what
 * exists (the promotion drafts, the review queue, internal linking). Nothing is posted automatically.
 *
 * - launch: new articles (last 14 days) and where their channel posts stand;
 * - evergreen: older articles still earning search clicks, not shared for 90 days: share them again;
 * - refresh: articles losing search clicks: refresh them first (a review draft), then share them again;
 * - syndicate: cross-post the full article to dev.to or Hashnode with the canonical URL pointing home;
 * - community: Reddit threads that ask what an article answers: answer there, link only where it helps;
 * - internal: link to new articles from the site's own related articles (internal link suggestions);
 * - digest: a ready-to-send newsletter issue: this week's articles plus one evergreen pick.
 */
export type StrategyId = "launch" | "evergreen" | "refresh" | "syndicate" | "community" | "internal" | "digest";
export type StrategyItem = { articleId: string; title: string; path: string; why: string; url?: string };
export type Strategy = { id: StrategyId; title: string; summary: string; how: string; items: StrategyItem[]; digest?: string };

export const EVERGREEN_MIN_AGE_DAYS = 60;
export const RESHARE_AFTER_DAYS = 90;
const EVERGREEN_MIN_CLICKS = 10;
const DECAY_DROP = 0.3;
const DECAY_MIN_PREV = 20;
const MAX_ITEMS = 8;

type Row = { id: string; title: string; path: string; description: string; published_at: string | null };

/** Search Console clicks per article: the last 28 days and the 28 before, from the newest synced day. */
async function clicks(): Promise<Map<string, { cur: number; prev: number }>> {
  const db = await getDb();
  const rows = rowsOf<{ article_id: string; cur: number; prev: number }>(
    await db.execute(sql`
      with last as (select max(date) as d from seo_gsc_page_daily)
      select m.article_id,
        coalesce(sum(g.clicks) filter (where g.date > last.d - 28), 0)::float8 as cur,
        coalesce(sum(g.clicks) filter (where g.date <= last.d - 28 and g.date > last.d - 56), 0)::float8 as prev
      from seo_gsc_page_daily g join seo_url_map m on m.url = g.page, last
      where g.search_type = 'web' and m.article_id is not null and g.date > last.d - 56
      group by m.article_id`),
  );
  return new Map(rows.map((r) => [String(r.article_id), { cur: Number(r.cur), prev: Number(r.prev) }]));
}

export async function promotionPlan(now = new Date()): Promise<Strategy[]> {
  const db = await getDb();
  const settings = await getPromotionSettings();
  const origin = siteOrigin();
  const day = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();
  const articles = rowsOf<Row & { last_posted: string | null; open: number; drafted: number; posted: number; syndicated: number }>(
    await db.execute(sql`
      select p.id, p.title, '/' || p.collection || '/' || p.slug as path, p.description, p.published_at,
        (select max(o.posted_at) from seo_promo_opportunities o where o.article_id = p.id) as last_posted,
        (select count(*)::int from seo_promo_opportunities o where o.article_id = p.id and o.status = 'open') as open,
        (select count(*)::int from seo_promo_opportunities o where o.article_id = p.id and o.status = 'drafted') as drafted,
        (select count(*)::int from seo_promo_opportunities o where o.article_id = p.id and o.status = 'posted') as posted,
        (select count(*)::int from seo_promo_opportunities o where o.article_id = p.id and o.channel in ('devto', 'hashnode') and o.status = 'posted') as syndicated
      from post p where p.status = 'published' and p.deleted_at is null and p.noindex = false and p.collection in ('blog', 'projects')
      order by p.published_at desc nulls last`),
  );
  const c = await clicks();
  const age = (a: Row) => (a.published_at ? (now.getTime() - Date.parse(a.published_at)) / 86_400_000 : 0);
  const item = (a: Row, why: string): StrategyItem => ({ articleId: a.id, title: a.title, path: a.path, why });

  const fresh = articles.filter((a) => age(a) <= 14);
  const launch: Strategy = {
    id: "launch",
    title: "Launch new articles",
    summary: "Share each new article on the channels that suit it, in its first two weeks.",
    how: "Promotion scores every channel for the article and drafts a post for each; review, edit and post them yourself, then mark them posted.",
    items: fresh.slice(0, MAX_ITEMS).map((a) => item(a, a.open + a.drafted + a.posted === 0 ? "Not scored yet: run Promotion for it." : `${a.drafted} draft(s) to review, ${a.open} without a draft, ${a.posted} posted.`)),
  };

  const evergreen: Strategy = {
    id: "evergreen",
    title: "Reshare evergreen articles",
    summary: `Articles older than ${EVERGREEN_MIN_AGE_DAYS} days that still earn search clicks, not shared for ${RESHARE_AFTER_DAYS} days.`,
    how: "Reshare reopens the article's channels (the last post is kept as a record) and drafts fresh posts with a new angle: a lesson, a number, a follow-up question.",
    items: articles
      .filter((a) => age(a) >= EVERGREEN_MIN_AGE_DAYS && (c.get(a.id)?.cur ?? 0) >= EVERGREEN_MIN_CLICKS && (!a.last_posted || a.last_posted < day(RESHARE_AFTER_DAYS)))
      .sort((x, y) => (c.get(y.id)?.cur ?? 0) - (c.get(x.id)?.cur ?? 0))
      .slice(0, MAX_ITEMS)
      .map((a) => item(a, `${Math.round(c.get(a.id)!.cur)} search clicks in 28 days · ${a.last_posted ? `last shared ${a.last_posted.slice(0, 10)}` : "never shared"}`)),
  };

  const refresh: Strategy = {
    id: "refresh",
    title: "Refresh, then reshare",
    summary: `Articles whose search clicks fell by ${Math.round(DECAY_DROP * 100)}% or more against the 28 days before.`,
    how: "Refresh first sends the article for an AI review (facts, versions, links, title and meta) to the review queue. Publish the refreshed version, then reshare it as an updated guide.",
    items: articles
      .filter((a) => {
        const k = c.get(a.id);
        return k && k.prev >= DECAY_MIN_PREV && k.cur <= k.prev * (1 - DECAY_DROP);
      })
      .sort((x, y) => (c.get(x.id)!.cur - c.get(x.id)!.prev) - (c.get(y.id)!.cur - c.get(y.id)!.prev))
      .slice(0, MAX_ITEMS)
      .map((a) => {
        const k = c.get(a.id)!;
        return item(a, `${Math.round(k.prev)} → ${Math.round(k.cur)} search clicks (28 days)`);
      }),
  };

  const syndicate: Strategy = {
    id: "syndicate",
    title: "Syndicate to dev.to and Hashnode",
    summary: "Cross-post the full article where developers read, with the canonical URL pointing to this site so search engines credit the original.",
    how: "Use the article's dev.to or Hashnode draft in Promotion: paste the full article, set canonical_url (dev.to) or the original URL (Hashnode) to the link shown, and mark it posted.",
    items: articles
      .filter((a) => age(a) >= 7 && a.syndicated === 0)
      .sort((x, y) => (c.get(y.id)?.cur ?? 0) - (c.get(x.id)?.cur ?? 0))
      .slice(0, MAX_ITEMS)
      .map((a) => ({ ...item(a, `canonical: ${new URL(a.path, origin).toString()}`), url: new URL(a.path, origin).toString() })),
  };

  const threadRows = rowsOf<{ id: string; title: string; path: string; evidence: unknown }>(
    await db.execute(sql`
      select p.id, p.title, '/' || p.collection || '/' || p.slug as path, o.evidence from seo_promo_opportunities o join post p on p.id = o.article_id
      where o.channel = 'reddit' and p.status = 'published' and p.deleted_at is null and o.updated_at > ${day(30)}`),
  );
  const threads: StrategyItem[] = [];
  for (const r of threadRows) {
    const ev = (typeof r.evidence === "string" ? JSON.parse(r.evidence) : r.evidence ?? {}) as { threads?: Thread[] };
    for (const t of ev.threads ?? []) threads.push({ articleId: r.id, title: r.title, path: r.path, why: `r/${t.community}: ${t.title} (${t.score} upvotes, ${t.comments} comments)`, url: t.url });
  }
  const community: Strategy = {
    id: "community",
    title: "Answer questions in communities",
    summary: "Reddit threads from the last 30 days that ask what one of your articles answers.",
    how: "Answer in the thread itself, with the steps or the fix; link the article only where it adds detail. Check each subreddit's self-promotion rule first.",
    items: threads.slice(0, MAX_ITEMS),
  };

  const links = rowsOf<{ id: string; title: string; path: string; n: number }>(
    await db.execute(sql`
      select p.id, p.title, '/' || p.collection || '/' || p.slug as path, count(*)::int as n from seo_internal_link_suggestions s join post p on p.id = s.target_article_id
      where s.status = 'suggested' and p.status = 'published' and p.deleted_at is null and p.published_at > ${day(45)}
      group by p.id order by count(*) desc limit ${MAX_ITEMS}`),
  );
  const internal: Strategy = {
    id: "internal",
    title: "Link new articles from your own site",
    summary: "Readers already on related articles are the easiest audience: suggested internal links to articles from the last 45 days.",
    how: "Open Internal linking, accept the suggestions you agree with, and they go through the review queue like any change.",
    items: links.map((l) => ({ articleId: l.id, title: l.title, path: l.path, why: `${l.n} suggested link(s) from related articles` })),
  };

  const week = articles.filter((a) => age(a) <= 7);
  const pick = evergreen.items[0];
  const linkFor = (path: string) => promoLink(origin, path, "newsletter", settings);
  const blocks = [
    [`Subject: ${week.length ? `New on the site: ${week[0]!.title}` : pick ? `Worth a read: ${pick.title}` : "This week"}`],
    week.length ? ["New this week:", ...week.slice(0, 5).flatMap((a) => [`- ${a.title}: ${a.description}`, `  ${linkFor(a.path)}`])] : [],
    pick ? ["From the archive, still useful:", `- ${pick.title}`, `  ${linkFor(pick.path)}`] : [],
    ["Reply to this email with what you would like me to write about next."],
  ].filter((b) => b.length);
  const lines = blocks.map((b) => b.join("\n"));
  const digest: Strategy = {
    id: "digest",
    title: "Newsletter digest",
    summary: "One issue with this week's articles and one evergreen pick, links tagged for your analytics.",
    how: "Copy it into your newsletter tool, adjust the intro, and send. Links carry utm_source=newsletter.",
    items: [...week.slice(0, 5).map((a) => item(a, "new this week")), ...(pick ? [{ ...pick, why: "evergreen pick" }] : [])],
    digest: week.length || pick ? lines.join("\n\n") : undefined,
  };

  return [launch, evergreen, refresh, syndicate, community, internal, digest];
}

/**
 * Reshare: reopen an article's channels that were posted more than RESHARE_AFTER_DAYS ago, so new drafts can be made;
 * the last posted URL and date stay as the record. A channel the owner dismissed stays dismissed. Never posts anything.
 */
export async function reopenForReshare(articleId: string, now = new Date()): Promise<number> {
  const db = await getDb();
  const before = new Date(now.getTime() - RESHARE_AFTER_DAYS * 86_400_000).toISOString();
  const rows = rowsOf<{ id: string }>(
    await db.execute(sql`
      update seo_promo_opportunities set status = 'open', draft_title = null, draft_body = null, draft_flags = '[]'::jsonb,
        draft_notes = 'Reshare: last shared ' || coalesce(to_char(posted_at, 'YYYY-MM-DD'), 'earlier') || '. Use a new angle: a lesson, a number or a follow-up question, not the first post again.',
        updated_at = now()
      where article_id = ${articleId} and status = 'posted' and (posted_at is null or posted_at < ${before})
      returning id`),
  );
  return rows.length;
}
