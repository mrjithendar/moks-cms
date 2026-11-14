import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
import { siteUrl } from "@/config/site";
import { log } from "../../log";
import type { Actor } from "../../posts";
import { addDays, dateIn, daysBetween } from "../sqlutil";
import { listTopics, topicToCalendar, type StoredTopic } from "./discover";

/**
 * Automatic editorial planning (docs/seo/TOPICS.md "Automatic planning"): turns the best topic candidates into
 * editorial-calendar items on a cadence, and writes into each item's notes why the topic and why the date.
 *
 * Modes: off · suggest (items appear as suggestions without a date; a person approves and dates them) · schedule
 * (approved items with a date and time) · schedule_and_draft (the same, and the draft is written ahead of the date).
 * Nothing here publishes: a scheduled item is a plan, and every draft still waits for a person's approval.
 */
const KEY = "automation";
export const EDITORIAL_TZ = "Asia/Kolkata";

export const MODES = ["off", "suggest", "schedule", "schedule_and_draft"] as const;
export type Mode = (typeof MODES)[number];
export const MODE_LABELS: Record<Mode, string> = {
  off: "Off",
  suggest: "Suggest only: add the best topics to the calendar as suggestions (no date)",
  schedule: "Schedule: add them as approved items with a date",
  schedule_and_draft: "Schedule and draft: also write the draft ahead of the date",
};
export const PERIODS = ["day", "week", "month"] as const;
export type Period = (typeof PERIODS)[number];

export const automationSchema = z
  .object({
    mode: z.enum(MODES),
    /** How many articles per period. */
    cadence: z.object({ count: z.number().int().min(1).max(31), period: z.enum(PERIODS) }),
    /** Weekdays an article may be scheduled on (0 = Sunday … 6 = Saturday). */
    days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    /** Time of day for scheduled items, HH:MM in the editorial time zone (Asia/Kolkata). */
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24-hour)"),
    /** How many days ahead the calendar is kept filled. */
    horizonDays: z.number().int().min(1).max(60),
    /** Only candidates scoring at least this are planned. */
    minScore: z.number().min(0).max(100),
    /** Schedule and draft: the draft is written this many days before the item's date (0 = on the day). */
    draftLeadDays: z.number().int().min(0).max(14),
    /** Schedule and draft: drafts started per daily run (each is one Editorial Crew run; see docs/seo/COSTS.md). */
    maxDraftsPerRun: z.number().int().min(1).max(5),
    /** Email when an automatically planned draft is ready. No recipients: every admin account's address. */
    notify: z.object({ enabled: z.boolean(), recipients: z.array(z.string().trim().toLowerCase().email().max(200)).max(5) }),
  })
  .strict()
  .refine((v) => !(v.cadence.period === "day" && v.cadence.count > 5), "At most 5 articles a day.")
  .refine((v) => !(v.cadence.period === "week" && v.cadence.count > 14), "At most 14 articles a week.");

export type AutomationSettings = z.infer<typeof automationSchema>;

export const DEFAULT_AUTOMATION_SETTINGS: AutomationSettings = { mode: "off", cadence: { count: 2, period: "week" }, days: [1, 2, 3, 4, 5], time: "10:00", horizonDays: 14, minScore: 55, draftLeadDays: 3, maxDraftsPerRun: 2, notify: { enabled: true, recipients: [] } };

export class AutomationSettingsError extends Error {
  constructor(
    message: string,
    readonly issues: string[],
  ) {
    super(message);
  }
}

export function mergeAutomationSettings(stored: unknown): AutomationSettings {
  const s = (stored && typeof stored === "object" ? stored : {}) as Partial<AutomationSettings>;
  const d = DEFAULT_AUTOMATION_SETTINGS;
  const parsed = automationSchema.safeParse({ ...d, ...s, cadence: { ...d.cadence, ...(s.cadence ?? {}) }, notify: { ...d.notify, ...(s.notify ?? {}) } });
  return parsed.success ? parsed.data : d;
}

export async function getAutomationSettings(): Promise<AutomationSettings> {
  const db = await getDb();
  const [row] = await db.select().from(schema.setting).where(eq(schema.setting.key, KEY));
  return mergeAutomationSettings(row?.value);
}

