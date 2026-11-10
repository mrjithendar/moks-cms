import { sql } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
import { siteUrl } from "@/config/site";
import { audit } from "../audit";
import { indexNowKey } from "../indexnow-key";
import { enqueue, PermanentJobError } from "../jobs";
import { log } from "../log";
import type { Actor } from "../posts";
import { readServiceAccount, SCOPES } from "./google/auth";
import { GoogleApiError, googleJson, type ApiContext } from "./google/http";
import { getSeoSettings, submissionEnabled } from "./settings";

/**
 * v2 Phase 3: compliant search-engine submission (docs/seo/SUBMISSION.md). Submitting a URL is a crawl hint; it does
 * not guarantee indexing.
 *
 * - IndexNow (Bing, Yandex, Seznam, Naver, …): URLs are queued as rows and sent in one batched, deduplicated POST per
 *   minute (debounced job). Only real content changes are queued (posts.ts checks visible fields; SEO drafts submit
 *   only after the live page passed verification).
 * - Google: NO Indexing API (Google allows it only for JobPosting / BroadcastEvent pages). Instead the sitemap is
 *   resubmitted with Search Console `sitemaps.submit` (write scope; the service account needs Full or Owner
 *   permission), at most once per hour per sitemap, and a URL Inspection check is scheduled 2–3 days later; its result
 *   is shown as "Google's last-known state".
 * - Kill switch: SEO_SUBMISSION_ENABLED (default: on only in production). Every attempt — including skips — is logged
 *   in `seo_search_submissions` so the article's timeline explains what happened.
 */
export const SUBMIT_JOB_KIND = "seo_submit";
const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";
const INDEXNOW_MAX_URLS = 10_000;
const DEBOUNCE_MS = 60_000;
const SITEMAP_MIN_INTERVAL_MS = 60 * 60_000;

export type SubmitTarget = { draftId: string | null; articleId: string | null; path: string; reason: "publish" | "rollback" | "edit" };
export type SubmitDeps = { fetchImpl?: typeof fetch; now?: Date; env?: Record<string, string | undefined>; sleep?: (ms: number) => Promise<void> };

const absolute = (path: string) => `${siteUrl()}${path}`;

async function insertRow(db: Db, r: { url: string; engine: string; kind: string; articleId: string | null; draftId: string | null; reason: string; status: string; error?: string | null; nextAttemptAt?: string | null }) {
  const [row] = rowsOf<{ id: string }>(
    await db.execute(sql`
      insert into seo_search_submissions (url, engine, kind, article_id, draft_id, reason, status, error, next_attempt_at)
      values (${r.url}, ${r.engine}, ${r.kind}, ${r.articleId}, ${r.draftId}, ${r.reason}, ${r.status}, ${r.error ?? null}, ${r.nextAttemptAt ?? null})
      returning id`),
  );
  return row!.id;
}

/** Make sure an IndexNow key exists (served at /{key}.txt by the proxy). Generated once, automatically, audit-logged. */
export async function ensureIndexNowKey(actor: Actor | null): Promise<string | null> {
  const key = await indexNowKey();
  if (key) return key;
  const { indexNowSummary, setIndexNow } = await import("../integrations");
  const s = await indexNowSummary();
  if (s.source !== "none" || !actor || actor.role !== "admin") return null; // turned off on purpose, or no admin to act as
  await setIndexNow(actor, true);
  await audit(actor, "seo.submission.indexnow_key_generated", undefined, { reason: "first SEO submission" });
  return indexNowKey(Date.now() + 60_000);
}

/** Queue one URL for the next batched IndexNow POST (deduplicated while queued). */
export async function queueIndexNowUrl(db: Db, t: SubmitTarget, deps: SubmitDeps = {}): Promise<string | null> {
  const url = absolute(t.path);
  const [dup] = rowsOf<{ id: string }>(await db.execute(sql`select id from seo_search_submissions where engine = 'indexnow' and url = ${url} and status = 'queued' limit 1`));
  if (dup) {
    await insertRow(db, { url, engine: "indexnow", kind: "url", articleId: t.articleId, draftId: t.draftId, reason: t.reason, status: "deduplicated", error: "Already queued in the next batch." });
    return dup.id;
  }
  const id = await insertRow(db, { url, engine: "indexnow", kind: "url", articleId: t.articleId, draftId: t.draftId, reason: t.reason, status: "queued" });
  const now = deps.now ?? new Date();
  await enqueue(SUBMIT_JOB_KIND, { kind: "indexnow" }, { dedupeKey: "seo_submit:indexnow", runAt: new Date(now.getTime() + DEBOUNCE_MS), maxAttempts: 6 });
  return id;
}

