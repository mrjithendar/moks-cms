import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { rowsOf } from "@/db/rows";
import type { Actor } from "../posts";
import { CalendarError, createDraftFromItem, getItem } from "../seo-intel/calendar";
import { holdScheduledPost } from "../seo-intel/calendar-schedule";
import { DraftError, getDraft, loadBase, openDraft, queueDraft, rejectDraft, reserveDraft, type ExtraTask } from "../seo-intel/drafts";
import { recordApproval } from "../seo-intel/publish";
import { AgentError, decide, kickoff, type AgentDeps, type Decision } from "./client";
import { orchestrator } from "./endpoint";

/**
 * The switch between v2 and v4 for every human/scheduled action (endpoint.ts orchestrator(): crewai when the seo-agent
 * is found, legacy when it is disabled). Routes call these; in legacy mode
 * they do exactly what v2 did. In crewai mode a draft owned by the agent (thread_id = draft id) is driven through the
 * seo-agent's CrewAI flows with the split-flow approval pattern (D-56): drafting flows end at ready_for_review; the
 * admin's approval (recorded here, in the authenticated review UI) starts publish_flow. Drafts created by the legacy
 * path keep their legacy behaviour, so switching modes never strands one.
 */

/** "Draft with Claude" / "Fix with Claude" / regenerate from the article panel. */
export async function requestDraft(articleId: string, opts: { mode?: "auto" | "regenerate"; recommendationIds?: string[]; extra?: ExtraTask[]; trigger?: "manual" | "fix"; actor?: string }, deps: AgentDeps = {}) {
  if ((await orchestrator(deps)) === "legacy") return { queued: await queueDraft(articleId, opts), orchestrator: "legacy" as const };
  const db = await getDb();
  const base = await loadBase(db, articleId);
  if (base.status !== "published") return { queued: false, orchestrator: "crewai" as const, reason: "Only published articles get optimisation drafts." };
  const d = await reserveDraft(db, articleId, base, opts.trigger ?? "manual", { threadManaged: true });
  if (d.thread_id !== d.id) return { queued: await queueDraft(articleId, opts), orchestrator: "legacy" as const, reason: "An open legacy draft exists for this article." };
  const r = await kickoff("optimize_article_flow", { article_id: articleId, draft_id: d.id, recommendation_ids: opts.recommendationIds ?? [], extra: opts.extra ?? [], trigger: opts.trigger ?? "manual" }, { actor: opts.actor }, deps);
  return { queued: !r.existing, orchestrator: "crewai" as const, draftId: d.id, runId: r.run_id };
}

/** Approve: record the approval (same preflight as v2), then the decision starts publish_flow with its id. */
export async function approve(draftId: string, actor: Actor, publishAt: string | null, deps: AgentDeps = {}) {
  const d = await getDraft(draftId);
  if (!d) throw new DraftError("Draft not found.", 404);
  if (!d.thread_id) return null; // legacy draft: the caller uses v2's approveDraft
  const a = await recordApproval(draftId, actor, { publishAt });
  if (a.publishAt) return { status: "scheduled" as const, publishAt: a.publishAt, approvalId: a.approvalId };
  const r = await send(draftId, { decision: "approve", approval_id: a.approvalId, accepted_change_ids: a.acceptedChangeIds, actor: actor.label }, deps);
  return { status: "publishing" as const, approvalId: a.approvalId, runId: r.run_id };
}

/** Reject: v2's reject (status + reason + audit by the route), then the agent cancels any drafting run for it. */
export async function reject(draftId: string, actor: Actor, reason: string | null, deps: AgentDeps = {}) {
  const r = await rejectDraft(draftId, actor, reason);
  const d = await getDraft(draftId);
  // The agent's reject also calls back /drafts/{id}/reject, which is a no-op for an already rejected draft.
  if (d?.thread_id) await send(draftId, { decision: "reject", feedback: reason, actor: actor.label }, deps).catch((e) => (e instanceof DraftError && e.status === 503 ? null : Promise.reject(e)));
  return r;
}

