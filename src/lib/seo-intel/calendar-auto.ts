import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import { rowsOf } from "@/db/rows";
import { log } from "../log";
import type { AnalysisData } from "./data";
import { fitTitle, skipMeasured, themeOf, themesOfArticle, titleFor, topicCovered } from "./editorial";
import { fingerprint } from "./rules";

/**
 * Editorial calendar ideas added automatically (owner request 2026-11-18): "calendar items should be added
 * automatically based on the ML/AI, Google Analytics and Search Console data". Runs after the weekly suggestions
 * (recommendations.ts), next to the Search Console content gaps and editorial ideas editorial.ts already adds:
 *
 * - **ai (readers):** Ask-the-Blog questions asked at least ASK_MIN times that no article answered (seo_ask_gaps);
 * - **ai (Promotion):** the Promotion crew's article ideas that scored "high" (seo_content_ideas, score ≥ 70);
 * - **ml:** Search Console query clusters from the ML model (seo_ml_query_clusters) with at least CLUSTER_MIN
 *   impressions in 28 days that no published article covers;
 * - **analytics:** for the articles readers engage with most (GA4, 28 days), the next uncovered topic in their theme.
 *
 * Items are stored with status "approved" so they do not count towards editorial.ts's cap on open "suggested" ideas;
 * the phase the calendar shows is computed (calendar.ts). Each source adds at most PER_SOURCE items a run, and nothing is added while OPEN_CAP automatic items are still open
 * (no draft, not scheduled), so the calendar never floods. An idea already on the calendar (same fingerprint, any
 * status: a deleted item counts, so it does not come back) or the subject of a published article is skipped. Items
 * land unscheduled with `brief.source` naming where they came from (the calendar's Source filter). Nothing is drafted,
 * scheduled or published here.
 */
export const PER_SOURCE = 2;
export const OPEN_CAP = 12;
export const ASK_MIN = 2;
export const CLUSTER_MIN = 100;
type AutoSource = "ask" | "promotion" | "ml" | "analytics";

type Added = Record<AutoSource, number>;

async function openAutoItems(db: Db): Promise<number> {
  const [r] = rowsOf<{ n: number }>(
    await db.execute(sql`
      select count(*)::int as n from seo_editorial_calendar
      where brief ->> 'source' in ('ask', 'promotion', 'ml', 'analytics') and status not in ('dropped', 'published') and post_id is null and target_date is null`),
  );
  return Number(r?.n ?? 0);
}

async function knownFingerprints(db: Db): Promise<Set<string>> {
  return new Set(rowsOf<{ fingerprint: string }>(await db.execute(sql`select fingerprint from seo_editorial_calendar where fingerprint is not null`)).map((r) => r.fingerprint));
}

/** Insert one unscheduled item; false when its fingerprint is already on the calendar. */
async function insert(db: Db, fp: string, item: { title: string; kind: "measured" | "editorial_idea"; source: AutoSource; category: string | null; cluster: string | null; score: number; band: string; brief: Record<string, unknown>; evidence: unknown[] }) {
  const rows = rowsOf<{ id: string }>(
    await db.execute(sql`
      insert into seo_editorial_calendar (fingerprint, title, status, kind, category, cluster, priority_score, priority_band, brief, evidence)
      values (${fp}, ${item.title}, 'approved', ${item.kind}, ${item.category}, ${item.cluster}, ${item.score}, ${item.band},
        ${JSON.stringify({ ...item.brief, source: item.source })}::jsonb, ${JSON.stringify(item.evidence)}::jsonb)
      on conflict (fingerprint) do nothing returning id`),
  );
  return rows[0]?.id ?? null;
}

/** Mark an item an earlier path created (createItem: "manual") as automatic, with a fingerprint so it is never added twice. */
async function claim(db: Db, id: string, fp: string, source: AutoSource) {
  await db.execute(sql`update seo_editorial_calendar set fingerprint = ${fp}, brief = brief || ${JSON.stringify({ source })}::jsonb, updated_at = now() where id = ${id}`);
}

const coveredByArticle = (title: string, d: AnalysisData) => skipMeasured(title.toLowerCase(), d.articles) !== null;

