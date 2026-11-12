import { similarity, tokens } from "../keywords";
import type { ChannelId, PromotionSettings } from "./settings";

/**
 * Promotion channels, the deterministic opportunity score and the checks on a drafted post (docs/seo/PROMOTION.md).
 * Pure functions: no database, no network, no model. The score only orders channels and explains itself; it predicts
 * nothing, and every reason shown to the owner comes from data the site has (the article, Search Console clicks,
 * Reddit threads that were actually fetched).
 */
export type Channel = {
  id: ChannelId;
  label: string;
  /** Where a person posts it. Every channel is posted by hand: the system never posts anywhere. */
  postUrl: string | null;
  base: number;
  /** Upper bound for the drafted body, in characters. */
  maxChars: number;
  /** The channel has a separate title/headline field. */
  hasTitle: boolean;
  /** The link belongs in the body (false: the channel has its own URL field, or the link goes in a first comment). */
  linkInBody: boolean;
  /** How to write for this channel; sent to the copywriter and shown to the owner. */
  guidance: string;
};

export const CHANNELS: Record<ChannelId, Channel> = {
  linkedin: {
    id: "linkedin",
    label: "LinkedIn",
    postUrl: "https://www.linkedin.com/feed/",
    base: 60,
    maxChars: 1300,
    hasTitle: false,
    linkInBody: false,
    guidance: "First line is the hook (a result or a problem, no clickbait). 3 to 5 short paragraphs or bullet points with the concrete takeaways, one closing question. No hashtag wall (0 to 3). Put the link in the first comment, not in the post.",
  },
  reddit: {
    id: "reddit",
    label: "Reddit",
    postUrl: "https://www.reddit.com/submit",
    base: 45,
    maxChars: 1500,
    hasTitle: true,
    linkInBody: true,
    guidance: "A text post that stands on its own: the problem, what was tried, what worked, with the key config or numbers inline. Plain, first person, no marketing words. One link at the end as the full write-up. Check the subreddit's self-promotion rule before posting.",
  },
  hackernews: {
    id: "hackernews",
    label: "Hacker News",
    postUrl: "https://news.ycombinator.com/submit",
    base: 35,
    maxChars: 600,
    hasTitle: true,
    linkInBody: false,
    guidance: "Title only (max 80 characters): factual, specific, no superlatives, no emoji, the article's own claim. The body is an optional first comment of 2 to 4 sentences with context the article lacks. The URL goes in the URL field.",
  },
  facebook: {
    id: "facebook",
    label: "Facebook groups",
    postUrl: "https://www.facebook.com/groups/feed/",
    base: 40,
    maxChars: 900,
    hasTitle: false,
    linkInBody: true,
    guidance: "Written for a group of practitioners and learners: the problem in one sentence, 3 takeaways as short lines, then the link. Friendly and plain. Check the group's rules on links before posting.",
  },
  x: {
    id: "x",
    label: "X",
    postUrl: "https://x.com/compose/post",
    base: 40,
    maxChars: 280,
    hasTitle: false,
    linkInBody: true,
    guidance: "One post of at most 280 characters including the link: the single most useful finding, stated plainly. At most one hashtag.",
  },
  devto: {
    id: "devto",
    label: "DEV Community",
    postUrl: "https://dev.to/new",
    base: 50,
    maxChars: 700,
    hasTitle: true,
    linkInBody: true,
    guidance: "A cross-post note: the article title, a 2 to 3 sentence introduction and up to 4 tags (lower case, no spaces). Republish the full article there with canonical_url set to the original link so search engines credit the site.",
  },
  hashnode: {
    id: "hashnode",
    label: "Hashnode",
    postUrl: "https://hashnode.com/",
    base: 45,
    maxChars: 700,
    hasTitle: true,
    linkInBody: true,
    guidance: "A cross-post note: the article title, a 2 to 3 sentence introduction and up to 5 tags. Republish the full article there with the original URL set as the canonical ('Are you republishing?').",
  },
  newsletter: {
    id: "newsletter",
    label: "Newsletter submission",
    postUrl: null,
    base: 35,
    maxChars: 500,
    hasTitle: true,
    linkInBody: true,
    guidance: "A submission blurb for a curated newsletter (for example KubeWeekly, DevOps Weekly, SRE Weekly): the title and 2 sentences on what a reader learns, neutral tone, third person, then the link.",
  },
};