/** After a verified publish or rollback: IndexNow + sitemap resubmission + a delayed URL Inspection check. */
export async function submitAfterPublish(db: Db, t: SubmitTarget, deps: SubmitDeps & { actor?: Actor | null } = {}): Promise<void> {
  const s = await getSeoSettings();
  const now = deps.now ?? new Date();
  const url = absolute(t.path);
  if (!submissionEnabled(deps.env)) {
    await insertRow(db, { url, engine: "all", kind: "url", articleId: t.articleId, draftId: t.draftId, reason: t.reason, status: "skipped", error: "Submission is off (SEO_SUBMISSION_ENABLED=false, or not production)." });
    return;
  }
  if (s.submission.indexNow) {
    const [d] = t.draftId ? rowsOf<{ decided_by_id: string | null }>(await db.execute(sql`select decided_by_id from seo_drafts where id = ${t.draftId}`)) : [];
    const [u] = d?.decided_by_id ? rowsOf<{ id: string; role: string; email: string }>(await db.execute(sql`select id, role, email from "user" where id = ${d.decided_by_id}`)) : [];
    const key = await ensureIndexNowKey(deps.actor ?? (u ? { id: u.id, role: u.role as Actor["role"], label: u.email } : null));
    if (key) await queueIndexNowUrl(db, t, deps);
    else await insertRow(db, { url, engine: "indexnow", kind: "url", articleId: t.articleId, draftId: t.draftId, reason: t.reason, status: "skipped", error: "IndexNow is turned off in Admin → Integrations." });
  }
  if (s.submission.googleSitemap) {
    const collection = t.path.split("/")[1];
    for (const sitemap of [`${siteUrl()}/sitemap.xml`, ...(collection === "news" ? [`${siteUrl()}/news-sitemap.xml`] : [])]) {
      await insertRow(db, { url: sitemap, engine: "google", kind: "sitemap", articleId: t.articleId, draftId: t.draftId, reason: t.reason, status: "queued" });
    }
    await enqueue(SUBMIT_JOB_KIND, { kind: "sitemap" }, { dedupeKey: "seo_submit:sitemap", runAt: new Date(now.getTime() + DEBOUNCE_MS), maxAttempts: 4 });
  }
  if (s.submission.urlInspection) {
    const at = new Date(now.getTime() + s.submission.inspectionDelayHours * 3_600_000);
    const id = await insertRow(db, { url, engine: "google", kind: "inspection", articleId: t.articleId, draftId: t.draftId, reason: t.reason, status: "scheduled", nextAttemptAt: at.toISOString() });
    await enqueue(SUBMIT_JOB_KIND, { kind: "inspect", id }, { dedupeKey: `seo_submit:inspect:${id}`, runAt: at, maxAttempts: 3 });
  }
  await audit({ id: null, label: "seo-submit" }, "seo.submission.queued", t.articleId ?? undefined, { url, reason: t.reason, indexNow: s.submission.indexNow, sitemap: s.submission.googleSitemap, inspection: s.submission.urlInspection });
}

// --- Job: batched sends ------------------------------------------------------------------------------------------

/** IndexNow payload for one host (the protocol takes up to 10,000 URLs per POST). */
export function indexNowPayload(urls: string[], key: string, host: string) {
  return { host, key, keyLocation: `https://${host}/${key}.txt`, urlList: [...new Set(urls)].sort().slice(0, INDEXNOW_MAX_URLS) };
}

