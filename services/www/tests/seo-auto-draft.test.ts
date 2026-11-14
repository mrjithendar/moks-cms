import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { schema, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
import { freshDb } from "./db-helpers";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const { DEFAULT_AUTOMATION_SETTINGS, EDITORIAL_TZ, draftReadyEmail, dueForDraft, notifyDraftReady, runAutoDraft, saveAutomationSettings } = await import("@/lib/seo-intel/topics/automation");
const { addDays, dateIn } = await import("@/lib/seo-intel/sqlutil");
const { JOB_TYPES } = await import("@/lib/seo-intel/jobs");

/**
 * Automatic drafting of planned calendar items and the "draft ready" email (docs/seo/TOPICS.md). The Editorial Crew
 * and the mail provider are replaced by fakes; invented test data.
 */
const CREWAI = { SEO_ORCHESTRATOR: "crewai" };
const NOTE = "Auto-scheduled on 2026-11-14 for 2026-11-16 10:00 (Asia/Kolkata) by the automatic planner.\nWhy this topic: score 62/100.";

describe("automatic drafting and the ready email", () => {
  let db: Db;
  const now = new Date();
  const today = dateIn(EDITORIAL_TZ, now);
  const save = (over: Partial<typeof DEFAULT_AUTOMATION_SETTINGS>) => db.execute(sql`insert into setting (key, value) values ('automation', ${JSON.stringify({ ...DEFAULT_AUTOMATION_SETTINGS, ...over })}::jsonb) on conflict (key) do update set value = excluded.value`);
  const item = async (title: string, opts: { inDays?: number | null; status?: string; source?: string; score?: number } = {}) => {
    const date = opts.inDays === null ? null : addDays(today, opts.inDays ?? 1);
    const [r] = rowsOf<{ id: string }>(
      await db.execute(sql`
        insert into seo_editorial_calendar (title, status, kind, priority_score, target_date, target_time, brief)
        values (${title}, ${opts.status ?? "approved"}, 'measured', ${opts.score ?? 60}, ${date}::date, ${date ? "10:00" : null}::time, ${JSON.stringify({ source: opts.source ?? "auto_planner", notes: NOTE })}::jsonb) returning id`),
    );
    return r!.id;
  };
  const fakeCrew = (failFor: string[] = []) => {
    const calls: { id: string; actor: string }[] = [];
    return {
      calls,
      draft: async (id: string, actor: { id: string; label: string }) => {
        calls.push({ id, actor: actor.id });
        if (failFor.includes(id)) throw new Error("The SEO agent is unreachable.");
        return { postId: "p" };
      },
    };
  };

  beforeEach(async () => {
    db = await freshDb();
    await db.insert(schema.user).values([
      { id: "owner", name: "Owner", email: "owner@example.com", role: "admin" },
      { id: "writer", name: "Writer", email: "writer@example.com", role: "author" },
    ]);
  });

  it("settings: sensible defaults, validated recipients", async () => {
    expect(JOB_TYPES).toContain("calendar_autodraft");
    expect(DEFAULT_AUTOMATION_SETTINGS).toMatchObject({ draftLeadDays: 3, maxDraftsPerRun: 2, notify: { enabled: true, recipients: [] } });
    await expect(saveAutomationSettings({ ...DEFAULT_AUTOMATION_SETTINGS, notify: { enabled: true, recipients: ["not-an-email"] } }, "owner")).rejects.toMatchObject({ issues: [expect.stringMatching(/^notify\.recipients/)] });
    const { after } = await saveAutomationSettings({ ...DEFAULT_AUTOMATION_SETTINGS, notify: { enabled: true, recipients: ["Me@Example.com", "me@example.com"] } }, "owner");
    expect(after.notify.recipients).toEqual(["me@example.com"]);
  });

  it("does nothing unless the mode is schedule and draft, and needs the CrewAI orchestrator", async () => {
    await item("Due tomorrow");
    const crew = fakeCrew();
    await save({ mode: "schedule" });
    expect(await runAutoDraft(db, now, { draft: crew.draft, env: CREWAI })).toMatchObject({ status: "skipped", started: [] });
    await save({ mode: "schedule_and_draft" });
    expect(await runAutoDraft(db, now, { draft: crew.draft, env: {} })).toMatchObject({ status: "skipped", reason: expect.stringMatching(/SEO_ORCHESTRATOR=crewai/) });
    expect(crew.calls).toEqual([]);
  });

  it("drafts only automatically planned, approved, undrafted items inside the lead time, soonest first, up to the daily limit", async () => {
    await save({ mode: "schedule_and_draft", draftLeadDays: 3, maxDraftsPerRun: 2 });
    const later = await item("In three days", { inDays: 3 });
    const soon = await item("Tomorrow", { inDays: 1 });
    const third = await item("In two days", { inDays: 2 });
    await item("Too far ahead", { inDays: 4 });
    await item("Added by hand", { inDays: 1, source: "manual" });
    await item("Only suggested", { inDays: 1, status: "suggested" });
    await item("No date", { inDays: null });
    await item("In the past", { inDays: -1 });
    expect((await dueForDraft(db, { ...DEFAULT_AUTOMATION_SETTINGS, draftLeadDays: 3, maxDraftsPerRun: 5 }, today)).map((r) => r.id)).toEqual([soon, third, later]);

    const crew = fakeCrew();
    const run = await runAutoDraft(db, now, { draft: crew.draft, env: CREWAI });
    expect(run).toMatchObject({ status: "succeeded", failed: [] });
    expect(run.started.map((s) => s.calendarId)).toEqual([soon, third]); // the daily limit is 2
    expect(crew.calls).toEqual([{ id: soon, actor: "owner" }, { id: third, actor: "owner" }]); // drafts belong to the first admin
  });

  it("reports drafts that could not be started without stopping the others", async () => {
    await save({ mode: "schedule_and_draft", maxDraftsPerRun: 5 });
    const a = await item("First", { inDays: 1 });
    const b = await item("Second", { inDays: 2 });
    const partial = await runAutoDraft(db, now, { draft: fakeCrew([a]).draft, env: CREWAI });
    expect(partial).toMatchObject({ status: "partial", started: [{ calendarId: b }], failed: [{ calendarId: a, error: "The SEO agent is unreachable." }] });
    expect(await runAutoDraft(db, now, { draft: fakeCrew([a, b]).draft, env: CREWAI })).toMatchObject({ status: "failed", started: [] });
  });

  it("email text: what is ready, when, why, and where to review it", () => {
    const base = { title: "Kong Gateway on Minikube", date: "2026-11-16", time: "10:00", notes: NOTE, postId: "11111111-1111-4111-8111-111111111111", draftId: "22222222-2222-4222-8222-222222222222", flags: 2 };
    const inCms = draftReadyEmail({ ...base, handedOff: true }, "https://jithendar.com");
    expect(inCms.subject).toBe("Draft ready for review: Kong Gateway on Minikube (scheduled 2026-11-16)");
    expect(inCms.text).toContain("Scheduled for: 2026-11-16 10:00 (Asia/Kolkata)");
    expect(inCms.text).toContain("Fact-check notes from the crew: 2");
    expect(inCms.text).toContain("Why this topic: score 62/100.");
    expect(inCms.text).toContain("Review it: https://jithendar.com/admin/posts/11111111-1111-4111-8111-111111111111");
    expect(inCms.text).toContain("Nothing is published until you publish it yourself.");
    expect(inCms.text).not.toMatch(/approve\?|token=/); // a link to the admin, never a one-click approval
    const inQueue = draftReadyEmail({ ...base, handedOff: false, flags: 0 }, "https://jithendar.com");
    expect(inQueue.text).toContain("Review it: https://jithendar.com/admin/review/22222222-2222-4222-8222-222222222222");
    expect(inQueue.text).toContain("Fact-check notes from the crew: none");
  });

  it("emails the admins (or the configured recipients) for automatically planned items only", async () => {
    const sent: { to: string; subject: string; text: string }[] = [];
    const deps = { send: async (to: string, subject: string, text: string) => (sent.push({ to, subject, text }), true), mailReady: async () => true, base: "https://jithendar.com" };
    const draftId = "33333333-3333-4333-8333-333333333333";
    const auto = await item("Kong gateway on minikube");
    const manual = await item("Written by hand", { source: "manual" });

    expect(await notifyDraftReady(db, { calendarId: manual, draftId, handedOff: false }, deps)).toEqual({ sent: 0, reason: "not_auto_planned" });
    expect(await notifyDraftReady(db, { calendarId: auto, draftId, handedOff: false }, { ...deps, mailReady: async () => false })).toEqual({ sent: 0, reason: "mail_not_configured" });
    expect(sent).toEqual([]);

    expect(await notifyDraftReady(db, { calendarId: auto, draftId, handedOff: false }, deps)).toEqual({ sent: 1 });
    expect(sent.map((m) => m.to)).toEqual(["owner@example.com"]); // admins only, not authors
    expect(sent[0]!.subject).toBe(`Draft ready for review: Kong gateway on minikube (scheduled ${addDays(today, 1)})`);
    expect(sent[0]!.text).toContain(`Review it: https://jithendar.com/admin/review/${draftId}`);
    expect(sent[0]!.text).toContain("Auto-scheduled on 2026-11-14");

    sent.length = 0;
    await save({ notify: { enabled: true, recipients: ["me@example.com", "editor@example.com"] } });
    expect(await notifyDraftReady(db, { calendarId: auto, draftId, handedOff: false }, deps)).toEqual({ sent: 2 });
    expect(sent.map((m) => m.to)).toEqual(["me@example.com", "editor@example.com"]);

    sent.length = 0;
    await save({ notify: { enabled: false, recipients: [] } });
    expect(await notifyDraftReady(db, { calendarId: auto, draftId, handedOff: false }, deps)).toEqual({ sent: 0, reason: "notifications_off" });
    expect(sent).toEqual([]);
  });
});
