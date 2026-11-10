import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import { rowsOf } from "@/db/rows";
import { blocksOf, linksIn, type BaseSnapshot, type Change } from "./changeset";
import { headingsOf } from "./audit-article";
import type { SeoSettings } from "./settings";
import { siteOrigin } from "./urls";

/**
 * v2 Phase 4: automated internal linking, conservative by design (docs/seo/INTERNAL_LINKING.md).
 *
 * Links are proposed as ordinary draft changes (type internal_link) and reviewed like any other change. Claude never
 * writes links. Hard limits (Settings → Internal linking):
 * - ≤ maxNewPerDraft new links per article per draft; total internal links (existing + new) ≤ 1 per wordsPerLink
 *   words; an article already at or above that density gets none;
 * - one link per target per article; never to self, drafts, noindex, canonicalised-elsewhere or missing pages;
 * - never inside headings, code, tables, image paragraphs/captions, the article's first sentence or existing links;
 *   ≥ minWordsBetween words between new links;
 * - ≤ maxInboundPerTargetPerRun new inbound links to one target per rolling 7 days (one "weekly run");
 * - relevance (TF-IDF cosine on title/headings/body + shared Search Console queries + category + tags) must clear
 *   minRelevance; tutorial-path signals (series parts, prerequisite mentions) and orphan targets are preferred.
 * Anchors are phrases that already exist in the paragraph (2–6 words), never new sentences, and never the same
 * exact anchor another article already uses for that target.
 */
export type LinkDoc = { id: string; path: string; title: string; body: string; category: string; tags: string[]; publishedAt: string | null; queries: string[] };
export type Limits = SeoSettings["links"];
export type Planned = { target: string; targetTitle: string; anchor: string; blockId: string; headingPath: string; score: number; reasons: string[] };
export type PlanResult = { planned: Planned[]; skipped: string | null; words: number; existing: number; cap: number };

const STOP = new Set("a about above after again against all am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers him his how i if in into is it its itself just me more most my no nor not now of off on once only or other our out over own same she should so some such than that the their them then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours using use used via vs also get set one two new how-to guide part".split(" "));
const tokenize = (s: string) => (s.toLowerCase().replace(/(```|~~~)[\s\S]*?\1/g, " ").replace(/`[^`]*`/g, " ").replace(/\]\([^)]*\)/g, "]").match(/[a-z][a-z0-9+#.-]*[a-z0-9+#]|[a-z]/g) ?? []).filter((w) => w.length > 2 && !STOP.has(w));
export const proseWords = (body: string) => (body.replace(/(```|~~~)[\s\S]*?\1/g, " ").replace(/!\[[^\]]*\]\([^)]*\)/g, " ").match(/\S+/g) ?? []).length;
export const internalLinksOf = (body: string) => linksIn(body).map((u) => u.split("#")[0]!.replace(/\/+$/, "")).filter((u) => u.startsWith("/") && !u.startsWith("/media/") && !u.startsWith("/images/"));

/** TF-IDF vectors for the corpus (title ×3, headings ×2, body ×1). */
export function tfidf(docs: LinkDoc[]): Map<string, Map<string, number>> {
  const tf = new Map<string, Map<string, number>>();
  const df = new Map<string, number>();
  for (const d of docs) {
    const counts = new Map<string, number>();
    const add = (text: string, w: number) => {
      for (const t of tokenize(text)) counts.set(t, (counts.get(t) ?? 0) + w);
    };
    add(d.title, 3);
    add(headingsOf(d.body).map((h) => h.text).join(" "), 2);
    add(d.body, 1);
    tf.set(d.path, counts);
    for (const t of counts.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const n = docs.length || 1;
  const out = new Map<string, Map<string, number>>();
  for (const [path, counts] of tf) {
    const v = new Map<string, number>();
    let norm = 0;
    for (const [t, c] of counts) {
      const w = (1 + Math.log(c)) * Math.log(1 + n / (df.get(t) ?? 1));
      v.set(t, w);
      norm += w * w;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [t, w] of v) v.set(t, w / norm);
    out.set(path, v);
  }
  return out;
}

export function cosine(a: Map<string, number> | undefined, b: Map<string, number> | undefined): number {
  if (!a || !b) return 0;
  let s = 0;
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  for (const [t, w] of small) s += w * (big.get(t) ?? 0);
  return s;
}

const jaccard = (a: Iterable<string>, b: Iterable<string>) => {
  const x = new Set(a);
  const y = new Set(b);
  if (!x.size || !y.size) return 0;
  let i = 0;
  for (const v of x) if (y.has(v)) i++;
  return i / (x.size + y.size - i);
};

/** "…-part-1" → "…": articles of one series share this stem. */
const seriesStem = (path: string) => /^(.*)-part-?(\d+)$/.exec(path.split("/").pop() ?? "")?.[1] ?? null;
const seriesPart = (path: string) => Number(/-part-?(\d+)$/.exec(path)?.[1] ?? NaN);

export type Graph = { inbound: Map<string, number>; outbound: Map<string, string[]>; anchorsByTarget: Map<string, Set<string>> };

/** Internal-link graph of the published corpus: inbound counts, outbound targets and anchors used per target. */
export function linkGraph(docs: LinkDoc[]): Graph {
  const known = new Set(docs.map((d) => d.path));
  const inbound = new Map<string, number>(docs.map((d) => [d.path, 0]));
  const outbound = new Map<string, string[]>();
  const anchorsByTarget = new Map<string, Set<string>>();
  for (const d of docs) {
    const out = [...new Set(internalLinksOf(d.body))].filter((p) => p !== d.path);
    outbound.set(d.path, out);
    for (const p of out) if (known.has(p)) inbound.set(p, (inbound.get(p) ?? 0) + 1);
    for (const m of d.body.matchAll(/(?<!!)\[([^\]]+)\]\((\/[^)\s#]*)/g)) {
      const t = m[2]!.replace(/\/+$/, "");
      if (!anchorsByTarget.has(t)) anchorsByTarget.set(t, new Set());
      anchorsByTarget.get(t)!.add(m[1]!.replace(/[*_`]/g, "").trim().toLowerCase());
    }
  }
  return { inbound, outbound, anchorsByTarget };
}