/** Reader questions (Ask the Blog) nobody's article answered, most-asked first. */
async function fromAskGaps(db: Db, d: AnalysisData, known: Set<string>, room: number): Promise<number> {
  const clusters = rowsOf<{ id: number; label: string; asked: number }>(
    await db.execute(sql`
      select min(id)::int as id, coalesce(cluster_label, normalized) as label, sum(asked)::int as asked
      from seo_ask_gaps where status = 'open' group by coalesce(cluster_id::text, 'q' || id::text), coalesce(cluster_label, normalized)
      having sum(asked) >= ${ASK_MIN} order by sum(asked) desc limit 20`),
  );
  const { sendGapToCalendar } = await import("../seo-agent/gaps");
  let n = 0;
  for (const c of clusters) {
    if (n >= Math.min(PER_SOURCE, room)) break;
    const fp = fingerprint("auto", "ask", c.label);
    if (known.has(fp) || coveredByArticle(c.label, d)) continue;
    const { calendarId } = await sendGapToCalendar(c.id);
    await claim(db, calendarId, fp, "ask");
    known.add(fp);
    n++;
  }
  return n;
}

/** The Promotion crew's high-scoring article ideas (they already have an audience). */
async function fromPromotionIdeas(db: Db, d: AnalysisData, known: Set<string>, room: number): Promise<number> {
  const ideas = rowsOf<{ id: string; fingerprint: string; title: string }>(await db.execute(sql`select id, fingerprint, title from seo_content_ideas where status = 'new' and calendar_id is null and score >= 70 order by score desc limit 20`));
  const { updateIdea } = await import("./promotion/store");
  let n = 0;
  for (const i of ideas) {
    if (n >= Math.min(PER_SOURCE, room)) break;
    const fp = fingerprint("auto", "promotion", i.fingerprint);
    if (known.has(fp) || coveredByArticle(i.title, d)) continue;
    const r = await updateIdea(i.id, "calendar");
    if (!r.calendarId) continue;
    await claim(db, r.calendarId, fp, "promotion");
    known.add(fp);
    n++;
  }
  return n;
}

/** ML query clusters with real demand that no article covers (the cluster's label is its most-searched query). */
async function fromMlClusters(db: Db, d: AnalysisData, known: Set<string>, room: number, now: Date): Promise<number> {
  const since = new Date(now.getTime() - 28 * 86_400_000).toISOString().slice(0, 10);
  const clusters = rowsOf<{ label: string; impressions: number; clicks: number; queries: string[] }>(
    await db.execute(sql`
      select c.cluster_label as label, sum(g.impressions)::float8 as impressions, sum(g.clicks)::float8 as clicks,
        (array_agg(distinct c.query))[1:8] as queries
      from seo_ml_query_clusters c join seo_gsc_query_daily g on g.query = c.query and g.search_type = 'web' and g.date >= ${since}
      where c.cluster_label not like 'ask:%'
      group by c.cluster_label having sum(g.impressions) >= ${CLUSTER_MIN} order by sum(g.impressions) desc limit 30`),
  );
  let n = 0;
  for (const c of clusters) {
    if (n >= Math.min(PER_SOURCE, room)) break;
    const label = c.label.trim();
    // The same fingerprint as a Search Console gap for this query: one calendar item per subject, whichever came first.
    const fp = fingerprint("editorial", "measured", label);
    if (known.has(fp) || skipMeasured(label, d.articles)) continue;
    const theme = themeOf(label);
    const id = await insert(db, fp, {
      title: titleFor(label),
      kind: "measured",
      source: "ml",
      category: theme?.category ?? null,
      cluster: theme?.cluster ?? "Uncategorised",
      score: Math.min(0.9, 0.3 + Math.log10(Math.max(1, Number(c.impressions))) / 10),
      band: Number(c.impressions) >= 1000 ? "high" : "medium",
      brief: {
        audience: theme?.audience ?? "engineers searching for this topic",
        supportingQueries: [...new Set([label, ...(c.queries ?? [])])].slice(0, 10),
        gap: `The ML query clusters group ${c.queries?.length ?? 1}+ Search Console queries about "${label}" (${Math.round(Number(c.impressions))} impressions, ${Math.round(Number(c.clicks))} clicks in 28 days), and no published article covers it.`,
        codeExamples: theme ? [theme.code] : ["minimal runnable example"],
        diagrams: theme ? [theme.diagram] : [],
        readingTimeMinutes: 8,
      },
      evidence: [
        { metric: "impressions", period: "28d", value: Math.round(Number(c.impressions)), source: "gsc" },
        { metric: "clicks", period: "28d", value: Math.round(Number(c.clicks)), source: "gsc" },
        { metric: "query_cluster", period: "current", value: c.queries?.length ?? 1, valueText: label, source: "ml" },
      ],
    });
    if (id) {
      known.add(fp);
      n++;
    }
  }
  return n;
}

