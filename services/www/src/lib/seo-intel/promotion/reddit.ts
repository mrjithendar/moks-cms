import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { rowsOf } from "@/db/rows";
import { log } from "../../log";
import { safeQueries } from "../llm";
import { getPromotionSettings } from "./settings";

/**
 * Reddit, read-only (docs/seo/PROMOTION.md "Reddit"). Application-only OAuth (client credentials of a registered
 * "script" app): the top threads of the week in the configured subreddits. Nothing is ever posted, voted on or
 * messaged, and no user data is stored: only a thread's id, subreddit, title, permalink, score and comment count.
 *
 * Requires manual configuration: REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET (Secret jithendar-com-env) from
 * https://www.reddit.com/prefs/apps, and optionally REDDIT_USER_AGENT. Without them every call reports
 * "not_configured" and promotion works from Search Console data alone.
 */
export type RedditConfig = { clientId: string; clientSecret: string; userAgent: string };
export type RedditDeps = { fetchImpl?: typeof fetch; env?: Record<string, string | undefined>; now?: Date };
export type RedditStatus = "connected" | "not_configured" | "auth_error" | "error";

const TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
const API = "https://oauth.reddit.com";
const TIMEOUT_MS = 10_000;

export function redditConfig(env: Record<string, string | undefined> = process.env): RedditConfig | null {
  const clientId = env.REDDIT_CLIENT_ID?.trim();
  const clientSecret = env.REDDIT_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  // Reddit asks for a unique, descriptive User-Agent: <platform>:<app id>:<version> (by /u/<username>).
  const userAgent = env.REDDIT_USER_AGENT?.trim() || "web:com.jithendar.promotion:v1.0 (+https://jithendar.com)";
  return { clientId, clientSecret, userAgent };
}

export class RedditError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly kind: Exclude<RedditStatus, "connected">,
  ) {
    super(message);
  }
}

let cached: { token: string; expiresAt: number; clientId: string } | null = null;
/** Tests reset the in-process token cache. */
export const _resetRedditToken = () => {
  cached = null;
};

