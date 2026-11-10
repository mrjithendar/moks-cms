import { sql } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
import { isProductionEnv } from "@/config/site";
import { audit } from "../audit";
import { toIsoOffset } from "../dates-iso";
import { enqueue, PermanentJobError } from "../jobs";
import { log } from "../log";
import { updatePost, type Actor } from "../posts";
import { getAutosave, getRevision } from "../revisions";
import { applyChanges, effectiveTitle, isSubstantive, type Change } from "./changeset";
import { safeFetcher, type PageFetcher } from "./crawler";
import { DraftError, getDraft, normalize } from "./drafts";
import { sendSeoAlert } from "./notify";
import { windowMetrics } from "./recommendations";
import { getSeoSettings } from "./settings";
import { addDays } from "./sqlutil";
import { submitAfterPublish } from "./submission";
import { siteOrigin } from "./urls";

/**
 * v2 Phase 2.3: Approve → publish → verify → submit, and rollback. The ONLY SEO module that writes `post`
 * (docs/seo/DECISIONS.md D-21), and only from an explicit admin approval (or the schedule that admin set).
 *
 * Publishing goes through `updatePost` — the editor's own "Update" path — with the approving admin as actor and the
 * draft's base version as the optimistic-concurrency guard, so permissions, validation, revisions, redirects, IndexNow
 * and cache invalidation are exactly what a manual edit gets. The sitemap's <lastmod> (and the visible "Updated"
 * date / JSON-LD dateModified) moves only when the accepted changes are substantive (body text, not just title/meta).
 */
export const VERIFY_JOB_KIND = "seo_verify";
const VERIFY_ATTEMPTS = 3;
const VERIFY_DELAY_MS = 40_000; // the other replica's content cache lives 30 s

export type ApproveOpts = { publishAt?: string | null; now?: Date };

function revalidate(path: string) {
  // Pages render per request from Postgres (force-dynamic) and updatePost already cleared the content cache on every
  // replica; revalidatePath additionally drops any router cache for the page, the sitemap and the listings.
  void import("next/cache")
    .then(({ revalidatePath }) => {
      for (const p of [path, `/${path.split("/")[1]}`, "/", "/sitemap.xml", "/news-sitemap.xml"]) {
        try {
          revalidatePath(p);
        } catch {
          /* outside a request (scheduled publish): nothing cached to drop */
        }
      }
    })
    .catch(() => {});
}

function acceptedChanges(changes: Change[]) {
  return changes.filter((c) => c.decision === "accepted");
}

/** Everything an approval checks before it touches the article. Throws DraftError with a user-facing message. */
async function preflight(db: Db, draftId: string, actor: Actor) {
  if (actor.role !== "admin") throw new DraftError("Only admins can approve drafts.", 403);
  const d = await getDraft(draftId);
  if (!d) throw new DraftError("Draft not found.", 404);
  if (!["ready_for_review", "scheduled"].includes(d.status)) throw new DraftError(`This draft is ${d.status.replace(/_/g, " ")}.`, 409);
  const accepted = acceptedChanges(d.changes);
  if (!accepted.length) throw new DraftError("Accept at least one change first. Rejected changes are left out.", 400);
  const blocking = accepted.filter((c) => c.flags.some((f) => f.severity === "error"));
  if (blocking.length) throw new DraftError(`Fix or reject ${blocking.map((c) => c.id).join(", ")} first (${blocking[0]!.flags.find((f) => f.severity === "error")!.message})`, 400);
  if (d.article.version !== d.base_version) throw new DraftError("The article was edited after this draft was made. Regenerate the draft so it applies to the current version.", 409);
  if (d.article.status !== "published") throw new DraftError("The article is no longer published.", 409);
  // updatePost discards the actor's editor working copy; never lose someone's unsaved edits.
  if (await getAutosave(actor, "post", d.article_id)) throw new DraftError("You have unsaved editor changes for this article. Save or discard them in the editor first.", 409);
  const applied = applyChanges(d.base_snapshot, accepted);
  if (applied.conflicts.length) throw new DraftError(`Changes ${applied.conflicts.join(", ")} conflict with other accepted changes.`, 409);
  return { d, accepted, applied };
}