export async function saveAutomationSettings(raw: unknown, actorId: string): Promise<{ before: AutomationSettings; after: AutomationSettings }> {
  const parsed = automationSchema.safeParse(raw ?? {});
  if (!parsed.success) throw new AutomationSettingsError("The settings are not valid.", parsed.error.issues.map((i) => `${i.path.join(".") || "settings"}: ${i.message}`));
  const next = { ...parsed.data, days: [...new Set(parsed.data.days)].sort((a, b) => a - b), notify: { ...parsed.data.notify, recipients: [...new Set(parsed.data.notify.recipients)] } };
  const before = await getAutomationSettings();
  const db = await getDb();
  await db
    .insert(schema.setting)
    .values({ key: KEY, value: next, updatedBy: actorId })
    .onConflictDoUpdate({ target: schema.setting.key, set: { value: next, updatedBy: actorId, updatedAt: new Date() } });
  return { before, after: next };
}

// --- Slots (pure) ----------------------------------------------------------------------------------------------------

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const weekdayOf = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay();
/** The period a day belongs to: the day itself, its Monday (ISO week) or its month. */
export function windowOf(day: string, period: Period): string {
  if (period === "day") return day;
  if (period === "month") return day.slice(0, 7);
  return addDays(day, -((weekdayOf(day) + 6) % 7));
}
/** Days between two planned articles so that a period's articles are spread out, not stacked on its first days. */
export const gapFor = (c: AutomationSettings["cadence"]) => (c.period === "day" ? 0 : Math.max(1, Math.floor((c.period === "week" ? 7 : 30) / c.count)));

export type Slot = { date: string; why: string };

/**
 * The dates to fill, earliest first. `taken` is every date that already has a calendar item (manual or automatic),
 * with how many: those count against the period's quota, so the planner tops the calendar up and never adds to a
 * period that is already full.
 */
export function planSlots(input: { today: string; settings: AutomationSettings; taken: Record<string, number> }): Slot[] {
  const { today, settings: s } = input;
  const { count, period } = s.cadence;
  const taken = new Map(Object.entries(input.taken));
  const used = new Map<string, number>();
  for (const [d, n] of taken) used.set(windowOf(d, period), (used.get(windowOf(d, period)) ?? 0) + n);
  const gap = gapFor(s.cadence);
  const tooClose = (d: string) => [...taken.keys()].some((t) => Math.abs(daysBetween(t, d)) < gap);
  const label = period === "day" ? "day" : period;
  const out: Slot[] = [];
  for (let i = 1; i <= s.horizonDays; i++) {
    const d = addDays(today, i);
    if (!s.days.includes(weekdayOf(d))) continue;
    const w = windowOf(d, period);
    while ((used.get(w) ?? 0) < count && (period === "day" ? (taken.get(d) ?? 0) < count : !tooClose(d))) {
      const before = used.get(w) ?? 0;
      out.push({ date: d, why: `The cadence is ${count} per ${label}; this ${label} had ${before} of ${count} planned, and ${WEEKDAYS[weekdayOf(d)]} ${d} was the first free publishing day${gap > 1 ? ` at least ${gap} days from the other planned articles` : ""}.` });
      used.set(w, before + 1);
      taken.set(d, (taken.get(d) ?? 0) + 1);
    }
  }
  return out;
}

// --- The job ---------------------------------------------------------------------------------------------------------

export type PlanResult = { status: "succeeded" | "skipped"; mode: Mode; planned: { calendarId: string; title: string; date: string | null; score: number }[]; openSlots: number; candidates: number; reason?: string };

/** The note written on an automatically planned item: who put it there, why this topic, why this date. */
export function autoNote(t: StoredTopic, today: string, slot: Slot | null, time: string): string {
  const head = slot ? `Auto-scheduled on ${today} for ${slot.date} ${time} (${EDITORIAL_TZ}) by the automatic planner.` : `Suggested automatically on ${today} by the automatic planner (no date yet: approve it and pick one).`;
  const topic = `Why this topic: score ${t.score}/100 (demand ${Math.round(t.parts.demand)}, trend ${Math.round(t.parts.trend)}, fit ${Math.round(t.parts.fit)}, ease ${Math.round(t.parts.ease)}). ${t.reasons.join(" ")}`;
  return [head, topic, slot ? `Why this date: ${slot.why}` : "", "Change the date or drop the item like any other; nothing is published without your approval."].filter(Boolean).join("\n").slice(0, 4000);
}

