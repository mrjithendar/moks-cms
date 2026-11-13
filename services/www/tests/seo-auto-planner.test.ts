import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db";
import { rowsOf } from "@/db/rows";
import { freshDb } from "./db-helpers";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const { DEFAULT_AUTOMATION_SETTINGS, EDITORIAL_TZ, gapFor, getAutomationSettings, mergeAutomationSettings, planSlots, runPlanner, saveAutomationSettings, windowOf } = await import("@/lib/seo-intel/topics/automation");
const { listTopics } = await import("@/lib/seo-intel/topics/discover");
const { dateIn } = await import("@/lib/seo-intel/sqlutil");
const { JOB_TYPES } = await import("@/lib/seo-intel/jobs");

/**
 * Automatic editorial planning (docs/seo/TOPICS.md): which dates the cadence leaves open, and the calendar items the
 * planner creates with the reason in their notes. Invented test data; no network, no model.
 */
const FRIDAY = "2026-11-13";
const WEEKDAYS = [1, 2, 3, 4, 5];
const settings = (over: Partial<typeof DEFAULT_AUTOMATION_SETTINGS> = {}) => ({ ...DEFAULT_AUTOMATION_SETTINGS, mode: "schedule" as const, ...over });
const dates = (over: Partial<typeof DEFAULT_AUTOMATION_SETTINGS>, taken: Record<string, number> = {}) => planSlots({ today: FRIDAY, settings: settings(over), taken }).map((s) => s.date);

describe("slots (pure)", () => {
  it("windows and gaps follow the period", () => {
    expect(windowOf("2026-11-13", "day")).toBe("2026-11-13");
    expect(windowOf("2026-11-13", "week")).toBe("2026-11-09"); // its Monday
    expect(windowOf("2026-11-15", "week")).toBe("2026-11-09"); // Sunday belongs to the week that started Monday
    expect(windowOf("2026-11-13", "month")).toBe("2026-11");
    expect([gapFor({ count: 3, period: "day" }), gapFor({ count: 2, period: "week" }), gapFor({ count: 5, period: "week" }), gapFor({ count: 4, period: "month" })]).toEqual([0, 3, 1, 7]);
  });

  it("per week: spreads the articles over the allowed weekdays and starts tomorrow", () => {
    expect(dates({ cadence: { count: 2, period: "week" }, days: WEEKDAYS, horizonDays: 14 })).toEqual(["2026-11-16", "2026-11-19", "2026-11-23", "2026-11-26"]);
    const [first] = planSlots({ today: FRIDAY, settings: settings({ cadence: { count: 2, period: "week" }, days: WEEKDAYS }), taken: {} });
    expect(first!.why).toBe("The cadence is 2 per week; this week had 0 of 2 planned, and Monday 2026-11-16 was the first free publishing day at least 3 days from the other planned articles.");
  });

  it("counts items already on the calendar against the quota and keeps its distance from them", () => {
    expect(dates({ cadence: { count: 2, period: "week" }, days: WEEKDAYS, horizonDays: 14 }, { "2026-11-17": 1 })).toEqual(["2026-11-20", "2026-11-23", "2026-11-26"]);
    expect(dates({ cadence: { count: 1, period: "week" }, days: WEEKDAYS, horizonDays: 7 }, { "2026-11-18": 1 })).toEqual([]); // that week is full
  });

  it("per day and per month", () => {
    expect(dates({ cadence: { count: 1, period: "day" }, days: [0, 1, 2, 3, 4, 5, 6], horizonDays: 3 })).toEqual(["2026-11-14", "2026-11-15", "2026-11-16"]);
    expect(dates({ cadence: { count: 2, period: "day" }, days: [0, 1, 2, 3, 4, 5, 6], horizonDays: 1 })).toEqual(["2026-11-14", "2026-11-14"]);
    expect(dates({ cadence: { count: 1, period: "day" }, days: WEEKDAYS, horizonDays: 3 })).toEqual(["2026-11-16"]); // the weekend is skipped
    expect(dates({ cadence: { count: 4, period: "month" }, days: WEEKDAYS, horizonDays: 30 })).toEqual(["2026-11-16", "2026-11-23", "2026-11-30", "2026-12-07"]);
  });
});

describe("settings", () => {
  it("default to off, merge, and reject impossible cadences", async () => {
    await freshDb();
    expect(await getAutomationSettings()).toEqual(DEFAULT_AUTOMATION_SETTINGS);
    expect(DEFAULT_AUTOMATION_SETTINGS.mode).toBe("off");
    expect(mergeAutomationSettings({ mode: "nonsense" })).toEqual(DEFAULT_AUTOMATION_SETTINGS);
    expect(mergeAutomationSettings({ cadence: { count: 5 } }).cadence).toEqual({ count: 5, period: "week" });
    await expect(saveAutomationSettings(settings({ cadence: { count: 9, period: "day" } }), "u1")).rejects.toMatchObject({ issues: [expect.stringMatching(/5 articles a day/)] });
    await expect(saveAutomationSettings(settings({ days: [] }), "u1")).rejects.toMatchObject({ issues: [expect.stringMatching(/^days/)] });
    await expect(saveAutomationSettings(settings({ time: "25:00" }), "u1")).rejects.toMatchObject({ issues: [expect.stringMatching(/^time/)] });
  });
});