/**
 * "Approve & publish" (now) or "Approve, publish later" (publishAt in the future). Bulk approval does not exist:
 * this takes one draft id and is called once per article by a person.
 */
export async function approveDraft(draftId: string, actor: Actor, opts: ApproveOpts = {}) {
  const db = await getDb();
  const now = opts.now ?? new Date();
  const { d, accepted } = await preflight(db, draftId, actor);
  const when = opts.publishAt ? new Date(opts.publishAt) : null;
  if (when && Number.isNaN(when.getTime())) throw new DraftError("Invalid publish time.", 400);
  if (when && when.getTime() > now.getTime() + 60_000) {
    await db.execute(sql`update seo_drafts set status = 'scheduled', scheduled_for = ${when.toISOString()}, decided_by = ${actor.label}, decided_by_id = ${actor.id}, decided_at = now(), updated_at = now() where id = ${draftId}`);
    await audit(actor, "seo.draft.schedule", d.article_id, { draftId, publishAt: when.toISOString(), accepted: accepted.length, total: d.changes.length });
    return { status: "scheduled" as const, publishAt: when.toISOString() };
  }
  return publishDraft(db, draftId, actor, now);
}

async function publishDraft(db: Db, draftId: string, actor: Actor, now: Date, opts: { orchestrated?: boolean } = {}) {
  const { d, accepted, applied } = await preflight(db, draftId, actor);
  const claimed = rowsOf<{ id: string }>(await db.execute(sql`update seo_drafts set status = 'publishing', updated_at = now() where id = ${draftId} and status in ('ready_for_review', 'scheduled') returning id`));
  if (!claimed.length) throw new DraftError("This draft is already being published.", 409);
  const substantive = isSubstantive(accepted);
  const patch: Record<string, unknown> = { body: applied.body, seoTitle: applied.fields.seoTitle, seoDescription: applied.fields.seoDescription };
  if (substantive) patch.updatedAt = toIsoOffset(now);
  let row;
  try {
    row = await updatePost(actor, d.article_id, patch, { baseVersion: d.base_version, reason: "seo-draft", notifySearchEngines: false });
  } catch (e) {
    await db.execute(sql`update seo_drafts set status = 'ready_for_review', updated_at = now() where id = ${draftId}`);
    const err = e as { status?: number; message: string; issues?: string[] };
    throw new DraftError(`The CMS refused the update: ${err.message}${err.issues?.length ? ` (${err.issues.slice(0, 3).join("; ")})` : ""}`, err.status && err.status < 500 ? err.status : 500);
  }
  const url = `${siteOrigin().origin}${d.article.path}`;
  const today = now.toISOString().slice(0, 10);
  const baseline = await windowMetrics(db, url, addDays(today, -28), addDays(today, -1));
  await db.execute(sql`
    update seo_drafts set status = 'published', published_version = ${row.version}, previous_version = ${d.base_version}, substantive = ${substantive},
      decided_by = ${actor.label}, decided_by_id = ${actor.id}, decided_at = now(), baseline_metrics = ${JSON.stringify(baseline)}::jsonb,
      verification = ${JSON.stringify({ state: "pending", attempts: 0 })}::jsonb, updated_at = now()
    where id = ${draftId}`);
  // The recommendations this draft acted on are implemented now (v1 outcome tracking takes over at +28/+56 days).
  if (d.recommendation_ids.length) {
    await db.execute(sql`
      update seo_recommendations set review_status = 'approved', implementation_status = 'implemented', implemented_at = coalesce(implemented_at, now()),
        baseline_metrics = coalesce(baseline_metrics, ${JSON.stringify(baseline)}::jsonb), reviewed_by = coalesce(reviewed_by, ${actor.label}), updated_at = now()
      where id = any(${`{${d.recommendation_ids.join(",")}}`}::uuid[])`);
  }
  await audit(actor, "seo.draft.publish", d.article_id, { draftId, version: row.version, previousVersion: d.base_version, accepted: accepted.map((c) => `${c.id}:${c.type}${c.edited ? ":edited" : ""}`), rejected: d.changes.filter((c) => c.decision === "rejected").map((c) => c.id), substantive });
  revalidate(d.article.path);
  // v3: the graph's verify_live / submit_search nodes take over (same checks, same submission code).
  if (!opts.orchestrated) await enqueue(VERIFY_JOB_KIND, { draftId, attempt: 1, reason: "publish" }, { runAt: new Date(now.getTime() + VERIFY_DELAY_MS), dedupeKey: `seo_verify:${draftId}:publish`, maxAttempts: 1 });
  log.info("seo draft published", { operation: "seo_publish", outcome: "published", substantive });
  return { status: "published" as const, version: row.version, substantive };
}