export async function runPlanner(db: Db, now: Date = new Date()): Promise<PlanResult> {
  const s = await getAutomationSettings();
  if (s.mode === "off") return { status: "skipped", mode: s.mode, planned: [], openSlots: 0, candidates: 0, reason: "Automatic planning is off." };
  const today = dateIn(EDITORIAL_TZ, now);
  // Every dated item around the horizon (a week or month window can start before today and end after the horizon).
  const rows = rowsOf<{ day: string; n: number }>(
    await db.execute(sql`
      select to_char(target_date, 'YYYY-MM-DD') as day, count(*)::int as n from seo_editorial_calendar
      where status <> 'dropped' and target_date between ${addDays(today, -31)}::date and ${addDays(today, s.horizonDays + 31)}::date group by 1`),
  );
  let slots = planSlots({ today, settings: s, taken: Object.fromEntries(rows.map((r) => [r.day, Number(r.n)])) });
  if (s.mode === "suggest") {
    // Suggestions have no date, so they do not fill a slot: count the ones still waiting, or every run would add more.
    const [w] = rowsOf<{ n: number }>(await db.execute(sql`select count(*)::int as n from seo_editorial_calendar where status = 'suggested' and brief->>'source' = 'auto_planner'`));
    slots = slots.slice(0, Math.max(0, slots.length - Number(w?.n ?? 0)));
  }
  const candidates = (await listTopics(db, "new", 200)).filter((t) => t.score >= s.minScore);
  const planned: PlanResult["planned"] = [];
  for (const slot of slots) {
    const t = candidates.shift();
    if (!t) break;
    const scheduled = s.mode !== "suggest";
    const r = await topicToCalendar(db, t.id, {
      status: scheduled ? "approved" : "suggested",
      targetDate: scheduled ? slot.date : null,
      targetTime: scheduled ? s.time : null,
      notes: autoNote(t, today, scheduled ? slot : null, s.time),
      source: "auto_planner",
    });
    if (r) planned.push({ calendarId: r.calendarId, title: t.title, date: scheduled ? slot.date : null, score: t.score });
  }
  return { status: "succeeded", mode: s.mode, planned, openSlots: slots.length, candidates: candidates.length + planned.length };
}

// --- Automatic drafting (mode "schedule_and_draft") -----------------------------------------------------------------

export type AutoDraftDeps = {
  /** Starts the draft of one calendar item. Default: the same path as the calendar's "Create draft" (Editorial Crew). */
  draft?: (calendarId: string, actor: Actor) => Promise<unknown>;
  env?: Record<string, string | undefined>;
};
export type AutoDraftResult = { status: "succeeded" | "partial" | "failed" | "skipped"; started: { calendarId: string; title: string; date: string }[]; failed: { calendarId: string; title: string; error: string }[]; reason?: string };

/** Automatically planned, approved items without a draft whose date is within the lead time, soonest first. */
export async function dueForDraft(db: Db, s: AutomationSettings, today: string): Promise<{ id: string; title: string; date: string }[]> {
  return rowsOf<{ id: string; title: string; date: string }>(
    await db.execute(sql`
      select id, title, to_char(target_date, 'YYYY-MM-DD') as date from seo_editorial_calendar
      where status = 'approved' and post_id is null and brief->>'source' = 'auto_planner'
        and target_date between ${today}::date and ${addDays(today, s.draftLeadDays)}::date
      order by target_date, priority_score desc limit ${s.maxDraftsPerRun}`),
  );
}

/**
 * Start the drafts that are due. Each goes through the calendar's own path (a CMS draft post, then new_article_flow:
 * the Editorial Crew writes it, the validator checks it, and it waits for a person). The monthly LLM budget still
 * applies inside the agent; a draft it refuses is reported on that draft, not here.
 */
export async function runAutoDraft(db: Db, now: Date = new Date(), deps: AutoDraftDeps = {}): Promise<AutoDraftResult> {
  const s = await getAutomationSettings();
  const none = { started: [], failed: [] };
  if (s.mode !== "schedule_and_draft") return { status: "skipped", ...none, reason: "Automatic drafting is off (mode is not \"Schedule and draft\")." };
  const { orchestrator } = await import("../../seo-agent/config");
  if (orchestrator(deps.env) !== "crewai") return { status: "skipped", ...none, reason: "Drafts are written by the Editorial Crew: set SEO_ORCHESTRATOR=crewai." };
  const [u] = rowsOf<{ id: string; email: string }>(await db.execute(sql`select id, email from "user" where role = 'admin' order by created_at asc limit 1`));
  if (!u) return { status: "skipped", ...none, reason: "No admin account to own the draft posts." };
  const actor: Actor = { id: u.id, role: "admin", label: `auto-planner (${u.email})` };
  const draft = deps.draft ?? (async (id: string, a: Actor) => (await import("../../seo-agent/orchestrate")).draftNewArticle(id, a, { env: deps.env }));
  const out: AutoDraftResult = { status: "succeeded", started: [], failed: [] };
  for (const item of await dueForDraft(db, s, dateIn(EDITORIAL_TZ, now))) {
    try {
      await draft(item.id, actor);
      out.started.push({ calendarId: item.id, title: item.title, date: item.date });
    } catch (e) {
      out.failed.push({ calendarId: item.id, title: item.title, error: (e instanceof Error ? e.message : String(e)).slice(0, 300) });
    }
  }
  if (out.failed.length) out.status = out.started.length ? "partial" : "failed";
  return out;
}