describe("the planning job (database)", () => {
  let db: Db;
  const now = new Date();
  const today = dateIn(EDITORIAL_TZ, now);
  const candidate = (title: string, score: number) =>
    db.execute(sql`
      insert into seo_topic_candidates (key, title, kind, score, impressions, parts, reasons)
      values (${title.replace(/ /g, "-")}, ${title}, 'keyword', ${score}, 300, ${JSON.stringify({ demand: 60, trend: 0, fit: 50, ease: 70 })}::jsonb, ${JSON.stringify(["300 search impressions in 28 days, and no article targets it yet."])}::jsonb)`);
  const save = (s: typeof DEFAULT_AUTOMATION_SETTINGS) => db.execute(sql`insert into setting (key, value) values ('automation', ${JSON.stringify(s)}::jsonb) on conflict (key) do update set value = excluded.value`);
  beforeEach(async () => {
    db = await freshDb();
    await candidate("kong gateway on minikube", 80);
    await candidate("argocd app of apps pattern", 70);
    await candidate("helm chart testing basics", 40);
  });

  it("is a registered job type and does nothing while off (the default)", async () => {
    expect(JOB_TYPES).toContain("calendar_plan");
    expect(await runPlanner(db, now)).toMatchObject({ status: "skipped", mode: "off", planned: [] });
    expect(rowsOf(await db.execute(sql`select 1 from seo_editorial_calendar`))).toEqual([]);
  });

  it("schedule: puts the best candidates on dated, approved items and says why the topic and why the date", async () => {
    await save(settings({ cadence: { count: 1, period: "day" }, days: [0, 1, 2, 3, 4, 5, 6], horizonDays: 5, time: "09:30", minScore: 55 }));
    const run = await runPlanner(db, now);
    expect(run).toMatchObject({ status: "succeeded", mode: "schedule", openSlots: 5, candidates: 2 });
    expect(run.planned.map((p) => p.title)).toEqual(["kong gateway on minikube", "argocd app of apps pattern"]);
    const rows = rowsOf<{ title: string; status: string; day: string; time: string; brief: { notes: string; source: string } }>(
      await db.execute(sql`select title, status, to_char(target_date, 'YYYY-MM-DD') as day, to_char(target_time, 'HH24:MI') as time, brief from seo_editorial_calendar order by target_date`),
    );
    expect(rows.map((r) => [r.title, r.status, r.time, r.brief.source])).toEqual([
      ["Kong gateway on minikube", "approved", "09:30", "auto_planner"],
      ["Argocd app of apps pattern", "approved", "09:30", "auto_planner"],
    ]);
    expect(rows.map((r) => r.day)).toEqual(run.planned.map((p) => p.date));
    expect(rows[0]!.day > today).toBe(true);
    const note = rows[0]!.brief.notes;
    expect(note).toContain(`Auto-scheduled on ${today} for ${rows[0]!.day} 09:30 (Asia/Kolkata) by the automatic planner.`);
    expect(note).toContain("Why this topic: score 80/100 (demand 60, trend 0, fit 50, ease 70). 300 search impressions in 28 days");
    expect(note).toContain("Why this date: The cadence is 1 per day; this day had 0 of 1 planned");
    expect(note).toContain("nothing is published without your approval");

    // Used candidates are not planned twice; the one below the minimum score stays a candidate.
    expect((await listTopics(db)).map((t) => t.title)).toEqual(["helm chart testing basics"]);
    expect((await runPlanner(db, now)).planned).toEqual([]);
    expect(rowsOf(await db.execute(sql`select 1 from seo_editorial_calendar`))).toHaveLength(2);
  });

  it("suggest: undated suggestions, and no more of them while earlier ones are still waiting", async () => {
    await save(settings({ mode: "suggest", cadence: { count: 1, period: "day" }, days: [0, 1, 2, 3, 4, 5, 6], horizonDays: 1, minScore: 30 }));
    const run = await runPlanner(db, now);
    expect(run.planned).toEqual([expect.objectContaining({ title: "kong gateway on minikube", date: null })]);
    const [row] = rowsOf<{ status: string; day: string | null; brief: { notes: string } }>(await db.execute(sql`select status, to_char(target_date, 'YYYY-MM-DD') as day, brief from seo_editorial_calendar`));
    expect(row).toMatchObject({ status: "suggested", day: null });
    expect(row!.brief.notes).toMatch(new RegExp(`^Suggested automatically on ${today} by the automatic planner`));
    expect((await runPlanner(db, now)).planned).toEqual([]); // one slot, one suggestion already waiting
    expect((await listTopics(db)).map((t) => t.title)).toEqual(["argocd app of apps pattern", "helm chart testing basics"]);
  });

  it("an item added by hand fills the quota", async () => {
    await save(settings({ cadence: { count: 1, period: "day" }, days: [0, 1, 2, 3, 4, 5, 6], horizonDays: 1, minScore: 0 }));
    const tomorrow = new Date(new Date(`${today}T00:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);
    await db.execute(sql`insert into seo_editorial_calendar (title, status, kind, target_date, brief) values ('Written by hand', 'approved', 'editorial_idea', ${tomorrow}::date, '{}'::jsonb)`);
    expect(await runPlanner(db, now)).toMatchObject({ openSlots: 0, planned: [] });
  });
});