/**
 * Automatic link maintenance (auto-links.ts; owner decision 2026-11-10): publish a links-only draft without a person.
 * Refused unless every accepted change is a rules-made internal_link/external_link, so this can never publish prose,
 * titles or Claude output. Same preflight, CMS update path, post-publish verification and rollback as an approval.
 */
export async function autoPublishLinkDraft(draftId: string, actor: Actor, now = new Date()) {
  const d = await getDraft(draftId);
  if (!d) throw new DraftError("Draft not found.", 404);
  if (d.trigger !== "auto_links" || d.kind === "new_article") throw new DraftError("Only automatic link drafts can be published without review.", 403);
  const accepted = acceptedChanges(d.changes);
  if (!accepted.length || accepted.some((c) => c.origin !== "rules" || (c.type !== "internal_link" && c.type !== "external_link"))) throw new DraftError("Automatic publishing is limited to rule-made link changes.", 403);
  const db = await getDb();
  return publishDraft(db, draftId, actor, now);
}

/** Scheduler tick: publish approved drafts whose time has come, as the admin who approved them (still admin). */
export async function publishDueDrafts(now = new Date()): Promise<number> {
  const db = await getDb();
  const due = rowsOf<{ id: string; decided_by_id: string | null; article_id: string }>(await db.execute(sql`select id, decided_by_id, article_id from seo_drafts where status = 'scheduled' and scheduled_for <= ${now.toISOString()}`));
  let n = 0;
  for (const d of due) {
    const [u] = rowsOf<{ id: string; role: string; email: string }>(await db.execute(sql`select id, role, email from "user" where id = ${d.decided_by_id ?? ""}`));
    if (!u || u.role !== "admin") {
      await db.execute(sql`update seo_drafts set status = 'ready_for_review', scheduled_for = null, failure_reason = 'The approving admin is no longer an admin; approve again.', updated_at = now() where id = ${d.id}`);
      continue;
    }
    try {
      const [own] = rowsOf<{ thread_id: string | null }>(await db.execute(sql`select thread_id from seo_drafts where id = ${d.id}`));
      if (own?.thread_id) {
        // v3: the waiting graph publishes; it is resumed with the approval the admin recorded when scheduling.
        await (await import("../seo-agent/orchestrate")).resumeScheduled(d.id, now);
      } else await publishDraft(db, d.id, { id: u.id, role: "admin", label: u.email }, now);
      n++;
    } catch (e) {
      await db.execute(sql`update seo_drafts set status = 'ready_for_review', scheduled_for = null, failure_reason = ${`Scheduled publish failed: ${(e as Error).message}`.slice(0, 1000)}, updated_at = now() where id = ${d.id} and status = 'scheduled'`);
      await audit({ id: null, label: "scheduler" }, "seo.draft.schedule_failed", d.article_id, { draftId: d.id, error: (e as Error).message });
    }
  }
  return n;
}

// --- Post-publish verification ----------------------------------------------------------------------------------

export type Check = { key: string; ok: boolean; detail: string };