export type ArticleFacts = {
  title: string;
  contentType: string;
  category: string;
  tags: string[];
  words: number;
  publishedAt: string | null;
  clicks28d: number;
};
export type Thread = { community: string; title: string; url: string; score: number; comments: number };
export type Scored = { channel: ChannelId; score: number; reasons: string[] };

const EXPERIENCE = /\b(migrat\w*|replac\w*|broke\w*|lessons?|post-?mortem|benchmark\w*|how (i|we)\b|why (i|we)\b|what (i|we) learned|in production)\b/i;
const HOWTO = /^(how to|a guide to|guide:|setting up|set up|install\w*|deploy\w*|getting started)\b/i;
const TUTORIAL_TYPES = new Set(["tutorial", "guide", "how-to", "howto"]);
const NEWSLETTER_CATEGORIES = new Set(["kubernetes", "devops-sre", "cloud-native", "sre", "devops", "platform-engineering"]);

/** Threads about the same subject as the article: at least two shared (stemmed) words between the titles and tags. */
export function matchThreads(article: Pick<ArticleFacts, "title" | "tags">, threads: Thread[], limit = 5): Thread[] {
  const a = tokens(`${article.title} ${article.tags.join(" ")}`);
  if (!a.size) return [];
  const out: { t: Thread; s: number }[] = [];
  for (const t of threads) {
    const b = tokens(t.title);
    let shared = 0;
    for (const w of b) if (a.has(w)) shared++;
    if (shared >= 2) out.push({ t, s: similarity(a, b) });
  }
  return out.sort((x, y) => y.s - x.s || y.t.score - x.t.score).slice(0, limit).map((x) => x.t);
}

const daysSince = (iso: string | null, now: Date) => (iso ? Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000)) : null);

/** One score per enabled channel, highest first, each with the reasons behind it. */
export function scoreChannels(article: ArticleFacts, threads: Thread[], enabled: ChannelId[], now = new Date()): Scored[] {
  const age = daysSince(article.publishedAt, now);
  const tutorial = TUTORIAL_TYPES.has(article.contentType.toLowerCase()) || HOWTO.test(article.title);
  const experience = EXPERIENCE.test(article.title);
  const traction = Math.min(15, Math.floor(article.clicks28d / 10));
  return enabled
    .map((id) => {
      const c = CHANNELS[id];
      let score = c.base;
      const reasons: string[] = [];
      if (age !== null && age <= 14) {
        score += 10;
        reasons.push(`Published ${age === 0 ? "today" : `${age} day${age === 1 ? "" : "s"} ago`}: new articles are easiest to share.`);
      } else if (age !== null && age > 180) {
        score -= 10;
        reasons.push(`Published ${age} days ago: check it is still current before sharing.`);
      }
      if (traction > 0) {
        score += traction;
        reasons.push(`${Math.round(article.clicks28d)} search clicks in the last 28 days (Search Console): readers already look for this.`);
      }
      if (id === "reddit") {
        if (threads.length >= 3) score += 25;
        else if (threads.length >= 1) score += 15;
        if (threads.length) reasons.push(`${threads.length} thread${threads.length === 1 ? "" : "s"} on this subject this week in ${[...new Set(threads.map((t) => `r/${t.community}`))].slice(0, 3).join(", ")}.`);
        else reasons.push("No matching thread was found in the configured subreddits this week.");
      }
      if (id === "hackernews" && experience) {
        score += 15;
        reasons.push("The title reads as a first-hand experience report, which Hacker News favours over tutorials.");
      }
      if ((id === "devto" || id === "hashnode" || id === "facebook") && tutorial) {
        score += 10;
        reasons.push("A how-to: tutorials do well with learners on this channel.");
      }
      if (id === "linkedin" && experience) {
        score += 10;
        reasons.push("A first-hand account suits a professional audience.");
      }
      if (id === "newsletter" && NEWSLETTER_CATEGORIES.has(article.category) && article.words >= 1200) {
        score += 15;
        reasons.push(`An in-depth ${article.category} article (${article.words} words): the kind curated newsletters link to.`);
      }
      if ((id === "devto" || id === "hashnode") && article.words < 500) {
        score -= 10;
        reasons.push(`Short (${article.words} words): little to cross-post.`);
      }
      return { channel: id, score: Math.max(0, Math.min(100, Math.round(score))), reasons };
    })
    .sort((a, b) => b.score - a.score || a.channel.localeCompare(b.channel));
}

