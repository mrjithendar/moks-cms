import { z } from "zod";
import { addDays, isDay } from "../seo-intel/sqlutil";
import type { ReportRange } from "./types";

/**
 * Report date ranges, in the editorial time zone (Asia/Kolkata, UTC+05:30 all year). Each range is compared with the
 * equal-length period just before it. The longest range is two years: Search Console keeps 16 months, and a longer
 * range only makes the queries slower without adding data.
 */
export const TIMEZONE = "Asia/Kolkata";
export const PRESETS = { today: "Today", yesterday: "Yesterday", last_7_days: "Last 7 days", last_30_days: "Last 30 days", last_90_days: "Last 90 days", this_month: "This month", previous_month: "Previous month", custom: "Custom range" } as const;
export type Preset = keyof typeof PRESETS;
export const PRESET_KEYS = Object.keys(PRESETS) as Preset[];
export const MAX_DAYS = 731;

export const istToday = (now = new Date()) => new Date(now.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000) + 1;

export class RangeError extends Error {}

export const rangeInput = z.object({
  preset: z.enum(PRESET_KEYS as [Preset, ...Preset[]]),
  start: z.string().refine(isDay, "Use YYYY-MM-DD").optional(),
  end: z.string().refine(isDay, "Use YYYY-MM-DD").optional(),
});

/** The dates of a preset (or a checked custom range), and the period it is compared with. */
export function resolveRange(input: z.output<typeof rangeInput>, now = new Date()): ReportRange {
  const today = istToday(now);
  let start: string;
  let end: string;
  switch (input.preset) {
    case "today":
      start = end = today;
      break;
    case "yesterday":
      start = end = addDays(today, -1);
      break;
    case "last_7_days":
      [start, end] = [addDays(today, -6), today];
      break;
    case "last_30_days":
      [start, end] = [addDays(today, -29), today];
      break;
    case "last_90_days":
      [start, end] = [addDays(today, -89), today];
      break;
    case "this_month":
      [start, end] = [`${today.slice(0, 7)}-01`, today];
      break;
    case "previous_month": {
      end = addDays(`${today.slice(0, 7)}-01`, -1);
      start = `${end.slice(0, 7)}-01`;
      break;
    }
    default: {
      if (!input.start || !input.end) throw new RangeError("A custom range needs a start and an end date.");
      [start, end] = [input.start, input.end];
      if (start > end) throw new RangeError("The start date is after the end date.");
      if (end > today) throw new RangeError(`The end date is in the future (today is ${today} in India Standard Time).`);
      if (start < "2020-01-01") throw new RangeError("The start date is before 2020.");
    }
  }
  const days = daysBetween(start, end);
  if (days > MAX_DAYS) throw new RangeError(`A report covers at most ${MAX_DAYS} days; this range has ${days}.`);
  const previousEnd = addDays(start, -1);
  return { preset: input.preset, label: input.preset === "custom" ? `${start} – ${end}` : PRESETS[input.preset], start, end, previousStart: addDays(previousEnd, -(days - 1)), previousEnd, days, timezone: TIMEZONE };
}

/** The instants a range covers, for timestamp columns: [start 00:00 IST, the day after end 00:00 IST). */
export function bounds(start: string, end: string): { from: string; to: string } {
  return { from: `${start}T00:00:00+05:30`, to: `${addDays(end, 1)}T00:00:00+05:30` };
}

/** Every day of a range, for daily charts. */
export function eachDay(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end && out.length <= MAX_DAYS; d = addDays(d, 1)) out.push(d);
  return out;
}