/** What a published page must look like before anything is submitted to search engines. */
export function verifyHtml(html: string, status: number, headers: Record<string, string>, expect: { url: string; title: string }, production = isProductionEnv()): Check[] {
  const canonical = /<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']|<link[^>]+href=["']([^"']+)["'][^>]*rel=["']canonical["']/i.exec(html);
  const canon = canonical?.[1] ?? canonical?.[2] ?? null;
  const robotsMeta = /<meta[^>]+name=["']robots["'][^>]*content=["']([^"']+)["']/i.exec(html)?.[1] ?? "";
  const xRobots = headers["x-robots-tag"] ?? "";
  const noindex = /noindex/i.test(`${robotsMeta},${xRobots}`);
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').trim() ?? "";
  const ld = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]!);
  let ldOk = ld.length > 0;
  for (const block of ld) {
    try {
      const v = JSON.parse(block) as unknown;
      const items = Array.isArray(v) ? v : [v];
      if (!items.every((x) => x && typeof x === "object" && "@type" in (x as object))) ldOk = false;
    } catch {
      ldOk = false;
    }
  }
  return [
    { key: "status", ok: status === 200, detail: `HTTP ${status}` },
    { key: "canonical", ok: canon === expect.url, detail: canon ? `canonical ${canon}` : "no canonical link" },
    // Outside production every page is noindex by design (APP_ENV gate), so that is expected there.
    { key: "indexable", ok: production ? !noindex : true, detail: noindex ? (production ? "page is noindex" : "noindex (expected outside production)") : "indexable" },
    { key: "title", ok: title.includes(expect.title), detail: `<title> "${title.slice(0, 120)}"` },
    { key: "json_ld", ok: ldOk, detail: ld.length ? `${ld.length} JSON-LD block(s)${ldOk ? "" : ", invalid"}` : "no JSON-LD" },
  ];
}

export type VerifyDeps = { fetcher?: PageFetcher; now?: Date; submit?: (db: Db, t: Parameters<typeof submitAfterPublish>[1], deps?: Parameters<typeof submitAfterPublish>[2]) => Promise<void>; noRequeue?: boolean };

/** Job: fetch the live URL, check it, then submit (or alert + offer rollback). Retries for cache propagation. */
export async function verifyDraft(draftId: string, attempt: number, reason: "publish" | "rollback", deps: VerifyDeps = {}) {
  const db = await getDb();
  const [r] = rowsOf<Record<string, unknown>>(await db.execute(sql`select d.*, p.collection, p.slug, p.title, p.seo_title from seo_drafts d join post p on p.id = d.article_id where d.id = ${draftId}`));
  if (!r) throw new PermanentJobError("draft not found");
  const d = normalize(r);
  const path = `/${r.collection}/${r.slug}`;
  const origin = siteOrigin();
  const url = `${origin.origin}${path}`;
  const s = await getSeoSettings();
  const fetcher = deps.fetcher ?? loopbackFetcher() ?? safeFetcher(origin, { timeoutMs: s.crawler.timeoutMs, maxBytes: s.crawler.maxBytes, maxRedirects: 0 });
  let checks: Check[];
  try {
    const res = await fetcher(url);
    checks = verifyHtml(res.body, res.status, res.headers, { url, title: effectiveTitle({ title: String(r.title), description: "", seoTitle: (r.seo_title as string | null) ?? null, seoDescription: null }) });
  } catch (e) {
    checks = [{ key: "fetch", ok: false, detail: (e as Error).message.slice(0, 200) }];
  }
  const ok = checks.every((c) => c.ok);
  const verification = { state: ok ? "passed" : attempt < VERIFY_ATTEMPTS ? "retrying" : "failed", attempts: attempt, checks, checkedAt: new Date().toISOString(), reason };
  await db.execute(sql`update seo_drafts set verification = ${JSON.stringify(verification)}::jsonb, updated_at = now() where id = ${draftId}`);
  if (ok) {
    await audit({ id: null, label: "seo-verify" }, "seo.draft.verified", d.article_id, { draftId, reason, checks: checks.map((c) => c.key) });
    await (deps.submit ?? submitAfterPublish)(db, { draftId, articleId: d.article_id, path, reason }, { now: deps.now });
    return verification;
  }
  if (attempt < VERIFY_ATTEMPTS) {
    if (deps.noRequeue) return verification;
    await enqueue(VERIFY_JOB_KIND, { draftId, attempt: attempt + 1, reason }, { runAt: new Date(Date.now() + 30_000 * attempt), dedupeKey: `seo_verify:${draftId}:${reason}:${attempt + 1}`, maxAttempts: 1 });
    return verification;
  }
  await audit({ id: null, label: "seo-verify" }, "seo.draft.verification_failed", d.article_id, { draftId, reason, checks });
  log.warn("seo post-publish verification failed", { operation: "seo_verify", outcome: "failed" });
  await sendSeoAlert(`SEO: verification failed for ${path}`, `The page published from an SEO draft did not pass verification, so nothing was submitted to search engines.\n\n${checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.key}: ${c.detail}`).join("\n")}\n\nRoll back in one click: ${origin.origin}/admin/seo/review/${draftId}`).catch(() => false);
  return verification;
}

/**
 * Local E2E only: the SSRF-safe fetcher (rightly) refuses loopback addresses, so a local run could never verify. With
 * SEO_VERIFY_FETCH_ORIGIN=http://localhost:3100 the check fetches the same path from that origin instead. Ignored in
 * production (APP_ENV=production).
 */
function loopbackFetcher(): PageFetcher | null {
  const o = process.env.SEO_VERIFY_FETCH_ORIGIN?.trim();
  if (!o || isProductionEnv() || !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o)) return null;
  return async (url: string) => {
    const local = `${o}${new URL(url).pathname}`;
    const res = await fetch(local, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
    return { url, finalUrl: local, status: res.status, headers: Object.fromEntries(res.headers), body: await res.text(), redirects: [], truncated: false };
  };
}

export const verifyJobHandler = async (payload: Record<string, unknown>) => {
  const id = String(payload.draftId ?? "");
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new PermanentJobError("bad draft id");
  await verifyDraft(id, Number(payload.attempt ?? 1), payload.reason === "rollback" ? "rollback" : "publish");
};

// --- Rollback ---------------------------------------------------------------------------------------------------

/**
 * Restore the fields the draft changed to the previous revision's values, through the same update path (a new
 * revision; history is never rewritten), then verify + submit again. Refused if the article was edited after the
 * draft was published (the editor's history is the right tool then).
 */
export async function rollbackDraft(draftId: string, actor: Actor, now = new Date()) {
  if (actor.role !== "admin") throw new DraftError("Only admins can roll back.", 403);
  const db = await getDb();
  const d = await getDraft(draftId);
  if (!d) throw new DraftError("Draft not found.", 404);
  if (d.status !== "published" || d.published_version === null || d.published_version === undefined) throw new DraftError("Only published drafts can be rolled back.", 409);
  if (d.article.version !== Number(d.published_version)) throw new DraftError("The article was edited after this draft was published. Use the editor's revision history instead.", 409);
  if (await getAutosave(actor, "post", d.article_id)) throw new DraftError("You have unsaved editor changes for this article. Save or discard them first.", 409);
  // The previous committed revision when the CMS recorded one; otherwise the draft's own snapshot of that version
  // (posts imported before revisions existed have none). Both hold exactly the fields a draft can change.
  const revs = rowsOf<{ id: string }>(await db.execute(sql`select id from revision where entity = 'post' and entity_id = ${d.article_id} and version = ${Number(d.previous_version)} order by created_at desc limit 1`));
  const snap = d.base_snapshot;
  const prev: Record<string, unknown> = revs.length ? ((await getRevision("post", d.article_id, revs[0]!.id)).payload as Record<string, unknown>) : { body: snap.body, seoTitle: snap.seoTitle, seoDescription: snap.seoDescription, updatedAt: snap.updatedAt ?? null };
  const iso = (v: unknown) => (v ? toIsoOffset(new Date(String(v))) : null);
  const row = await updatePost(actor, d.article_id, { body: prev.body, seoTitle: prev.seoTitle ?? null, seoDescription: prev.seoDescription ?? null, updatedAt: iso(prev.updatedAt) }, { baseVersion: Number(d.published_version), reason: "seo-rollback", notifySearchEngines: false });
  await db.execute(sql`update seo_drafts set status = 'rolled_back', verification = ${JSON.stringify({ state: "pending", attempts: 0, reason: "rollback" })}::jsonb, updated_at = now() where id = ${draftId}`);
  if (d.recommendation_ids.length) await db.execute(sql`update seo_recommendations set implementation_status = 'not_started', implemented_at = null, updated_at = now() where id = any(${`{${d.recommendation_ids.join(",")}}`}::uuid[])`);
  await audit(actor, "seo.draft.rollback", d.article_id, { draftId, restoredVersion: Number(d.previous_version), newVersion: row.version });
  revalidate(d.article.path);
  await enqueue(VERIFY_JOB_KIND, { draftId, attempt: 1, reason: "rollback" }, { runAt: new Date(now.getTime() + VERIFY_DELAY_MS), dedupeKey: `seo_verify:${draftId}:rollback`, maxAttempts: 1 });
  return { status: "rolled_back" as const, version: row.version };
}

/** Daily (outcomes job): before/after metrics for published drafts at +28 and +56 days, against the stored baseline. */
export async function captureDraftOutcomes(now = new Date()): Promise<number> {
  const db = await getDb();
  const today = now.toISOString().slice(0, 10);
  const rows = rowsOf<{ id: string; decided_at: string; path: string; m28: unknown; m56: unknown }>(
    await db.execute(sql`select d.id, d.decided_at::text, '/' || p.collection || '/' || p.slug as path, d.metrics_28d as m28, d.metrics_56d as m56 from seo_drafts d join post p on p.id = d.article_id where d.status = 'published' and (d.metrics_28d is null or d.metrics_56d is null)`),
  );
  let n = 0;
  for (const r of rows) {
    const start = r.decided_at.slice(0, 10);
    const url = `${siteOrigin().origin}${r.path}`;
    for (const [days, col, have] of [[28, "metrics_28d", r.m28], [56, "metrics_56d", r.m56]] as const) {
      if (have || addDays(start, days) > today) continue;
      const m = await windowMetrics(db, url, addDays(start, days - 27), addDays(start, days));
      await db.execute(sql`update seo_drafts set ${sql.raw(col)} = ${JSON.stringify(m)}::jsonb where id = ${r.id}`);
      n++;
    }
  }
  return n;
}


// --- The approval gate for CrewAI flow runs (docs/seo/DECISIONS.md D-43, D-56) ---------------------------------------

const APPROVAL_TTL_MS = 7 * 86_400_000;

/**
 * The admin approve route (crewai mode) records the approval here — after the same preflight as v2 — and only then
 * starts publish_flow with the approval id. Nothing is published by this function.
 */
export async function recordApproval(draftId: string, actor: Actor, opts: ApproveOpts = {}) {
  const db = await getDb();
  const now = opts.now ?? new Date();
  const d = await getDraft(draftId);
  if (!d) throw new DraftError("Draft not found.", 404);
  const accepted = d.kind === "new_article" ? (await preflightNew(db, draftId, actor)).accepted : (await preflight(db, draftId, actor)).accepted;
  const when = opts.publishAt ? new Date(opts.publishAt) : null;
  if (when && Number.isNaN(when.getTime())) throw new DraftError("Invalid publish time.", 400);
  const later = when && when.getTime() > now.getTime() + 60_000 ? when : null;
  const expires = new Date((later ?? now).getTime() + APPROVAL_TTL_MS);
  const [row] = rowsOf<{ id: string }>(
    await db.execute(sql`
      insert into seo_draft_approvals (draft_id, approved_by, approved_by_id, accepted_change_ids, publish_at, expires_at)
      values (${draftId}, ${actor.label}, ${actor.id}, ${`{${accepted.map((c) => c.id).join(",")}}`}::text[], ${later?.toISOString() ?? null}, ${expires.toISOString()})
      returning id`),
  );
  if (later) await db.execute(sql`update seo_drafts set status = 'scheduled', scheduled_for = ${later.toISOString()}, decided_by = ${actor.label}, decided_by_id = ${actor.id}, decided_at = now(), updated_at = now() where id = ${draftId}`);
  await audit(actor, later ? "seo.draft.schedule" : "seo.draft.approve", d.article_id, { draftId, approvalId: row!.id, accepted: accepted.length, total: d.changes.length, publishAt: later?.toISOString() ?? null });
  return { approvalId: row!.id, acceptedChangeIds: accepted.map((c) => c.id), publishAt: later?.toISOString() ?? null };
}

/**
 * Called by the seo-agent's publish node (internal callback). Refused unless an unused, unexpired approval with this id
 * exists for this draft, its accepted change ids are exactly the ones given, the approver is still an admin, and a
 * scheduled approval's time has come. The approval is consumed before anything is written, so it works once.
 */
export async function publishWithApproval(draftId: string, approvalId: string, acceptedChangeIds: string[], now = new Date()) {
  const db = await getDb();
  if (!/^[0-9a-f-]{36}$/.test(approvalId)) throw new DraftError("No valid admin approval for this draft.", 403);
  const [a] = rowsOf<{ id: string; approved_by_id: string; accepted_change_ids: unknown; publish_at: string | null; expires_at: string; used_at: string | null }>(
    await db.execute(sql`select id, approved_by_id, accepted_change_ids, publish_at, expires_at, used_at from seo_draft_approvals where id = ${approvalId} and draft_id = ${draftId}`),
  );
  if (!a || a.used_at || new Date(a.expires_at).getTime() < now.getTime()) throw new DraftError("No valid admin approval for this draft.", 403);
  const approved = (Array.isArray(a.accepted_change_ids) ? a.accepted_change_ids.map(String) : String(a.accepted_change_ids ?? "").replace(/^\{|\}$/g, "").split(",").filter(Boolean)).sort();
  if (approved.join(",") !== [...acceptedChangeIds].sort().join(",")) throw new DraftError("The accepted changes differ from what the admin approved.", 409);
  if (a.publish_at && new Date(a.publish_at).getTime() > now.getTime() + 60_000) throw new DraftError("This approval is scheduled for later.", 409);
  const [u] = rowsOf<{ id: string; role: string; email: string }>(await db.execute(sql`select id, role, email from "user" where id = ${a.approved_by_id}`));
  if (!u || u.role !== "admin") throw new DraftError("The approving admin is no longer an admin; approve again.", 403);
  const d = await getDraft(draftId);
  if (!d) throw new DraftError("Draft not found.", 404);
  // The reviewer may have changed decisions after approving: the draft must still match the approval exactly.
  const current = (d.kind === "new_article" ? d.changes : d.changes.filter((c) => c.decision === "accepted")).map((c) => c.id).sort();
  if (current.join(",") !== approved.join(",")) throw new DraftError("The draft changed after it was approved; approve again.", 409);
  const claimed = rowsOf<{ id: string }>(await db.execute(sql`update seo_draft_approvals set used_at = now() where id = ${approvalId} and used_at is null returning id`));
  if (!claimed.length) throw new DraftError("No valid admin approval for this draft.", 403);
  const actor: Actor = { id: u.id, role: "admin", label: u.email };
  if (d.kind === "new_article") return publishNewArticle(db, draftId, actor, now);
  return publishDraft(db, draftId, actor, now, { orchestrated: true });
}

type NewArticleDoc = { title: string; slug_suggestion: string; meta_description: string; body_mdx: string; incomplete?: boolean; fact_check_flags?: { severity: string }[] };

/** New-article drafts: everything an approval checks before the CMS draft post is published. */
async function preflightNew(db: Db, draftId: string, actor: Actor) {
  if (actor.role !== "admin") throw new DraftError("Only admins can approve drafts.", 403);
  const d = await getDraft(draftId);
  if (!d) throw new DraftError("Draft not found.", 404);
  if (!["ready_for_review", "scheduled"].includes(d.status)) throw new DraftError(`This draft is ${d.status.replace(/_/g, " ")}.`, 409);
  const doc = (typeof d.document === "string" ? JSON.parse(d.document) : d.document) as NewArticleDoc | null;
  if (!doc?.body_mdx?.trim()) throw new DraftError("This draft has no article body.", 400);
  if (doc.incomplete) throw new DraftError("The crew's draft is incomplete; regenerate it or finish it in the editor.", 400);
  const blocking = [...d.flags, ...d.changes.flatMap((c) => c.flags)].filter((f) => f.severity === "error");
  if (blocking.length) throw new DraftError(`Resolve the blocking flags first (${blocking[0]!.message}).`, 400);
  if (d.article.version !== d.base_version) throw new DraftError("The CMS draft was edited after this draft was made. Regenerate the draft.", 409);
  if (!["draft", "review"].includes(d.article.status)) throw new DraftError("The CMS post is no longer a draft.", 409);
  if (await getAutosave(actor, "post", d.article_id)) throw new DraftError("You have unsaved editor changes for this article. Save or discard them in the editor first.", 409);
  return { d, doc, accepted: d.changes };
}

/** Publish a crew-written article into its CMS draft post through the CMS's own update path (status → published). */
async function publishNewArticle(db: Db, draftId: string, actor: Actor, now: Date) {
  const { d, doc } = await preflightNew(db, draftId, actor);
  const claimed = rowsOf<{ id: string }>(await db.execute(sql`update seo_drafts set status = 'publishing', updated_at = now() where id = ${draftId} and status in ('ready_for_review', 'scheduled') returning id`));
  if (!claimed.length) throw new DraftError("This draft is already being published.", 409);
  const slugFree = rowsOf<{ n: number }>(await db.execute(sql`select count(*)::int as n from post where collection = ${d.collection} and slug = ${doc.slug_suggestion} and id <> ${d.article_id}`))[0]?.n === 0;
  const { newsPublishPatch, onNewsPublished } = await import("../news/publishing");
  // News desk drafts also carry their reviewed category, tags, sources and cover (docs/news/DECISIONS.md N-06).
  const patch: Record<string, unknown> = { ...(await newsPublishPatch(db, doc)), title: doc.title, description: doc.meta_description, seoDescription: doc.meta_description, body: doc.body_mdx, status: "published", publishedAt: toIsoOffset(now) };
  if (slugFree && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(doc.slug_suggestion)) patch.slug = doc.slug_suggestion;
  let row;
  try {
    row = await updatePost(actor, d.article_id, patch, { baseVersion: d.base_version, reason: "publish", notifySearchEngines: false });
  } catch (e) {
    await db.execute(sql`update seo_drafts set status = 'ready_for_review', updated_at = now() where id = ${draftId}`);
    const err = e as { status?: number; message: string; issues?: string[] };
    throw new DraftError(`The CMS refused the article: ${err.message}${err.issues?.length ? ` (${err.issues.slice(0, 3).join("; ")})` : ""}`, err.status && err.status < 500 ? err.status : 500);
  }
  await db.execute(sql`update seo_drafts set status = 'published', published_version = ${row.version}, previous_version = ${d.base_version}, substantive = true, decided_by = ${actor.label}, decided_by_id = ${actor.id}, decided_at = now(), verification = ${JSON.stringify({ state: "pending", attempts: 0 })}::jsonb, updated_at = now() where id = ${draftId}`);
  if (d.calendar_id) await db.execute(sql`update seo_editorial_calendar set status = 'published', updated_at = now() where id = ${String(d.calendar_id)}`);
  await audit(actor, "seo.draft.publish_new", d.article_id, { draftId, version: row.version, slug: row.slug });
  await onNewsPublished(db, draftId, actor, doc.body_mdx).catch((e) => log.warn("news publish bookkeeping failed", { err: e, operation: "news_publish" }));
  revalidate(`/${row.collection}/${row.slug}`);
  log.info("seo new article published", { operation: "seo_publish", outcome: "published" });
  return { status: "published" as const, version: row.version, substantive: true };
}

/**
 * One verification attempt for the graph's verify_live node (it owns the retries and delays). On the final failed
 * attempt the v2 failure path runs: audit, alert with the one-click rollback link. Never submits anything.
 */
export async function verifyOnce(draftId: string, attempt: number, final: boolean, deps: VerifyDeps = {}) {
  let submitted = false;
  const v = await verifyDraft(draftId, final ? VERIFY_ATTEMPTS : Math.min(attempt, VERIFY_ATTEMPTS - 1), "publish", {
    ...deps,
    submit: async () => {
      submitted = true; // passed: the graph's submit_search node submits, not this call
    },
    noRequeue: true,
  });
  return { ...v, attempts: attempt, state: v.state === "passed" || submitted ? "passed" : final ? "failed" : "retrying" };
}