/** Candidate anchor phrases for a target: its title's 2–6-word runs and its top search queries, longest first. */
export function anchorPhrases(target: LinkDoc, limits: Limits): string[] {
  const phrases = new Set<string>();
  // Keep apostrophes ("Let's"); split on punctuation that separates phrases.
  const words = target.title.replace(/[:–—|()[\],"?!]/g, " ").split(/\s+/).filter(Boolean);
  for (let n = Math.min(limits.anchorMaxWords, words.length); n >= limits.anchorMinWords; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      const run = words.slice(i, i + n);
      if (STOP.has(run[0]!.toLowerCase()) || STOP.has(run[n - 1]!.toLowerCase())) continue;
      if (run.filter((w) => !STOP.has(w.toLowerCase())).length < Math.min(2, n)) continue;
      phrases.add(run.join(" ").toLowerCase());
    }
  }
  for (const q of target.queries.slice(0, 5)) {
    const n = q.split(/\s+/).length;
    if (n >= limits.anchorMinWords && n <= limits.anchorMaxWords) phrases.add(q.toLowerCase());
  }
  return [...phrases].sort((a, b) => b.split(" ").length - a.split(" ").length || b.length - a.length);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Character ranges inside a paragraph that may not hold a new link: existing links/images, inline code, raw HTML. */
function forbiddenRanges(text: string): [number, number][] {
  const out: [number, number][] = [];
  for (const m of text.matchAll(/!?\[[^\]]*\]\([^)]*\)|`[^`]*`|<[^>]+>|https?:\/\/\S+/g)) out.push([m.index!, m.index! + m[0].length]);
  return out;
}

/**
 * Plan new links for one source article (pure). `inboundThisRun` counts new links already proposed to each target in
 * the current rolling week; it is updated with this plan's picks.
 */
export function planLinks(source: LinkDoc, corpus: LinkDoc[], graph: Graph, vectors: Map<string, Map<string, number>>, limits: Limits, inboundThisRun: Map<string, number>, opts: { body?: string } = {}): PlanResult {
  const body = opts.body ?? source.body;
  const words = proseWords(body);
  const existingLinks = internalLinksOf(body);
  const cap = Math.floor(words / limits.wordsPerLink);
  if (existingLinks.length >= cap) return { planned: [], skipped: `already at the link density cap (${existingLinks.length} links, cap ${cap} for ${words} words)`, words, existing: existingLinks.length, cap };
  const budget = Math.min(limits.maxNewPerDraft, cap - existingLinks.length);
  if (budget <= 0) return { planned: [], skipped: "no link budget", words, existing: existingLinks.length, cap };
  const already = new Set(existingLinks);
  const srcVec = vectors.get(source.path);
  const lowerBody = body.toLowerCase();

  const scored = corpus
    .filter((t) => t.path !== source.path && !already.has(t.path))
    .map((t) => {
      const cos = cosine(srcVec, vectors.get(t.path));
      const q = jaccard(source.queries, t.queries);
      const cat = source.category === t.category ? 1 : 0;
      const tags = jaccard(source.tags.map((x) => x.toLowerCase()), t.tags.map((x) => x.toLowerCase()));
      const relevance = 0.55 * cos + 0.25 * q + 0.1 * cat + 0.1 * tags;
      const reasons = [`content similarity ${cos.toFixed(2)}`];
      if (q > 0) reasons.push(`shares ${Math.round(q * 100)}% of search queries`);
      if (cat) reasons.push("same category");
      if (tags > 0) reasons.push("shared tags");
      // Tutorial path: series parts (next/previous), or the source mentions an earlier article's subject.
      let path = 0;
      const stem = seriesStem(source.path);
      if (stem && stem === seriesStem(t.path)) {
        path = 0.15;
        reasons.push(seriesPart(t.path) < seriesPart(source.path) ? "previous part of this series" : "next part of this series");
      } else if (t.publishedAt && source.publishedAt && t.publishedAt < source.publishedAt && cat && anchorPhrases(t, limits).some((ph) => lowerBody.includes(ph))) {
        // An earlier article on the same topic whose subject the source mentions: likely a prerequisite step.
        path = 0.05;
        reasons.push("likely prerequisite (earlier article on the same topic, mentioned here)");
      }
      const orphan = (graph.inbound.get(t.path) ?? 0) === 0;
      if (orphan) reasons.push("orphan: no other article links to it yet");
      return { t, relevance, score: relevance + path + (orphan ? 0.1 : 0), orphan, reasons };
    })
    .filter((c) => c.relevance >= limits.minRelevance)
    .sort((a, b) => Number(b.orphan) - Number(a.orphan) || b.score - a.score);

  // Eligible text: paragraphs and list items only; skip image paragraphs (captions) and the first sentence.
  const blocks = blocksOf(body).filter((b) => (b.kind === "paragraph" || b.kind === "list") && !b.hasImage);
  const firstPara = blocksOf(body).find((b) => b.kind === "paragraph");
  const firstSentenceEnd = firstPara ? firstPara.start + (/[.!?](\s|$)/.exec(firstPara.source)?.index ?? firstPara.source.length) + 1 : 0;
  const wordOffset = (abs: number) => (body.slice(0, abs).replace(/(```|~~~)[\s\S]*?\1/g, " ").match(/\S+/g) ?? []).length;

  const planned: Planned[] = [];
  const takenOffsets: number[] = [];
  for (const c of scored) {
    if (planned.length >= budget) break;
    if ((inboundThisRun.get(c.t.path) ?? 0) >= limits.maxInboundPerTargetPerRun) continue;
    const used = graph.anchorsByTarget.get(c.t.path) ?? new Set<string>();
    let pick: Planned | null = null;
    for (const phrase of anchorPhrases(c.t, limits)) {
      if (used.has(phrase)) continue; // no repeated exact-match anchor to the same target across the site
      const re = new RegExp(`(?<![\\w-])${escapeRe(phrase)}(?![\\w-])`, "gi");
      for (const b of blocks) {
        const matches = [...b.source.matchAll(re)];
        if (matches.length !== 1) continue; // the change's "before" must be unique in its block
        const m = matches[0]!;
        const start = m.index!;
        const end = start + m[0].length;
        if (forbiddenRanges(b.source).some(([s, e]) => start < e && end > s)) continue;
        // Inside emphasis markers or across a line break: leave it alone.
        if (/[*_\n]/.test(m[0])) continue;
        const abs = b.start + start;
        if (abs < firstSentenceEnd) continue;
        const wo = wordOffset(abs);
        const existingNear = internalLinksOf(b.source).length > 0 && b.source.length < 400; // keep short paragraphs to one link
        if (existingNear) continue;
        if (takenOffsets.some((o) => Math.abs(o - wo) < limits.minWordsBetween)) continue;
        pick = { target: c.t.path, targetTitle: c.t.title, anchor: m[0], blockId: b.id, headingPath: b.headingPath, score: Number(c.score.toFixed(3)), reasons: c.reasons };
        takenOffsets.push(wo);
        break;
      }
      if (pick) break;
    }
    if (pick) {
      planned.push(pick);
      inboundThisRun.set(c.t.path, (inboundThisRun.get(c.t.path) ?? 0) + 1);
    }
  }
  return { planned, skipped: planned.length ? null : "no natural anchor phrase found for a relevant target", words, existing: existingLinks.length, cap };
}