export async function sendIndexNowBatch(db: Db, deps: SubmitDeps = {}): Promise<{ sent: number; status: number | null }> {
  const rows = rowsOf<{ id: string; url: string }>(await db.execute(sql`update seo_search_submissions set status = 'sending', attempts = attempts + 1 where id in (select id from seo_search_submissions where engine = 'indexnow' and status = 'queued' order by requested_at limit ${INDEXNOW_MAX_URLS}) returning id, url`));
  if (!rows.length) return { sent: 0, status: null };
  const ids = `{${rows.map((r) => r.id).join(",")}}`;
  const key = await indexNowKey();
  if (!key) {
    await db.execute(sql`update seo_search_submissions set status = 'error', error = 'No IndexNow key.' where id = any(${ids}::uuid[])`);
    return { sent: 0, status: null };
  }
  const host = new URL(siteUrl()).host;
  const payload = indexNowPayload(rows.map((r) => r.url).filter((u) => new URL(u).host === host), key, host);
  let res: Response;
  try {
    res = await (deps.fetchImpl ?? fetch)((deps.env ?? process.env).INDEXNOW_ENDPOINT ?? INDEXNOW_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    await db.execute(sql`update seo_search_submissions set status = 'queued', error = ${`Network error: ${(e as Error).message}`.slice(0, 300)} where id = any(${ids}::uuid[])`);
    throw new Error("IndexNow unreachable"); // the job retries with backoff
  }
  const code = res.status;
  if (code === 200 || code === 202) {
    await db.execute(sql`update seo_search_submissions set status = 'accepted', response_code = ${code}, sent_at = now(), error = null where id = any(${ids}::uuid[])`);
    log.info("indexnow batch accepted", { operation: "seo_submit", outcome: "accepted", count: payload.urlList.length });
    return { sent: payload.urlList.length, status: code };
  }
  if (code === 429 || code >= 500) {
    await db.execute(sql`update seo_search_submissions set status = 'queued', response_code = ${code}, error = ${`HTTP ${code}; will retry`} where id = any(${ids}::uuid[])`);
    throw new Error(`IndexNow HTTP ${code}`);
  }
  // 400 bad request, 403 key not valid, 422 URLs not on this host: retrying will not help.
  await db.execute(sql`update seo_search_submissions set status = 'error', response_code = ${code}, sent_at = now(), error = ${`IndexNow rejected the batch (HTTP ${code})`} where id = any(${ids}::uuid[])`);
  return { sent: 0, status: code };
}

function googleContext(deps: SubmitDeps, scope: string, provider: ApiContext["provider"]): ApiContext | null {
  const sa = readServiceAccount(deps.env ?? process.env);
  if (!sa) return null;
  return { sa, scope, provider, stats: { apiRequests: 0, retries: 0 }, maxRequests: 20, fetchImpl: deps.fetchImpl, sleep: deps.sleep };
}

export async function sendSitemapResubmits(db: Db, deps: SubmitDeps = {}): Promise<number> {
  const rows = rowsOf<{ id: string; url: string }>(await db.execute(sql`update seo_search_submissions set status = 'sending', attempts = attempts + 1 where engine = 'google' and kind = 'sitemap' and status = 'queued' returning id, url`));
  if (!rows.length) return 0;
  const s = await getSeoSettings();
  const ctx = googleContext(deps, SCOPES.searchConsoleWrite, "gsc_sitemaps");
  let sent = 0;
  for (const sitemap of [...new Set(rows.map((r) => r.url))]) {
    const ids = `{${rows.filter((r) => r.url === sitemap).map((r) => r.id).join(",")}}`;
    if (!ctx || !s.google.gscProperty) {
      await db.execute(sql`update seo_search_submissions set status = 'skipped', error = 'Needs credentials: GOOGLE_SEO_SERVICE_ACCOUNT_JSON and a Search Console property.' where id = any(${ids}::uuid[])`);
      continue;
    }
    const [recent] = rowsOf<{ n: number }>(await db.execute(sql`select count(*)::int as n from seo_search_submissions where engine = 'google' and kind = 'sitemap' and url = ${sitemap} and status = 'accepted' and sent_at > ${new Date((deps.now ?? new Date()).getTime() - SITEMAP_MIN_INTERVAL_MS).toISOString()}`));
    if (Number(recent?.n ?? 0) > 0) {
      await db.execute(sql`update seo_search_submissions set status = 'deduplicated', error = 'Resubmitted within the last hour; Google reads it on its next fetch.' where id = any(${ids}::uuid[])`);
      continue;
    }
    try {
      await googleJson(ctx, `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(s.google.gscProperty)}/sitemaps/${encodeURIComponent(sitemap)}`, undefined, "PUT");
      await db.execute(sql`update seo_search_submissions set status = 'accepted', response_code = 200, sent_at = now(), error = null where id = any(${ids}::uuid[])`);
      sent++;
    } catch (e) {
      const err = e as GoogleApiError;
      const hint = err.code === "auth" ? " The service account needs Full or Owner permission for sitemaps.submit (docs/seo/MANUAL_SETUP.md)." : "";
      await db.execute(sql`update seo_search_submissions set status = 'error', response_code = ${err.status ?? null}, sent_at = now(), error = ${`${err.message}${hint}`.slice(0, 500)} where id = any(${ids}::uuid[])`);
    }
  }
  return sent;
}

export type Inspection = { verdict?: string; coverageState?: string; indexingState?: string; robotsTxtState?: string; lastCrawlTime?: string; googleCanonical?: string; userCanonical?: string; pageFetchState?: string };

export async function runInspection(db: Db, id: string, deps: SubmitDeps = {}): Promise<Inspection | null> {
  const [row] = rowsOf<{ url: string; status: string }>(await db.execute(sql`select url, status from seo_search_submissions where id = ${id}`));
  if (!row || row.status !== "scheduled") return null;
  const s = await getSeoSettings();
  const ctx = googleContext(deps, SCOPES.searchConsole, "url_inspection");
  if (!ctx || !s.google.gscProperty) {
    await db.execute(sql`update seo_search_submissions set status = 'skipped', error = 'Needs credentials: GOOGLE_SEO_SERVICE_ACCOUNT_JSON and a Search Console property.' where id = ${id}`);
    return null;
  }
  const [used] = rowsOf<{ n: number }>(await db.execute(sql`select count(*)::int as n from seo_search_submissions where kind = 'inspection' and inspected_at > now() - interval '1 day'`));
  if (Number(used?.n ?? 0) >= s.google.urlInspection.dailyLimit) {
    // Quota guard: try again tomorrow (the job queue retries; the row stays scheduled).
    throw new Error("URL Inspection daily limit reached");
  }
  try {
    const r = await googleJson<{ inspectionResult?: { indexStatusResult?: Inspection } }>(ctx, "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect", { inspectionUrl: row.url, siteUrl: s.google.gscProperty });
    const st = r.inspectionResult?.indexStatusResult ?? {};
    const inspection: Inspection = { verdict: st.verdict, coverageState: st.coverageState, indexingState: st.indexingState, robotsTxtState: st.robotsTxtState, lastCrawlTime: st.lastCrawlTime, googleCanonical: st.googleCanonical, userCanonical: st.userCanonical, pageFetchState: st.pageFetchState };
    await db.execute(sql`update seo_search_submissions set status = 'done', response_code = 200, inspection = ${JSON.stringify(inspection)}::jsonb, inspected_at = now(), sent_at = now(), attempts = attempts + 1 where id = ${id}`);
    return inspection;
  } catch (e) {
    const err = e as GoogleApiError;
    if (err.code === "quota" || err.code === "unavailable") throw e; // retry later
    await db.execute(sql`update seo_search_submissions set status = 'error', response_code = ${err.status ?? null}, error = ${err.message.slice(0, 500)}, attempts = attempts + 1 where id = ${id}`);
    return null;
  }
}

export const submissionJobHandler = async (payload: Record<string, unknown>) => {
  const db = await getDb();
  if (payload.kind === "indexnow") await sendIndexNowBatch(db);
  else if (payload.kind === "sitemap") await sendSitemapResubmits(db);
  else if (payload.kind === "inspect" && typeof payload.id === "string") await runInspection(db, payload.id);
  else throw new PermanentJobError("unknown submission job");
};

// --- Read model -------------------------------------------------------------------------------------------------

export type SubmissionView = { engine: string; kind: string; status: string; requestedAt: string; responseCode: number | null; error: string | null; inspection: Inspection | null };

/** Timeline for one article (and optionally one draft), oldest first. */
export async function listSubmissions(db: Db, f: { articleId: string; draftId?: string }): Promise<SubmissionView[]> {
  const rows = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select engine, kind, status, requested_at, response_code, error, inspection from seo_search_submissions
      where article_id = ${f.articleId} ${f.draftId ? sql`and (draft_id = ${f.draftId} or draft_id is null)` : sql``}
      order by requested_at asc limit 100`),
  );
  return rows.map((r) => ({
    engine: r.engine === "indexnow" ? "IndexNow" : r.engine === "google" ? "Google" : "All engines",
    kind: r.kind === "sitemap" ? "sitemap resubmitted" : r.kind === "inspection" ? "URL Inspection" : "URL submitted",
    status: String(r.status),
    requestedAt: new Date(String(r.requested_at)).toISOString(),
    responseCode: r.response_code === null ? null : Number(r.response_code),
    error: (r.error as string | null) ?? null,
    inspection: (typeof r.inspection === "string" ? JSON.parse(r.inspection) : r.inspection) as Inspection | null,
  }));
}

/** submitted → crawled (when known) → indexed status, from the latest inspection. */
export function timelineSummary(rows: SubmissionView[]) {
  const submitted = rows.find((r) => r.status === "accepted");
  const insp = [...rows].reverse().find((r) => r.inspection);
  return {
    submittedAt: submitted?.requestedAt ?? null,
    crawledAt: insp?.inspection?.lastCrawlTime ?? null,
    indexState: insp?.inspection?.coverageState ?? insp?.inspection?.verdict ?? null,
    pendingInspection: rows.some((r) => r.kind === "URL Inspection" && r.status === "scheduled"),
  };
}
