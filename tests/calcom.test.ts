import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { calEmbedTarget, handleCalWebhook, listBookings, signatureValid } from "@/lib/calcom";
import { freshDb } from "./db-helpers";

vi.mock("server-only", () => ({}));

const SECRET = "test-webhook-secret-123456";
const sign = (body: string, secret = SECRET) => createHmac("sha256", secret).update(body).digest("hex");
const event = (triggerEvent: string, payload: Record<string, unknown>) => JSON.stringify({ triggerEvent, createdAt: "2026-11-11T10:00:00Z", payload });
const booking = {
  uid: "uid-1",
  title: "Consulting call between Jithendar and Ada",
  type: "consulting",
  startTime: "2026-12-01T03:00:00Z",
  endTime: "2026-12-01T03:30:00Z",
  attendees: [{ name: "Ada Lovelace", email: "ada@example.test", timeZone: "Europe/London" }],
  location: "https://meet.example.test/abc",
  responses: { notes: { value: "EKS cost review" } },
};

describe("calEmbedTarget: which links open in the pop-up", () => {
  it.each([
    ["https://cal.com/jithendar/consulting", { origin: "https://app.cal.com", calLink: "jithendar/consulting" }],
    ["https://cal.com/jithendar", { origin: "https://app.cal.com", calLink: "jithendar" }],
    ["https://app.cal.com/team/acme/intro/", { origin: "https://app.cal.com", calLink: "team/acme/intro" }],
    ["https://calendly.com/jithendar/30min", null],
    ["http://cal.com/jithendar/consulting", null],
    ["https://cal.com/", null],
    ["https://cal.com/a/b/c/d", null],
    ["https://cal.com/jithendar/x%2F..%2Fy", null],
    ["not a url", null],
  ])("%s → %j", (url, expected) => expect(calEmbedTarget(url)).toEqual(expected));

  it("a self-hosted Cal.com only when its address is configured, and only on that host", () => {
    expect(calEmbedTarget("https://cal.example.com/me/intro")).toBeNull();
    expect(calEmbedTarget("https://cal.example.com/me/intro", "https://cal.example.com")).toEqual({ origin: "https://cal.example.com", calLink: "me/intro" });
    expect(calEmbedTarget("https://evil.example.net/me/intro", "https://cal.example.com")).toBeNull();
  });
});

describe("webhook signature (X-Cal-Signature-256)", () => {
  it("accepts the hex HMAC-SHA256 of the raw body and nothing else", () => {
    const body = event("PING", {});
    expect(signatureValid(body, sign(body), SECRET)).toBe(true);
    expect(signatureValid(body, sign(body).toUpperCase(), SECRET)).toBe(true);
    expect(signatureValid(body, sign(body, "other-secret-xxxxxxxx"), SECRET)).toBe(false);
    expect(signatureValid(body + " ", sign(body), SECRET)).toBe(false);
    expect(signatureValid(body, "abc", SECRET)).toBe(false);
    expect(signatureValid(body, null, SECRET)).toBe(false);
    expect(signatureValid(body, sign(body), "")).toBe(false);
  });
});

