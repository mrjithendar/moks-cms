import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
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
  })
  .strict()
  .refine((v) => !(v.cadence.period === "day" && v.cadence.count > 5), "At most 5 articles a day.")
  .refine((v) => !(v.cadence.period === "week" && v.cadence.count > 14), "At most 14 articles a week.");

export type AutomationSettings = z.infer<typeof automationSchema>;

export const DEFAULT_AUTOMATION_SETTINGS: AutomationSettings = { mode: "off", cadence: { count: 2, period: "week" }, days: [1, 2, 3, 4, 5], time: "10:00", horizonDays: 14, minScore: 55 };

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
  const parsed = automationSchema.safeParse({ ...d, ...s, cadence: { ...d.cadence, ...(s.cadence ?? {}) } });
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
  const next = { ...parsed.data, days: [...new Set(parsed.data.days)].sort((a, b) => a - b) };
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