/** What readers engage with most (GA4): the next uncovered topic in that article's theme. */
async function fromAnalytics(db: Db, d: AnalysisData, known: Set<string>, room: number, now: Date): Promise<number> {
  const since = new Date(now.getTime() - 28 * 86_400_000).toISOString().slice(0, 10);
  const top = rowsOf<{ article_id: string; engaged: number; seconds: number }>(
    await db.execute(sql`
      select m.article_id, sum(g.engaged_sessions)::float8 as engaged, (sum(g.user_engagement_duration) / nullif(sum(g.sessions), 0))::float8 as seconds
      from seo_ga4_page_daily g join seo_url_map m on m.url = g.landing_page
      where g.date >= ${since} and m.article_id is not null
      group by m.article_id having sum(g.engaged_sessions) >= 20 order by sum(g.engaged_sessions) desc limit 10`),
  );
  let n = 0;
  for (const t of top) {
    if (n >= Math.min(PER_SOURCE, room)) break;
    const article = d.articles.find((a) => a.id === t.article_id);
    if (!article) continue;
    for (const theme of themesOfArticle(article)) {
      const topic = theme.topics.find((tp) => !known.has(fingerprint("editorial", "idea", theme.cluster, tp.name)) && !topicCovered(tp, d.articles));
      if (!topic) continue;
      // The editorial engine's own fingerprint for this topic: it is never suggested twice.
      const fp = fingerprint("editorial", "idea", theme.cluster, topic.name);
      const id = await insert(db, fp, {
        title: fitTitle(`${topic.name}: a practical guide`),
        kind: "editorial_idea",
        source: "analytics",
        category: theme.category,
        cluster: theme.cluster,
        score: 0.5,
        band: "medium",
        brief: {
          audience: theme.audience,
          intent: "explainer",
          supportingQueries: [],
          gap: `Readers engage with "${article.title}" (${Math.round(Number(t.engaged))} engaged sessions in 28 days, ${Math.round(Number(t.seconds ?? 0))} s per session in Google Analytics); ${topic.name} is the next topic in ${theme.cluster} the publication has not covered.`,
          codeExamples: [theme.code],
          diagrams: [theme.diagram],
          internalLinks: [{ id: article.id, title: article.title, path: article.path }],
          readingTimeMinutes: 8,
          notes: `Scope: ${topic.name}. A follow-up for readers of ${article.path}: link to it rather than repeat it.`,
        },
        evidence: [
          { metric: "engaged_sessions", period: "28d", value: Math.round(Number(t.engaged)), valueText: article.path, source: "ga4" },
          { metric: "engagement_seconds_per_session", period: "28d", value: Math.round(Number(t.seconds ?? 0)), source: "ga4" },
        ],
      });
      if (id) {
        known.add(fp);
        n++;
      }
      break; // one follow-up per article
    }
  }
  return n;
}

/** Add automatic ideas from every source; a failing source is logged and skipped, never stopping the others. */
export async function addAutomaticIdeas(db: Db, d: AnalysisData, now = new Date()): Promise<Added> {
  const added: Added = { ask: 0, promotion: 0, ml: 0, analytics: 0 };
  const known = await knownFingerprints(db);
  const run: [AutoSource, (room: number) => Promise<number>][] = [
    ["ask", (room) => fromAskGaps(db, d, known, room)],
    ["promotion", (room) => fromPromotionIdeas(db, d, known, room)],
    ["ml", (room) => fromMlClusters(db, d, known, room, now)],
    ["analytics", (room) => fromAnalytics(db, d, known, room, now)],
  ];
  for (const [source, fn] of run) {
    const room = OPEN_CAP - (await openAutoItems(db));
    if (room <= 0) break;
    try {
      added[source] = await fn(room);
    } catch (err) {
      log.warn("automatic calendar ideas: a source failed", { operation: "calendar_auto", source, err });
    }
  }
  return added;
}

/** For tests and the user guide. */
export const AUTO_SOURCE_LABELS: Record<AutoSource, string> = { ask: "AI: reader questions", promotion: "AI: Promotion ideas", ml: "ML query clusters", analytics: "Google Analytics" };
