import { createHmac, timingSafeEqual } from "node:crypto";
import { asc, desc, eq, gte, lt } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { audit } from "./audit";
import { log } from "./log";
import type { Actor } from "./posts";
import { PostError } from "./posts";

/**
 * Cal.com integration for Hire me (/hire-me).
 *
 * - Scheduling: booking links to cal.com (or a configured self-hosted Cal.com) open Cal.com's own pop-up scheduler on
 *   the page (components/hire/BookingLink.tsx); calEmbedTarget() decides which links qualify.
 * - Bookings: Cal.com calls POST /api/cal/webhook for each booking event; the body is verified with the shared secret
 *   (HMAC-SHA256, header X-Cal-Signature-256) and stored in cal_booking, shown in Admin → Bookings.
 */

const CAL_HOSTS = new Set(["cal.com", "www.cal.com", "app.cal.com"]);
/** Cal.com's hosted app, where the embed script and scheduler live. */
export const CAL_CLOUD_ORIGIN = "https://app.cal.com";

/** "username/event" path of a booking link: one or two plain path segments, no query tricks. */
const CAL_LINK = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,99}(\/[A-Za-z0-9][A-Za-z0-9._~-]{0,99}){0,2}$/;

/**
 * Whether a booking link can open in the pop-up, and how: Cal.com's origin (where embed.js and the scheduler are
 * served) and the calLink ("username/event"). Other links (Calendly, a form…) return null and open in a new tab.
 */
export function calEmbedTarget(url: string, selfHostedOrigin = ""): { origin: string; calLink: string } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password) return null;
  let origin: string | null = null;
  if (CAL_HOSTS.has(u.hostname)) origin = CAL_CLOUD_ORIGIN;
  else if (selfHostedOrigin) {
    try {
      const s = new URL(selfHostedOrigin);
      if (s.protocol === "https:" && s.host === u.host) origin = s.origin;
    } catch {
      /* not a URL: no self-hosted Cal.com */
    }
  }
  const calLink = u.pathname.replace(/^\/+|\/+$/g, "");
  return origin && CAL_LINK.test(calLink) ? { origin, calLink } : null;
}

// --- Webhook --------------------------------------------------------------------------------------------------------

export const MAX_WEBHOOK_BYTES = 256 * 1024;

/** Cal.com signs the raw body: hex HMAC-SHA256 with the webhook's secret, in X-Cal-Signature-256. */
export function signatureValid(rawBody: string, signature: string | null, secret: string): boolean {
  if (!signature || !secret) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const given = signature.trim().toLowerCase().replace(/^sha256=/, "");
  if (!/^[0-9a-f]{64}$/.test(given)) return false;
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(given, "hex"));
}

const STATUS: Record<string, string> = {
  BOOKING_CREATED: "booked",
  BOOKING_REQUESTED: "requested",
  BOOKING_RESCHEDULED: "rescheduled",
  BOOKING_CANCELLED: "cancelled",
  BOOKING_REJECTED: "rejected",
};