/** Regenerate: legacy → v2 job; crewai → a new drafting flow run with the reviewer's feedback. */
export async function regenerate(draftId: string, actor: Actor, feedback: string | null, deps: AgentDeps = {}) {
  const d = await getDraft(draftId);
  if (!d) throw new DraftError("Draft not found.", 404);
  if (!d.thread_id) return { queued: await queueDraft(d.article_id, { mode: "regenerate", trigger: "manual", actor: actor.label }), orchestrator: "legacy" as const };
  const r = await send(draftId, { decision: "regenerate", feedback, actor: actor.label }, deps);
  return { queued: true, orchestrator: "crewai" as const, runId: r.run_id };
}

async function send(draftId: string, decision: Decision, deps: AgentDeps) {
  try {
    return await decide(draftId, decision, deps);
  } catch (e) {
    if (e instanceof AgentError) throw new DraftError(`The SEO agent could not take the decision: ${e.message}`, e.status >= 500 ? 503 : e.status);
    throw e;
  }
}

/** Scheduler tick (publishDueDrafts): a scheduled, agent-owned draft's time has come → publish_flow with its approval. */
export async function resumeScheduled(draftId: string, now = new Date(), deps: AgentDeps = {}) {
  const db = await getDb();
  const [a] = rowsOf<{ id: string; accepted_change_ids: unknown; approved_by: string }>(
    await db.execute(sql`select id, accepted_change_ids, approved_by from seo_draft_approvals where draft_id = ${draftId} and used_at is null and expires_at > ${now.toISOString()} order by created_at desc limit 1`),
  );
  if (!a) throw new DraftError("No pending approval for this scheduled draft.", 409);
  const ids = Array.isArray(a.accepted_change_ids) ? a.accepted_change_ids.map(String) : String(a.accepted_change_ids ?? "").replace(/^\{|\}$/g, "").split(",").filter(Boolean);
  await send(draftId, { decision: "approve", approval_id: a.id, accepted_change_ids: ids, actor: a.approved_by }, deps);
}

/**
 * Editorial calendar, "Generate draft": the item's CMS draft post (an outline from the brief, or the outline post it
 * already has) → new_article_flow (the Editorial Crew), which writes the article into that post (handoff.ts). Legacy
 * mode (no SEO agent) stops at the outline post.
 */
export async function draftNewArticle(calendarId: string, actor: Actor, deps: AgentDeps = {}) {
  const created = await createDraftFromItem(calendarId, actor);
  if ((await orchestrator(deps)) === "legacy") return { ...created, orchestrator: "legacy" as const };
  return { ...created, ...(await runEditorialCrew(calendarId, created.postId, actor, { trigger: "calendar" }, deps)) };
}

/** The editor's request to Improve, sent to the crew as feedback next to the current draft (`currentDraft` in the brief). */
export const IMPROVE_FEEDBACK =
  "Improve the current draft (current_draft in the brief) instead of starting over: keep its structure, the author's voice and everything that is correct; fix factual and technical errors against your research; complete every outline section it is missing or treats thinly; make code examples minimal, runnable and consistent; cut padding and repetition; keep its first-hand material. Return the complete revised article.";

/**
 * Editorial calendar, "Improve": the crew reads the item's current draft (its CMS post, as the editor left it) and
 * returns a revised version, which replaces the post body only if nobody edits the post meanwhile (handoff.ts). A
 * scheduled post goes back to draft first: the person reviews the improved text and schedules it again.
 */