async function accessToken(cfg: RedditConfig, deps: RedditDeps): Promise<string> {
  const now = (deps.now ?? new Date()).getTime();
  if (cached && cached.clientId === cfg.clientId && cached.expiresAt > now + 60_000) return cached.token;
  let res: Response;
  try {
    res = await (deps.fetchImpl ?? fetch)(TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": cfg.userAgent,
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    throw new RedditError("Reddit could not be reached.", 0, "error");
  }
  if (res.status === 401 || res.status === 403) throw new RedditError("Reddit refused the client id or secret.", res.status, "auth_error");
  if (!res.ok) throw new RedditError(`Reddit answered ${res.status} to the token request.`, res.status, "error");
  const data = (await res.json().catch(() => ({}))) as { access_token?: unknown; expires_in?: unknown };
  if (typeof data.access_token !== "string" || !data.access_token) throw new RedditError("Reddit returned no access token.", res.status, "auth_error");
  const ttl = typeof data.expires_in === "number" && data.expires_in > 0 ? data.expires_in : 3600;
  cached = { token: data.access_token, expiresAt: now + ttl * 1000, clientId: cfg.clientId };
  return cached.token;
}

export type RedditThread = { id: string; community: string; title: string; url: string; score: number; comments: number; postedAt: string | null };

type Listing = { data?: { children?: { data?: Record<string, unknown> }[] } };

/** The week's top threads of one subreddit. Stickied, removed and adult posts are left out. */
export async function topThreads(subreddit: string, cfg: RedditConfig, deps: RedditDeps = {}, limit = 25): Promise<RedditThread[]> {
  const token = await accessToken(cfg, deps);
  let res: Response;
  try {
    res = await (deps.fetchImpl ?? fetch)(`${API}/r/${encodeURIComponent(subreddit)}/top?t=week&limit=${limit}&raw_json=1`, {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": cfg.userAgent },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    throw new RedditError(`r/${subreddit} could not be reached.`, 0, "error");
  }
  if (res.status === 401) {
    cached = null;
    throw new RedditError("Reddit rejected the access token.", 401, "auth_error");
  }
  if (!res.ok) throw new RedditError(`r/${subreddit} answered ${res.status}.`, res.status, "error");
  const listing = (await res.json().catch(() => ({}))) as Listing;
  const out: RedditThread[] = [];
  for (const child of listing.data?.children ?? []) {
    const d = child.data ?? {};
    const id = typeof d.id === "string" ? d.id : "";
    const title = typeof d.title === "string" ? d.title.trim() : "";
    const permalink = typeof d.permalink === "string" ? d.permalink : "";
    if (!/^[a-z0-9]{1,12}$/i.test(id) || !title || !permalink.startsWith("/r/")) continue;
    if (d.stickied === true || d.over_18 === true || d.removed_by_category) continue;
    out.push({
      id,
      community: typeof d.subreddit === "string" ? d.subreddit : subreddit,
      title: title.slice(0, 300),
      url: `https://www.reddit.com${permalink}`,
      score: Number(d.score) || 0,
      comments: Number(d.num_comments) || 0,
      postedAt: typeof d.created_utc === "number" ? new Date(d.created_utc * 1000).toISOString() : null,
    });
  }
  return out;
}

export type RedditSync = { status: RedditStatus; message: string; fetched: number; stored: number; errors: { community: string; error: string }[] };

/**
 * Fetch every configured subreddit and upsert the threads (seo_promo_signals). One failing subreddit (private, renamed)
 * does not stop the others; an authentication failure stops the run. Threads older than 60 days are pruned.
 */
export async function syncReddit(deps: RedditDeps = {}): Promise<RedditSync> {
  const cfg = redditConfig(deps.env);
  if (!cfg) return { status: "not_configured", message: "Reddit is not configured (REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET).", fetched: 0, stored: 0, errors: [] };
  const s = await getPromotionSettings();
  const db = await getDb();
  const errors: RedditSync["errors"] = [];
  let fetched = 0;
  let stored = 0;
  for (const sub of s.subreddits) {
    let threads: RedditThread[];
    try {
      threads = await topThreads(sub, cfg, deps);
    } catch (e) {
      if (e instanceof RedditError && e.kind === "auth_error") return { status: "auth_error", message: e.message, fetched, stored, errors };
      errors.push({ community: sub, error: e instanceof RedditError ? e.message : "failed" });
      continue;
    }
    fetched += threads.length;
    // Titles are user-written: drop any that look like they contain an email address, a phone number or a secret.
    const safe = new Set(safeQueries(threads.map((t) => t.title.slice(0, 120))));
    for (const t of threads) {
      if (t.score < s.redditMinScore || !safe.has(t.title.slice(0, 120))) continue;
      await db.execute(sql`
        insert into seo_promo_signals (source, external_id, community, title, url, score, comments, posted_at, fetched_at)
        values ('reddit', ${t.id}, ${t.community}, ${t.title}, ${t.url}, ${t.score}, ${t.comments}, ${t.postedAt}::timestamptz, now())
        on conflict (source, external_id) do update set title = excluded.title, score = excluded.score, comments = excluded.comments, fetched_at = now()`);
      stored++;
    }
  }
  await db.execute(sql`delete from seo_promo_signals where source = 'reddit' and fetched_at < now() - interval '60 days'`);
  if (errors.length) log.warn("reddit sync: some subreddits failed", { event: "promotion_reddit_partial", failed: errors.length });
  const status: RedditStatus = errors.length === s.subreddits.length && s.subreddits.length > 0 ? "error" : "connected";
  return { status, message: status === "connected" ? `${stored} thread${stored === 1 ? "" : "s"} stored from ${s.subreddits.length - errors.length} subreddit(s).` : "No subreddit could be read.", fetched, stored, errors };
}

/** A real request (token + one listing) for the admin page's "Test connection" button. */
export async function testReddit(deps: RedditDeps = {}): Promise<{ ok: boolean; status: RedditStatus; message: string }> {
  const cfg = redditConfig(deps.env);
  if (!cfg) return { ok: false, status: "not_configured", message: "Not configured: set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET in the Secret jithendar-com-env." };
  const s = await getPromotionSettings();
  const sub = s.subreddits[0] ?? "kubernetes";
  try {
    const threads = await topThreads(sub, cfg, deps, 5);
    return { ok: true, status: "connected", message: `Connected: read ${threads.length} thread${threads.length === 1 ? "" : "s"} from r/${sub}.` };
  } catch (e) {
    if (e instanceof RedditError) return { ok: false, status: e.kind, message: e.message };
    return { ok: false, status: "error", message: "The test failed." };
  }
}

/** What the admin page shows without calling Reddit: configured or not, and when threads were last stored. */
export async function redditState(env: Record<string, string | undefined> = process.env): Promise<{ configured: boolean; threads: number; lastFetched: string | null }> {
  const db = await getDb();
  const [r] = rowsOf<{ n: number; last: string | null }>(await db.execute(sql`select count(*)::int as n, max(fetched_at)::text as last from seo_promo_signals where source = 'reddit'`));
  return { configured: redditConfig(env) !== null, threads: Number(r?.n ?? 0), lastFetched: r?.last ? new Date(r.last).toISOString() : null };
}