// --- DB wrapper ---------------------------------------------------------------------------------------------------

export async function loadLinkCorpus(db: Db): Promise<LinkDoc[]> {
  const origin = siteOrigin().origin;
  const posts = rowsOf<{ id: string; collection: string; slug: string; title: string; body: string; category: string; tags: string[] | null; published_at: string | null }>(
    await db.execute(sql`select id, collection, slug, title, body, category, tags, published_at::text from post where deleted_at is null and status = 'published' and noindex = false and (canonical_url is null or canonical_url = '') and (published_at is null or published_at <= now())`),
  );
  const q = rowsOf<{ page: string; query: string }>(
    await db.execute(sql`
      select page, query from (
        select page, query, row_number() over (partition by page order by sum(impressions) desc) as rn
        from seo_gsc_query_daily where search_type = 'web' and date > (select max(date) - 28 from seo_gsc_query_daily) group by page, query
      ) x where rn <= 15`),
  );
  const byPage = new Map<string, string[]>();
  for (const r of q) byPage.set(r.page, [...(byPage.get(r.page) ?? []), r.query]);
  return posts.map((p) => {
    const path = `/${p.collection}/${p.slug}`;
    return { id: p.id, path, title: p.title, body: p.body ?? "", category: p.category, tags: p.tags ?? [], publishedAt: p.published_at, queries: byPage.get(`${origin}${path}`) ?? [] };
  });
}