export async function improveCalendarDraft(calendarId: string, actor: Actor, instructions: string | null, deps: AgentDeps = {}) {
  if ((await orchestrator(deps)) === "legacy") throw new CalendarError("Improve needs the SEO agent, and it is disabled (Automation & AI → SEO agent).", 409);
  const item = await getItem(calendarId);
  if (!item) throw new CalendarError("Calendar item not found.", 404);
  if (item.draft === "published") throw new CalendarError("This item is already published. Improve published articles from the review queue.", 409);
  if (item.draft === "writing") throw new CalendarError("The SEO agent is already writing this draft.", 409);
  if (!item.postId || !["ready", "scheduled"].includes(item.draft)) throw new CalendarError("Generate the draft first: there is nothing to improve yet.", 409);
  const unscheduled = await holdScheduledPost(calendarId, actor, "Unscheduled while the draft is improved. Review it, then press Schedule again.");
  const asked = instructions?.trim().slice(0, 1500);
  const feedback = asked ? `${IMPROVE_FEEDBACK}\nThe editor also asks: ${asked}` : IMPROVE_FEEDBACK;
  return { ...(await runEditorialCrew(calendarId, item.postId, actor, { trigger: "improve", feedback, fresh: true }, deps)), unscheduled };
}

/**
 * Start the Editorial Crew on an item's post. `fresh`: an open draft row from an earlier run is closed first, so the
 * new one snapshots the post as it is now (the handoff only writes over exactly that text).
 */
async function runEditorialCrew(calendarId: string, postId: string, actor: Actor, opts: { trigger: string; feedback?: string; fresh?: boolean }, deps: AgentDeps) {
  const db = await getDb();
  const open = await openDraft(db, postId);
  if (open?.status === "generating") throw new CalendarError("The SEO agent is already writing this draft.", 409);
  if (open && ["scheduled", "publishing"].includes(open.status)) throw new CalendarError("This draft is approved and waiting to publish.", 409);
  if (open && opts.fresh) await db.execute(sql`update seo_drafts set status = 'superseded', failure_reason = 'Replaced by a new run (Improve).', updated_at = now() where id = ${open.id}`);
  const base = await loadBase(db, postId);
  const d = await reserveDraft(db, postId, base, opts.trigger, { kind: "new_article", threadManaged: true, calendarId });
  // A draft reused after a failed attempt shows as being written again, not failed, while the new run works.
  await db.execute(sql`update seo_drafts set status = 'generating', failure_reason = null, calendar_id = ${calendarId}, updated_at = now() where id = ${d.id} and status = 'generation_failed'`);
  await db.execute(sql`update seo_editorial_calendar set status = 'drafting', updated_at = now() where id = ${calendarId} and status not in ('published', 'dropped')`);
  const inputs: Record<string, unknown> = { calendar_id: calendarId, draft_id: d.id, article_id: postId };
  if (opts.feedback) inputs.feedback = opts.feedback;
  const r = await kickoff("new_article_flow", inputs, { actor: actor.label }, deps);
  return { orchestrator: "crewai" as const, draftId: d.id, runId: r.run_id };
}

/**
 * Owner decision 2026-11-10: picking a date for an item that has no draft yet starts "Generate draft" by itself. Same
 * path as the button: a CMS DRAFT post (never published) and, in crewai mode, the Editorial Crew writes it. The post is
 * scheduled only once the person has seen the draft and presses Schedule (calendar-schedule.ts). Returns null when the
 * item has a draft already.
 */
export async function draftIfScheduled(calendarId: string, actor: Actor, deps: AgentDeps = {}) {
  const item = await getItem(calendarId);
  if (!item || !item.targetDate || !["none", "outline"].includes(item.draft)) return null;
  if (item.draft === "outline" && (await orchestrator(deps)) === "legacy") return null;
  return draftNewArticle(calendarId, actor, deps);
}

/** "Run now" for the weekly drafts (crewai mode; the CronJob runs it on schedule). legacy → null (v2 batch). */
export async function weekly(actor?: string, deps: AgentDeps = {}) {
  if ((await orchestrator(deps)) === "legacy") return null;
  return kickoff("weekly_recommendations_flow", {}, { actor }, deps);
}

export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  const w = Math.ceil(((t.getTime() - Date.UTC(y, 0, 1)) / 86_400_000 + 1) / 7);
  return `${y}-W${String(w).padStart(2, "0")}`;
}