export const band = (score: number): "high" | "medium" | "low" => (score >= 70 ? "high" : score >= 50 ? "medium" : "low");

/** The article URL tagged for this channel, so analytics can attribute the visit. */
export function promoLink(origin: URL, path: string, channel: ChannelId, s: Pick<PromotionSettings, "utmMedium" | "utmCampaign">): string {
  const u = new URL(path, origin);
  u.searchParams.set("utm_source", channel);
  u.searchParams.set("utm_medium", s.utmMedium);
  u.searchParams.set("utm_campaign", s.utmCampaign);
  return u.toString();
}

const URL_RE = /https?:\/\/[^\s<>()"']+/gi;

/**
 * Checks on a drafted (or edited) post, as sentences for the reviewer. They never block saving: the owner decides.
 * `allowed` are URLs the draft may contain besides the site's own (the Reddit threads given as evidence).
 */
export function checkDraft(channel: ChannelId, draft: { title?: string | null; body: string }, link: string, origin: URL, allowed: string[] = []): string[] {
  const c = CHANNELS[channel];
  const flags: string[] = [];
  const body = draft.body ?? "";
  if (body.length > c.maxChars) flags.push(`${body.length} characters: ${c.label} posts should stay under ${c.maxChars}.`);
  if (channel === "hackernews" && (draft.title ?? "").length > 80) flags.push("Hacker News titles are limited to 80 characters.");
  if (c.hasTitle && !(draft.title ?? "").trim()) flags.push("No title.");
  const urls = body.match(URL_RE) ?? [];
  const ok = new Set(allowed.map((u) => u.replace(/[.,;:!?]+$/, "")));
  const foreign = urls.map((u) => u.replace(/[.,;:!?]+$/, "")).filter((u) => {
    try {
      const h = new URL(u).host.replace(/^www\./, "");
      return h !== origin.host.replace(/^www\./, "") && !ok.has(u);
    } catch {
      return true;
    }
  });
  if (foreign.length) flags.push(`Contains ${foreign.length} link${foreign.length === 1 ? "" : "s"} not to this site (${foreign.slice(0, 2).join(", ")}): check ${foreign.length === 1 ? "it" : "them"}.`);
  const bare = link.split("?")[0]!;
  if (c.linkInBody && !body.includes(bare)) flags.push("The article link is missing from the text.");
  if (!c.linkInBody && body.includes(bare)) flags.push(`${c.label}: keep the link out of the text (${channel === "hackernews" ? "it goes in the URL field" : "put it in the first comment"}).`);
  return flags;
}

/** Stable key for an idea: its title's distinct stemmed words, sorted. "How to X" and "X: how to" collide on purpose. */
export function ideaFingerprint(title: string): string {
  return [...tokens(title)].sort().join("-").slice(0, 200);
}

/** True when two titles are about the same thing (used to drop ideas the site has already covered). */
export const sameSubject = (a: string, b: string, threshold = 0.6) => similarity(tokens(a), tokens(b)) >= threshold;