type CalPayload = {
  uid?: unknown;
  title?: unknown;
  type?: unknown;
  eventTypeSlug?: unknown;
  startTime?: unknown;
  endTime?: unknown;
  attendees?: { name?: unknown; email?: unknown; timeZone?: unknown }[];
  location?: unknown;
  additionalNotes?: unknown;
  responses?: { notes?: { value?: unknown } };
  cancellationReason?: unknown;
  rescheduleUid?: unknown;
  fromReschedule?: unknown;
};

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const time = (v: unknown): Date | null => {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

export type WebhookResult = { status: number; body: string };

/**
 * Handle one webhook delivery. Unknown or test events (e.g. PING) are acknowledged and ignored; a booking event
 * creates or updates the row for its uid. A rescheduled booking gets a new uid in Cal.com: the new row records the
 * old uid, and the old row is marked rescheduled.
 */
export async function handleCalWebhook(rawBody: string, signature: string | null, secret: string | undefined): Promise<WebhookResult> {
  if (!secret) return { status: 503, body: "Cal.com webhook secret is not configured." };
  if (rawBody.length > MAX_WEBHOOK_BYTES) return { status: 413, body: "Too large." };
  if (!signatureValid(rawBody, signature, secret)) {
    log.warn("cal.com webhook refused: bad signature", { event: "cal_webhook_refused" });
    return { status: 401, body: "Invalid signature." };
  }
  let event: { triggerEvent?: unknown; payload?: CalPayload };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: "Invalid JSON." };
  }
  const trigger = typeof event.triggerEvent === "string" ? event.triggerEvent : "";
  const status = STATUS[trigger];
  const p = event.payload ?? {};
  const uid = str(p.uid, 200);
  if (!status || !uid) return { status: 200, body: "Ignored." };

  const attendee = Array.isArray(p.attendees) ? p.attendees[0] : undefined;
  const previous = str(p.rescheduleUid, 200) ?? (trigger === "BOOKING_RESCHEDULED" && typeof p.fromReschedule === "string" ? str(p.fromReschedule, 200) : null);
  const row = {
    uid,
    status: trigger === "BOOKING_RESCHEDULED" ? "booked" : status,
    title: str(p.title, 300) ?? "",
    eventType: str(p.eventTypeSlug, 120) ?? str(p.type, 120),
    startTime: time(p.startTime),
    endTime: time(p.endTime),
    attendeeName: str(attendee?.name, 200),
    attendeeEmail: str(attendee?.email, 254),
    attendeeTimeZone: str(attendee?.timeZone, 80),
    location: str(p.location, 500),
    notes: str(p.additionalNotes, 4000) ?? str(p.responses?.notes?.value, 4000),
    cancellationReason: str(p.cancellationReason, 1000),
    rescheduledFrom: trigger === "BOOKING_RESCHEDULED" ? previous : null,
    updatedAt: new Date(),
  };
  const db = await getDb();
  if (trigger === "BOOKING_CANCELLED" || trigger === "BOOKING_REJECTED") {
    // Keep what was known about the booking; record the new status and reason.
    const updated = await db
      .update(schema.calBooking)
      .set({ status, cancellationReason: row.cancellationReason, updatedAt: row.updatedAt })
      .where(eq(schema.calBooking.uid, uid))
      .returning({ id: schema.calBooking.id });
    if (updated.length === 0) await db.insert(schema.calBooking).values(row);
  } else {
    await db.insert(schema.calBooking).values(row).onConflictDoUpdate({ target: schema.calBooking.uid, set: { ...row, uid: undefined } });
    if (row.rescheduledFrom && row.rescheduledFrom !== uid) {
      await db.update(schema.calBooking).set({ status: "rescheduled", updatedAt: row.updatedAt }).where(eq(schema.calBooking.uid, row.rescheduledFrom));
    }
  }
  log.info("cal.com booking event stored", { event: "cal_booking", trigger });
  return { status: 200, body: "OK." };
}

// --- Admin --------------------------------------------------------------------------------------------------------

export type BookingFilter = "upcoming" | "past" | "cancelled" | "all";

export async function listBookings(filter: BookingFilter = "upcoming", now = new Date()) {
  const db = await getDb();
  const b = schema.calBooking;
  if (filter === "upcoming") return db.select().from(b).where(gte(b.startTime, now)).orderBy(asc(b.startTime)).limit(300);
  if (filter === "past") return db.select().from(b).where(lt(b.startTime, now)).orderBy(desc(b.startTime)).limit(300);
  if (filter === "cancelled") return db.select().from(b).where(eq(b.status, "cancelled")).orderBy(desc(b.updatedAt)).limit(300);
  return db.select().from(b).orderBy(desc(b.startTime)).limit(300);
}

/** Removes the copy here (e.g. on a privacy request); the booking in Cal.com is not touched. */
export async function deleteBooking(actor: Actor, id: string) {
  if (actor.role !== "admin") throw new PostError("Only admins can manage bookings.", 403);
  const db = await getDb();
  await db.delete(schema.calBooking).where(eq(schema.calBooking.id, id));
  await audit(actor, "booking.delete", id);
}
