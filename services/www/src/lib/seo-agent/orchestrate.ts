import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { rowsOf } from "@/db/rows";
import type { Actor } from "../posts";
import { createDraftFromItem } from "../seo-intel/calendar";
import { DraftError, getDraft, loadBase, queueDraft, rejectDraft, reserveDraft, type ExtraTask } from "../seo-intel/drafts";
import { recordApproval } from "../seo-intel/publish";
import { AgentError, resumeRun, startRun, type AgentDeps } from "./client";
import { orchestrator } from "./config";

/**
 * The switch between v2 and v3 for every human/scheduled action (SEO_ORCHESTRATOR). Routes call these; in legacy mode
 * they do exactly what v2 did. In langgraph mode a draft owned by a graph run (thread_id = draft id) is driven through
 * the seo-agent; drafts created by the legacy path keep their legacy behaviour, so switching modes never strands one.
 */

/** "Draft with Claude" / "Fix with Claude" / regenerate from the article panel. */
export async function requestDraft(articleId: string, opts: { mode?: "auto" | "regenerate"; recommendationIds?: string[]; extra?: ExtraTask[]; trigger?: "manual" | "fix"; actor?: string }, deps: AgentDeps = {}) {
  if (orchestrator(deps.env) === "legacy") return { queued: await queueDraft(articleId, opts), orchestrator: "legacy" as const };
  const db = await getDb();
  const base = await loadBase(db, articleId);
  if (base.status !== "published") return { queued: false, orchestrator: "langgraph" as const, reason: "Only published articles get optimisation drafts." };
  const d = await reserveDraft(db, articleId, base, opts.trigger ?? "manual", { threadManaged: true });
  if (d.thread_id !== d.id) return { queued: await queueDraft(articleId, opts), orchestrator: "legacy" as const, reason: "An open legacy draft exists for this article." };
  const r = await startRun("optimize_article", { article_id: articleId, draft_id: d.id, recommendation_ids: opts.recommendationIds ?? [], extra: opts.extra ?? [], trigger: opts.trigger ?? "manual" }, d.id, deps);
  return { queued: !r.existing, orchestrator: "langgraph" as const, draftId: d.id, threadId: r.thread_id };
}

/** Approve: record the approval (same preflight as v2), then resume the graph with its id. The graph publishes. */
export async function approve(draftId: string, actor: Actor, publishAt: string | null, deps: AgentDeps = {}) {
  const d = await getDraft(draftId);
  if (!d) throw new DraftError("Draft not found.", 404);
  if (!d.thread_id) return null; // legacy draft: the caller uses v2's approveDraft
  const a = await recordApproval(draftId, actor, { publishAt });
  if (a.publishAt) return { status: "scheduled" as const, publishAt: a.publishAt, approvalId: a.approvalId };
  await resume(draftId, { decision: "approve", approval_id: a.approvalId, accepted_change_ids: a.acceptedChangeIds, actor: actor.label }, deps);
  return { status: "publishing" as const, approvalId: a.approvalId };
}

/** Reject: v2's reject (status + reason + audit by the route), then end the graph run. */
export async function reject(draftId: string, actor: Actor, reason: string | null, deps: AgentDeps = {}) {
  const r = await rejectDraft(draftId, actor, reason);
  const d = await getDraft(draftId);
  if (d?.thread_id) await resume(draftId, { decision: "reject", feedback: reason, actor: actor.label }, deps).catch((e) => (e instanceof AgentError && e.status === 409 ? null : Promise.reject(e)));
  return r;
}

/** Regenerate: legacy → v2 job; graph → resume with "edit" (the graph drafts again with the reviewer's feedback). */
export async function regenerate(draftId: string, actor: Actor, feedback: string | null, deps: AgentDeps = {}) {
  const d = await getDraft(draftId);
  if (!d) throw new DraftError("Draft not found.", 404);
  if (!d.thread_id) return { queued: await queueDraft(d.article_id, { mode: "regenerate", trigger: "manual", actor: actor.label }), orchestrator: "legacy" as const };
  await resume(draftId, { decision: "edit", feedback, actor: actor.label }, deps);
  return { queued: true, orchestrator: "langgraph" as const };
}

async function resume(draftId: string, decision: Parameters<typeof resumeRun>[1], deps: AgentDeps) {
  try {
    return await resumeRun(draftId, decision, deps);
  } catch (e) {
    if (e instanceof AgentError) throw new DraftError(e.status === 409 ? `The agent run is not waiting for review (${e.message}).` : `The SEO agent could not take the decision: ${e.message}`, e.status === 409 ? 409 : 503);
    throw e;
  }
}

/** Scheduler tick (publishDueDrafts): a scheduled, graph-owned draft's time has come → resume with its approval. */
export async function resumeScheduled(draftId: string, now = new Date(), deps: AgentDeps = {}) {
  const db = await getDb();
  const [a] = rowsOf<{ id: string; accepted_change_ids: unknown; approved_by: string }>(
    await db.execute(sql`select id, accepted_change_ids, approved_by from seo_draft_approvals where draft_id = ${draftId} and used_at is null and expires_at > ${now.toISOString()} order by created_at desc limit 1`),
  );
  if (!a) throw new DraftError("No pending approval for this scheduled draft.", 409);
  const ids = Array.isArray(a.accepted_change_ids) ? a.accepted_change_ids.map(String) : String(a.accepted_change_ids ?? "").replace(/^\{|\}$/g, "").split(",").filter(Boolean);
  await resume(draftId, { decision: "approve", approval_id: a.id, accepted_change_ids: ids, actor: a.approved_by }, deps);
}

/** Editorial calendar: an approved content-gap idea → CMS draft post (v1) → new_article graph (the crew writes it). */
export async function draftNewArticle(calendarId: string, actor: Actor, deps: AgentDeps = {}) {
  const created = await createDraftFromItem(calendarId, actor);
  if (orchestrator(deps.env) === "legacy") return { ...created, orchestrator: "legacy" as const };
  const db = await getDb();
  const base = await loadBase(db, created.postId);
  const d = await reserveDraft(db, created.postId, base, "calendar", { kind: "new_article", threadManaged: true, calendarId });
  const r = await startRun("new_article", { calendar_id: calendarId, draft_id: d.id, article_id: created.postId }, d.id, deps);
  return { ...created, orchestrator: "langgraph" as const, draftId: d.id, threadId: r.thread_id };
}

/** Weekly schedule (drafts_weekly job): legacy → v2 batch; langgraph → one weekly_recommendations run per week. */
export async function weekly(now = new Date(), deps: AgentDeps = {}) {
  if (orchestrator(deps.env) === "legacy") return null;
  const week = isoWeek(now);
  return startRun("weekly_recommendations", {}, `weekly:${week}`, deps);
}

export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  const w = Math.ceil(((t.getTime() - Date.UTC(y, 0, 1)) / 86_400_000 + 1) / 7);
  return `${y}-W${String(w).padStart(2, "0")}`;
}
