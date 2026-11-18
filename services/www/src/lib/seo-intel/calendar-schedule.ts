import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { rowsOf } from "@/db/rows";
import { PostError, publishPost, updatePost, type Actor } from "../posts";
import { CalendarError, isOutline } from "./calendar";
import { isDay } from "./sqlutil";

/**
 * Scheduling an editorial calendar item (owner decision 2026-11-18, docs/seo/DECISIONS.md D-94): the person who
 * picks a date and time schedules the item's draft post to publish then, exactly as the editor's Schedule button
 * would (publishPost with a future date, in their name); the CMS's own scheduler publishes it when the time comes.
 * Scheduling is the person's approval of the draft as it is, so:
 *
 * - only a person's request reaches this module (the calendar's schedule route); no agent, job or tick calls it;
 * - only a draft that exists and that they could read is scheduled: a post with real content (not the generated
 *   outline) whose SEO-agent draft has no fact-check errors. Otherwise the date is kept with a note saying why the
 *   post is not scheduled yet, and nothing is published;
 * - the time must be in the future: publishing now stays the editor's Publish button;
 * - unscheduling (or deleting the item, or improving its draft) puts a scheduled post back to draft.
 */

/** Editorial time zone: Asia/Kolkata, no daylight saving. */
const IST_OFFSET = "+05:30";
/** The time of day used when an item has a date but no time. */
export const DEFAULT_TIME = "09:00";
/** A scheduled time must be at least this far ahead, so it can never mean "publish now". */
const MIN_LEAD_MS = 2 * 60_000;

export const publishAtOf = (date: string, time: string | null) => new Date(`${date}T${time ?? DEFAULT_TIME}:00${IST_OFFSET}`);

type ItemRow = { id: string; status: string; post_id: string | null; post_status: string | null; post_body: string | null; agent_errors: number };

async function itemRow(id: string): Promise<ItemRow> {
  const db = await getDb();
  const [row] = rowsOf<ItemRow>(
    await db.execute(sql`
      select c.id, c.status, c.post_id, p.status as post_status, p.body as post_body,
        coalesce((select count(*)::int from seo_drafts d, jsonb_array_elements(d.flags) f
          where d.id = (select id from seo_drafts where calendar_id = c.id and kind = 'new_article' order by created_at desc limit 1)
            and f->>'severity' = 'error'), 0) as agent_errors
      from seo_editorial_calendar c left join post p on p.id = c.post_id and p.deleted_at is null
      where c.id = ${id} and c.status <> 'dropped'`),
  );
  if (!row) throw new CalendarError("Calendar item not found.", 404);
  return row;
}

async function note(id: string, text: string | null, scheduledBy: string | null) {
  const db = await getDb();
  await db.execute(sql`update seo_editorial_calendar set schedule_note = ${text}, scheduled_by = ${scheduledBy}, updated_at = now() where id = ${id}`);
}

export type ScheduleResult = { scheduled: boolean; publishAt: string; note: string | null };

/**
 * Set the item's date and time and, when its draft is ready, schedule the post to publish then. The date is kept
 * either way; `note` says why the post was not scheduled.
 */
export async function scheduleItem(id: string, actor: Actor, date: string, time: string | null, now = new Date()): Promise<ScheduleResult> {
  if (!isDay(date)) throw new CalendarError("Use a date as YYYY-MM-DD.", 400);
  if (time !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new CalendarError("Use a time as HH:MM (24-hour).", 400);
  const when = publishAtOf(date, time);
  if (when.getTime() < now.getTime() + MIN_LEAD_MS) throw new CalendarError("Pick a time in the future. To publish now, use Publish in the post editor.", 400);
  const item = await itemRow(id);
  if (item.status === "published" || item.post_status === "published") throw new CalendarError("This item is already published.", 409);
  const db = await getDb();
  await db.execute(sql`update seo_editorial_calendar set target_date = ${date}::date, target_time = ${time}::time, updated_at = now() where id = ${id}`);
  const publishAt = when.toISOString();

  // Only a reason about a written draft is stored (the calendar shows it until the next Schedule); "no draft yet" and
  // "not written yet" follow from the draft's state, which the calendar shows as it changes.
  const wait = async (why: string, store = true) => {
    await note(id, store ? why : null, actor.id);
    return { scheduled: false, publishAt, note: why };
  };
  if (!item.post_id || !item.post_status) return wait("No draft yet. Generate the draft, review it, then press Schedule again.", false);
  if (isOutline(item.post_body)) return wait("The draft is not written yet. When it is ready, review it, then press Schedule again.", false);
  if (!["draft", "review", "scheduled"].includes(item.post_status)) return wait(`The post is ${item.post_status}; it was not scheduled.`);
  if (item.agent_errors > 0) return wait(`The draft has ${item.agent_errors} fact-check error(s). Fix them in the editor, then press Schedule again.`);
  try {
    await publishPost(actor, item.post_id, { publishedAt: publishAt }, {}, now);
  } catch (e) {
    if (e instanceof PostError) return wait(`The post is not ready to publish: ${[e.message, ...(e.issues ?? [])].join(" · ")}`.slice(0, 1000));
    throw e;
  }
  await note(id, null, actor.id);
  return { scheduled: true, publishAt, note: null };
}

/** Clear the item's date; a post this calendar scheduled goes back to draft (never published). */
export async function unscheduleItem(id: string, actor: Actor): Promise<{ unscheduled: boolean }> {
  const item = await itemRow(id);
  if (item.status === "published" || item.post_status === "published") throw new CalendarError("This item is already published.", 409);
  if (item.post_id && item.post_status === "scheduled") await updatePost(actor, item.post_id, { status: "draft" }, { reason: "unschedule", incompleteDrafts: true });
  const db = await getDb();
  await db.execute(sql`update seo_editorial_calendar set target_date = null, target_time = null, scheduled_by = null, schedule_note = null, updated_at = now() where id = ${id}`);
  return { unscheduled: true };
}

/** Before its draft is rewritten (Improve) or the item is deleted: a scheduled post goes back to draft, the date stays. */
export async function holdScheduledPost(id: string, actor: Actor, why: string): Promise<boolean> {
  const item = await itemRow(id);
  if (!item.post_id || item.post_status !== "scheduled") return false;
  await updatePost(actor, item.post_id, { status: "draft" }, { reason: "unschedule", incompleteDrafts: true });
  await note(id, why, null);
  return true;
}
