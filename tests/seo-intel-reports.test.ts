import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schema, setDbForTests, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
import { freshDb } from "./db-helpers";
import { NOW } from "./helpers";
import { fakeGoogle, FIXTURE_ENV, settingsInput } from "./seo-fixtures";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const { reportPeriod, buildReport, generateReport, reportCsv, reportText } = await import("@/lib/seo-intel/reports");
const { saveSeoSettings, DEFAULT_SEO_SETTINGS } = await import("@/lib/seo-intel/settings");
const { runSeoJob } = await import("@/lib/seo-intel/jobs");

describe("report periods", () => {
  it("weekly = last full Monday–Sunday; monthly = last full month; each with the previous equal period", () => {
    // NOW = Tuesday 2026-10-27
    expect(reportPeriod("weekly", NOW)).toEqual({ start: "2026-10-19", end: "2026-10-25", prevStart: "2026-10-12", prevEnd: "2026-10-18" });
    expect(reportPeriod("monthly", NOW)).toEqual({ start: "2026-09-01", end: "2026-09-30", prevStart: "2026-08-01", prevEnd: "2026-08-31" });
    expect(reportPeriod("monthly", new Date("2026-03-05T00:00:00Z"))).toMatchObject({ start: "2026-02-01", end: "2026-02-28", prevStart: "2026-01-01" });
  });
});

describe("reports", () => {
  let db: Db;
  beforeEach(async () => {
    db = await freshDb();
    await db.insert(schema.user).values({ id: "admin", name: "Admin", email: "admin@example.com", role: "admin" });
    await saveSeoSettings(settingsInput(), "admin");
    const deps = { fetchImpl: fakeGoogle().fetch, sleep: async () => {}, env: FIXTURE_ENV, now: () => NOW };
    await runSeoJob({ type: "gsc_backfill", trigger: "backfill", start: "2026-10-05", end: "2026-10-26" }, deps);
    await runSeoJob({ type: "ga4_backfill", trigger: "backfill", start: "2026-10-05", end: "2026-10-26" }, deps);
  });
  afterEach(() => setDbForTests(undefined));

  it("summarises real synced numbers with comparisons", async () => {
    const r = await buildReport("weekly", NOW);
    expect(r.organic.gsc.current.clicks).toBe(5000 * 7 + (19 + 20 + 21 + 22 + 23 + 24 + 25));
    expect(r.organic.gsc.previous.clicks).toBe(5000 * 7 + (12 + 13 + 14 + 15 + 16 + 17 + 18));
    expect(r.organic.dataComplete).toBe(true);
    expect(r.organic.ga4.current.organicSessions).toBeGreaterThan(0);
    expect(r.bestArticles[0]!.page).toBe("https://jithendar.com/blog/argo-cd-gitops");
    const text = reportText(r, "https://jithendar.com/admin/reports/x");
    expect(text).toMatch(/Search Console: \d+ clicks/);
    expect(text).not.toMatch(/forecast|guarantee/i);
  });

  it("CSV is spreadsheet-injection safe", async () => {
    const r = await buildReport("weekly", NOW);
    r.nextActions.push({ id: "x", category: "low_ctr", band: "high", problem: "p", action: "=HYPERLINK(\"http://evil\")", url: null });
    const csv = reportCsv(r);
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(csv.split("\r\n")[0]).toBe("section,key,value,previous,change");
  });

  it("sends email only when enabled AND recipients are set AND mail works; never twice", async () => {
    const send = vi.fn(async () => true);
    const mailReady = async () => true;
    // Default: disabled.
    await generateReport("weekly", "schedule", NOW, { send, mailReady });
    expect(send).not.toHaveBeenCalled();
    // Enabled without recipients: nothing.
    await saveSeoSettings(settingsInput({ reports: { ...DEFAULT_SEO_SETTINGS.reports, emailEnabled: true, recipients: [] } }), "admin");
    await generateReport("weekly", "schedule", NOW, { send, mailReady });
    expect(send).not.toHaveBeenCalled();
    // Recipients but the site's email service is not configured: nothing.
    await saveSeoSettings(settingsInput({ reports: { ...DEFAULT_SEO_SETTINGS.reports, emailEnabled: true, recipients: ["owner@example.com", "editor@example.com"] } }), "admin");
    await generateReport("weekly", "schedule", NOW, { send, mailReady: async () => false });
    expect(send).not.toHaveBeenCalled();
    // All set: one email per recipient, once.
    const r = await generateReport("weekly", "schedule", NOW, { send, mailReady });
    expect(r.emailed).toBe(2);
    expect(send).toHaveBeenCalledTimes(2);
    expect((send.mock.calls[0] as unknown as [string, string, string])[2]).toContain(`/admin/reports/${r.id}`);
    await generateReport("weekly", "manual", NOW, { send, mailReady });
    expect(send).toHaveBeenCalledTimes(2);
    expect(rowsOf<{ n: number }>(await db.execute(sql`select count(*)::int as n from seo_reports`))[0]!.n).toBe(1);
  });
});