describe("handleCalWebhook", () => {
  beforeEach(async () => {
    await freshDb();
  });
  const post = (body: string, sig: string | null = sign(body), secret: string | undefined = SECRET) => handleCalWebhook(body, sig, secret);

  it("refuses everything until a secret is configured, and unsigned or forged deliveries", async () => {
    const body = event("BOOKING_CREATED", booking);
    expect((await post(body, sign(body), "")).status).toBe(503);
    expect((await post(body, null)).status).toBe(401);
    expect((await post(body, sign(body, "attacker-secret-xxxxx"))).status).toBe(401);
    expect(await listBookings("all")).toHaveLength(0);
  });

  it("stores a new booking with its attendee, time, event type and notes", async () => {
    expect(await post(event("BOOKING_CREATED", booking))).toEqual({ status: 200, body: "OK." });
    const [b] = await listBookings("all");
    expect(b).toMatchObject({ uid: "uid-1", status: "booked", eventType: "consulting", attendeeName: "Ada Lovelace", attendeeEmail: "ada@example.test", attendeeTimeZone: "Europe/London", notes: "EKS cost review" });
    expect(b!.startTime?.toISOString()).toBe("2026-12-01T03:00:00.000Z");
  });

  it("is idempotent: a repeated delivery updates the same row", async () => {
    await post(event("BOOKING_CREATED", booking));
    await post(event("BOOKING_CREATED", { ...booking, title: "Renamed" }));
    const rows = await listBookings("all");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe("Renamed");
  });

  it("a reschedule creates the new booking and marks the old one rescheduled", async () => {
    await post(event("BOOKING_CREATED", booking));
    await post(event("BOOKING_RESCHEDULED", { ...booking, uid: "uid-2", rescheduleUid: "uid-1", startTime: "2026-12-02T03:00:00Z", endTime: "2026-12-02T03:30:00Z" }));
    const rows = await listBookings("all");
    expect(rows.find((r) => r.uid === "uid-2")).toMatchObject({ status: "booked", rescheduledFrom: "uid-1" });
    expect(rows.find((r) => r.uid === "uid-1")).toMatchObject({ status: "rescheduled" });
  });

  it("a cancellation keeps the booking and records the status and reason", async () => {
    await post(event("BOOKING_CREATED", booking));
    await post(event("BOOKING_CANCELLED", { uid: "uid-1", cancellationReason: "Moved to next quarter" }));
    const [b] = await listBookings("cancelled");
    expect(b).toMatchObject({ uid: "uid-1", status: "cancelled", cancellationReason: "Moved to next quarter", attendeeName: "Ada Lovelace" });
  });

  it("acknowledges and ignores test pings and other events; rejects bad JSON and oversized bodies", async () => {
    expect(await post(event("PING", {}))).toEqual({ status: 200, body: "Ignored." });
    expect(await post(event("MEETING_ENDED", booking))).toEqual({ status: 200, body: "Ignored." });
    expect((await post("{not json")).status).toBe(400);
    const big = "x".repeat(300 * 1024);
    expect((await post(big)).status).toBe(413);
    expect(await listBookings("all")).toHaveLength(0);
  });

  it("upcoming and past split on the meeting time", async () => {
    await post(event("BOOKING_CREATED", booking));
    await post(event("BOOKING_CREATED", { ...booking, uid: "old", startTime: "2026-01-01T03:00:00Z", endTime: "2026-01-01T03:30:00Z" }));
    const now = new Date("2026-11-11T00:00:00Z");
    expect((await listBookings("upcoming", now)).map((b) => b.uid)).toEqual(["uid-1"]);
    expect((await listBookings("past", now)).map((b) => b.uid)).toEqual(["old"]);
  });
});

describe("POST /api/cal/webhook", () => {
  beforeEach(async () => {
    await freshDb();
  });

  it("verifies with the secret from Advanced settings and stores the booking", async () => {
    vi.doMock("@/lib/runtime-settings", async (orig) => ({ ...(await orig<typeof import("@/lib/runtime-settings")>()), effectiveEnv: async () => ({ CAL_WEBHOOK_SECRET: SECRET }) }));
    const { POST } = await import("@/app/api/cal/webhook/route");
    const body = event("BOOKING_CREATED", booking);
    const res = await POST(new Request("https://jithendar.com/api/cal/webhook", { method: "POST", body, headers: { "x-cal-signature-256": sign(body), "content-type": "application/json" } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await listBookings("all")).toHaveLength(1);
    const bad = await POST(new Request("https://jithendar.com/api/cal/webhook", { method: "POST", body, headers: { "x-cal-signature-256": "0".repeat(64) } }));
    expect(bad.status).toBe(401);
    vi.doUnmock("@/lib/runtime-settings");
  });
});

describe("migration 0024", () => {
  it("creates cal_booking with a unique uid; its rollback drops it", async () => {
    const db = await freshDb();
    const tables = async () => ((await db.execute(`select table_name from information_schema.tables where table_name = 'cal_booking'`)) as unknown as { rows: unknown[] }).rows.length;
    expect(await tables()).toBe(1);
    const down = readFileSync(path.resolve(import.meta.dirname, "../src/db/rollback/0024_cal_booking.down.sql"), "utf8").split("--> statement-breakpoint").map((x) => x.trim()).filter(Boolean);
    for (const stmt of down) await db.execute(stmt);
    expect(await tables()).toBe(0);
  });
});