/** New inbound links proposed or published to each target in the last 7 days (the rolling "weekly run"). */
export async function recentInbound(db: Db): Promise<Map<string, number>> {
  const rows = rowsOf<{ target: string; n: number }>(
    await db.execute(sql`
      select c->>'target' as target, count(*)::int as n
      from seo_drafts d, jsonb_array_elements(d.changes) c
      where d.created_at > now() - interval '7 days' and d.status not in ('rejected', 'superseded', 'generation_failed')
        and c->>'type' = 'internal_link' and c->>'decision' <> 'rejected'
      group by 1`),
  );
  return new Map(rows.map((r) => [r.target, Number(r.n)]));
}

/** Draft changes for one article (used by drafts.ts). */
export async function linkChangesFor(db: Db, s: SeoSettings, base: BaseSnapshot, articleId: string, evidence: string[], startAt: number): Promise<Change[]> {
  if (!s.links.enabled || s.links.maxNewPerDraft === 0) return [];
  const corpus = await loadLinkCorpus(db);
  const path = `/${base.collection}/${base.slug}`;
  const source = corpus.find((d) => d.path === path) ?? { id: articleId, path, title: base.title, body: base.body, category: "", tags: [], publishedAt: null, queries: [] };
  const plan = planLinks(source, corpus, linkGraph(corpus), tfidf(corpus.some((d) => d.path === path) ? corpus : [...corpus, source]), s.links, await recentInbound(db), { body: base.body });
  return plan.planned.map((p, i) => ({
    id: `c${startAt + i}`,
    type: "internal_link" as const,
    location: { blockId: p.blockId, headingPath: p.headingPath || null, field: null },
    before: p.anchor,
    after: `[${p.anchor}](${p.target})`,
    rationale: `Link “${p.anchor}” to “${p.targetTitle}”: ${p.reasons.join("; ")}. Relevance score ${p.score}.`,
    evidenceRef: evidence,
    sourceUrls: [],
    origin: "rules" as const,
    decision: "pending" as const,
    edited: null,
    flags: [],
    target: p.target,
  }));
}

/** Internal Linking page: per-article inbound/outbound counts, orphans, over-linked, pending link changes. */
export async function linkReport(db: Db, s: SeoSettings) {
  const corpus = await loadLinkCorpus(db);
  const g = linkGraph(corpus);
  const rows = corpus.map((d) => {
    const words = proseWords(d.body);
    const out = internalLinksOf(d.body).length;
    const cap = Math.max(1, Math.floor(words / s.links.wordsPerLink));
    return { id: d.id, path: d.path, title: d.title, inbound: g.inbound.get(d.path) ?? 0, outbound: out, uniqueOutbound: g.outbound.get(d.path)?.length ?? 0, words, cap, overLinked: out > cap };
  });
  const pending = rowsOf<{ draft_id: string; article_id: string; title: string; change: Change }>(
    await db.execute(sql`
      select d.id as draft_id, d.article_id, p.title, c as change
      from seo_drafts d join post p on p.id = d.article_id, jsonb_array_elements(d.changes) c
      where d.status = 'ready_for_review' and c->>'type' = 'internal_link'
      order by d.created_at desc limit 300`),
  ).map((r) => ({ ...r, change: (typeof r.change === "string" ? JSON.parse(r.change) : r.change) as Change }));
  return {
    rows: rows.sort((a, b) => a.inbound - b.inbound || a.title.localeCompare(b.title)),
    orphans: rows.filter((r) => r.inbound === 0),
    overLinked: rows.filter((r) => r.overLinked),
    pending,
    edges: corpus.flatMap((d) => (g.outbound.get(d.path) ?? []).filter((t) => g.inbound.has(t)).map((t) => ({ from: d.path, to: t }))),
  };
}