// --- Email when an automatically planned draft is ready ---------------------------------------------------------------

export type ReadyItem = { title: string; date: string | null; time: string | null; notes: string; postId: string | null; draftId: string; handedOff: boolean; flags: number };

/** Plain-text email: what is ready, when it is scheduled, why it was planned, and where to review it. */
export function draftReadyEmail(item: ReadyItem, base: string): { subject: string; text: string } {
  const when = item.date ? `${item.date}${item.time ? ` ${item.time}` : ""} (${EDITORIAL_TZ})` : "no date";
  const link = item.handedOff && item.postId ? `${base}/admin/posts/${item.postId}` : `${base}/admin/review/${item.draftId}`;
  const text = [
    "A draft from the automatic planner is ready for your review.",
    "",
    `Title: ${item.title}`,
    `Scheduled for: ${when}`,
    item.flags ? `Fact-check notes from the crew: ${item.flags} (shown next to the draft)` : "Fact-check notes from the crew: none",
    "",
    item.notes,
    "",
    `Review it: ${link}`,
    `Calendar: ${base}/admin/calendar`,
    "",
    "Nothing is published until you publish it yourself.",
  ].join("\n");
  return { subject: `Draft ready for review: ${item.title}${item.date ? ` (scheduled ${item.date})` : ""}`.slice(0, 200), text };
}

type MailDeps = { send?: (to: string, subject: string, text: string) => Promise<boolean>; mailReady?: () => Promise<boolean>; base?: string };

/**
 * Called when the crew's draft for a calendar item has been saved (seo-agent/callbacks.ts saveDraft). Sends the email
 * only for automatically planned items, when notifications are on and an email provider is set up. Never throws.
 */
export async function notifyDraftReady(db: Db, input: { calendarId: string; draftId: string; handedOff: boolean }, deps: MailDeps = {}): Promise<{ sent: number; reason?: string }> {
  try {
    const [c] = rowsOf<{ title: string; date: string | null; time: string | null; brief: unknown; post_id: string | null }>(
      await db.execute(sql`select title, to_char(target_date, 'YYYY-MM-DD') as date, to_char(target_time, 'HH24:MI') as time, brief, post_id from seo_editorial_calendar where id = ${input.calendarId}`),
    );
    const brief = (typeof c?.brief === "string" ? JSON.parse(c.brief) : (c?.brief ?? {})) as { source?: string; notes?: string };
    if (!c || brief.source !== "auto_planner") return { sent: 0, reason: "not_auto_planned" };
    const s = await getAutomationSettings();
    if (!s.notify.enabled) return { sent: 0, reason: "notifications_off" };
    const mail = await import("../../mail");
    if (!(await (deps.mailReady ?? mail.mailConfigured)())) return { sent: 0, reason: "mail_not_configured" };
    const recipients = s.notify.recipients.length ? s.notify.recipients : rowsOf<{ email: string }>(await db.execute(sql`select email from "user" where role = 'admin' order by created_at asc limit 5`)).map((r) => r.email);
    if (!recipients.length) return { sent: 0, reason: "no_recipient" };
    const [d] = rowsOf<{ flags: unknown; title: string | null }>(await db.execute(sql`select flags, document->>'title' as title from seo_drafts where id = ${input.draftId}`));
    const flags = (typeof d?.flags === "string" ? JSON.parse(d.flags) : (d?.flags ?? [])) as unknown[];
    const { subject, text } = draftReadyEmail(
      { title: (d?.title || c.title).slice(0, 150), date: c.date, time: c.time, notes: String(brief.notes ?? ""), postId: c.post_id, draftId: input.draftId, handedOff: input.handedOff, flags: Array.isArray(flags) ? flags.length : 0 },
      deps.base ?? siteUrl(),
    );
    const send = deps.send ?? mail.sendMail;
    let sent = 0;
    for (const to of recipients) if (await send(to, subject, text)) sent++;
    log.info("auto-planned draft notification", { operation: "seo_auto_draft_notify", outcome: sent ? "sent" : "failed", count: sent });
    return { sent };
  } catch (err) {
    log.warn("auto-planned draft notification failed", { err, operation: "seo_auto_draft_notify" });
    return { sent: 0, reason: "error" };
  }
}
