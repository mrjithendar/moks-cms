import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, desc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { site } from "@/config/site";
import { audit } from "./audit";
import { bookingLinkAfterPayment, callAmountMinor, callDurations, minorPerMinute, moneyLabel, paidCallBookingUrl, paidCallOpen, payCurrencyFor, type PayCurrency } from "./hire-me";
import { log } from "./log";
import { sendMail } from "./mail";
import type { Actor } from "./posts";
import { PostError } from "./posts";
import { hit } from "./rate-limit";
import { effectiveEnv } from "./runtime-settings";
import { getPublishedConfig } from "./site-config/store";
import { verifyTurnstile } from "./turnstile";

/**
 * Paid calls on /hire-me, through Razorpay Standard Checkout.
 *
 * 1. createCallOrder: the server fixes the price (minutes × the per-minute rate in Admin → Appearance → Hire me), in
 *    INR for visitors in India and USD for everyone else (Cloudflare's CF-IPCountry header, never the browser), creates
 *    a Razorpay Order and stores it in hire_payment.
 * 2. The browser opens Razorpay Checkout for that order (components/hire/PaidCall.tsx).
 * 3. confirmCallPayment: checks Checkout's signature (HMAC-SHA256 of "order_id|payment_id" with the key secret), marks
 *    the row paid and returns the booking link with the length and the payer's details filled in.
 * 4. POST /api/razorpay/webhook: the same outcome server to server (payment.captured / order.paid / payment.failed),
 *    so a payment is recorded even if the visitor closes the tab before step 3.
 * The keys live in Admin → Advanced settings → Razorpay payments. Invoices (lib/invoices.ts) use the same keys and the
 * same webhook, with Razorpay Payment Links instead of Checkout.
 */

const API = "https://api.razorpay.com/v1";
/** Razorpay's minimum charge is 100 in the smallest unit (₹1 / $1 is safely above every currency's floor). */
export const MIN_AMOUNT = 100;
export const MAX_WEBHOOK_BYTES = 256 * 1024;

type Env = Record<string, string | undefined>;
export function razorpayKeys(env: Env) {
  return { keyId: env.RAZORPAY_KEY_ID?.trim() || "", keySecret: env.RAZORPAY_KEY_SECRET?.trim() || "", webhookSecret: env.RAZORPAY_WEBHOOK_SECRET?.trim() || "" };
}

const hexEqual = (expected: string, given: string | null | undefined): boolean => {
  const g = given?.trim().toLowerCase() ?? "";
  if (!/^[0-9a-f]{64}$/.test(g)) return false;
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(g, "hex"));
};

/** Checkout's razorpay_signature: hex HMAC-SHA256 of "order_id|payment_id" with the key secret. */
export function checkoutSignatureValid(orderId: string, paymentId: string, signature: string | null | undefined, keySecret: string): boolean {
  if (!keySecret || !orderId || !paymentId) return false;
  return hexEqual(createHmac("sha256", keySecret).update(`${orderId}|${paymentId}`, "utf8").digest("hex"), signature);
}

/** Webhooks: X-Razorpay-Signature is the hex HMAC-SHA256 of the raw body with the webhook secret. */
export function webhookSignatureValid(rawBody: string, signature: string | null | undefined, secret: string): boolean {
  if (!secret) return false;
  return hexEqual(createHmac("sha256", secret).update(rawBody, "utf8").digest("hex"), signature);
}

/**
 * Payment Links: the address Razorpay sends the payer back to carries razorpay_signature, the hex HMAC-SHA256 of
 * "payment_link_id|payment_link_reference_id|payment_link_status|payment_id" with the key secret.
 */
export function paymentLinkSignatureValid(p: { linkId: string; referenceId: string; status: string; paymentId: string }, signature: string | null | undefined, keySecret: string): boolean {
  if (!keySecret || !p.linkId || !p.status || !p.paymentId) return false;
  return hexEqual(createHmac("sha256", keySecret).update(`${p.linkId}|${p.referenceId}|${p.status}|${p.paymentId}`, "utf8").digest("hex"), signature);
}

// --- Quote and order ------------------------------------------------------------------------------------------------

export type CallQuote =
  | { ready: false }
  | { ready: true; currency: PayCurrency; perMinute: number; durations: number[]; keyId: string };

/** What the visitor sees: their currency, the per-minute price (smallest unit) and the lengths on offer. */
export async function callQuote(country: string | null): Promise<CallQuote> {
  const [{ config }, env] = await Promise.all([getPublishedConfig(), effectiveEnv()]);
  const keys = razorpayKeys(env);
  if (!paidCallOpen(config.hireMe) || !keys.keyId || !keys.keySecret || !paidCallBookingUrl(config.hireMe)) return { ready: false };
  const currency = payCurrencyFor(country);
  return { ready: true, currency, perMinute: minorPerMinute(config.hireMe.paidCall, currency), durations: callDurations(config.hireMe.paidCall), keyId: keys.keyId };
}

export const callOrderInput = z.object({
  name: z.string().trim().min(2, "Enter your name").max(100),
  email: z.email("Enter a valid email").trim().max(200),
  minutes: z.number().int(),
  topic: z.string().trim().max(1000).optional().default(""),
});

export type CallOrder = { keyId: string; orderId: string; amount: number; currency: PayCurrency; minutes: number; name: string; email: string; description: string };

type Fetch = typeof fetch;

export async function createCallOrder(
  raw: unknown,
  ctx: { country: string | null; ip: string | null; turnstileToken: string | null; signedIn: boolean },
  fetchImpl: Fetch = fetch,
): Promise<CallOrder> {
  const [{ config }, env] = await Promise.all([getPublishedConfig(), effectiveEnv()]);
  const h = config.hireMe;
  const keys = razorpayKeys(env);
  if (!paidCallOpen(h) || !paidCallBookingUrl(h)) throw new PostError("Paid calls are not available right now.", 403);
  if (!keys.keyId || !keys.keySecret) throw new PostError("Payments are not configured yet.", 503);
  const parsed = callOrderInput.safeParse(raw);
  if (!parsed.success) throw new PostError("Please check the form.", 400, parsed.error.issues.map((i) => i.message));
  const input = parsed.data;
  const currency = payCurrencyFor(ctx.country);
  const amount = callAmountMinor(h.paidCall, currency, input.minutes);
  if (amount === null) throw new PostError("Choose one of the call lengths offered.", 400);
  if (amount < MIN_AMOUNT) throw new PostError("This call is below Razorpay's minimum charge.", 400);
  if (!ctx.signedIn && !(await verifyTurnstile(ctx.turnstileToken, ctx.ip))) throw new PostError("Please complete the human verification again.", 400);
  if (!(await hit(`pay:ip:${ctx.ip ?? "unknown"}`, 10, 3600)) || !(await hit(`pay:email:${input.email.toLowerCase()}`, 5, 3600))) {
    throw new PostError("Too many attempts. Please try again in an hour.", 429);
  }

  const res = await fetchImpl(`${API}/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Basic ${Buffer.from(`${keys.keyId}:${keys.keySecret}`).toString("base64")}` },
    body: JSON.stringify({
      amount,
      currency,
      receipt: `call-${Date.now().toString(36)}`,
      notes: { purpose: "paid call", minutes: String(input.minutes), email: input.email.slice(0, 200) },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as { id?: unknown; amount?: unknown; currency?: unknown; error?: { description?: unknown } };
  if (!res.ok || typeof body.id !== "string" || body.amount !== amount || body.currency !== currency) {
    log.error("razorpay order failed", { event: "razorpay_order_failed", status: res.status, reason: typeof body.error?.description === "string" ? body.error.description.slice(0, 200) : undefined });
    throw new PostError("The payment could not be started. Please try again later.", 502);
  }

  const db = await getDb();
  await db.insert(schema.hirePayment).values({
    orderId: body.id,
    minutes: input.minutes,
    amount,
    currency,
    country: ctx.country?.slice(0, 8) || null,
    name: input.name,
    email: input.email,
    topic: input.topic || null,
  });
  log.info("razorpay order created", { event: "razorpay_order_created", currency, minutes: input.minutes });
  return { keyId: keys.keyId, orderId: body.id, amount, currency, minutes: input.minutes, name: input.name, email: input.email, description: `${input.minutes}-minute call` };
}

// --- Outcome --------------------------------------------------------------------------------------------------------

type Row = typeof schema.hirePayment.$inferSelect;

/**
 * Mark an order paid once (Checkout response and webhook may both arrive): only the first transition emails the
 * admins. Returns the row, or null when the order is unknown.
 */
async function markPaid(orderId: string, paymentId: string): Promise<Row | null> {
  const db = await getDb();
  const now = new Date();
  const [changed] = await db
    .update(schema.hirePayment)
    .set({ status: "paid", paymentId, paidAt: now, updatedAt: now, failureReason: null })
    .where(and(eq(schema.hirePayment.orderId, orderId), ne(schema.hirePayment.status, "paid")))
    .returning();
  if (changed) {
    log.info("razorpay payment recorded", { event: "razorpay_paid", currency: changed.currency, minutes: changed.minutes });
    await notifyAdmins(changed).catch((err) => log.warn("paid call email failed", { error: String(err) }));
    return changed;
  }
  const [row] = await db.select().from(schema.hirePayment).where(eq(schema.hirePayment.orderId, orderId));
  return row ?? null;
}

async function notifyAdmins(p: Row) {
  const db = await getDb();
  const admins = await db.select({ email: schema.user.email }).from(schema.user).where(eq(schema.user.role, "admin"));
  const price = moneyLabel(p.amount, p.currency as PayCurrency);
  const text = [
    `${p.name} <${p.email}> paid ${price} for a ${p.minutes}-minute call.`,
    `Razorpay payment: ${p.paymentId}`,
    ...(p.topic ? ["", p.topic] : []),
    "",
    "They were sent to the booking page to pick a time. See Admin → Payments and Admin → Bookings.",
  ].join("\n");
  await Promise.all(admins.map((a) => sendMail(a.email, `[Paid call] ${price} · ${p.minutes} min · ${p.name}`.slice(0, 150), text)));
}

export const confirmInput = z.object({
  orderId: z.string().regex(/^order_[A-Za-z0-9]{6,40}$/),
  paymentId: z.string().regex(/^pay_[A-Za-z0-9]{6,40}$/),
  signature: z.string().max(200),
});

/** After Checkout succeeds: verify its signature, record the payment and return where to book. */
export async function confirmCallPayment(raw: unknown): Promise<{ bookingUrl: string; minutes: number }> {
  const parsed = confirmInput.safeParse(raw);
  if (!parsed.success) throw new PostError("The payment response was not valid.", 400);
  const { orderId, paymentId, signature } = parsed.data;
  const [{ config }, env] = await Promise.all([getPublishedConfig(), effectiveEnv()]);
  if (!checkoutSignatureValid(orderId, paymentId, signature, razorpayKeys(env).keySecret)) {
    log.warn("razorpay checkout signature refused", { event: "razorpay_signature_refused" });
    throw new PostError("The payment could not be verified. If you were charged, email me and I'll sort it out.", 400);
  }
  const row = await markPaid(orderId, paymentId);
  if (!row) throw new PostError("Unknown order. If you were charged, email me and I'll sort it out.", 404);
  const base = paidCallBookingUrl(config.hireMe);
  return { minutes: row.minutes, bookingUrl: base ? bookingLinkAfterPayment(base, { minutes: row.minutes, name: row.name, email: row.email, paymentId }) : "" };
}

type Entity = { id?: unknown; order_id?: unknown; amount?: unknown; currency?: unknown; error_description?: unknown };
export type WebhookResult = { status: number; body: string };

/**
 * One webhook delivery. payment.captured and order.paid mark the order paid (after checking the amount and currency
 * match what was charged for); payment.failed records the reason unless it was already paid. payment_link.* events
 * belong to invoices (lib/invoices.ts). Anything else is acknowledged and ignored. Orders and links not made by this
 * site (other Razorpay products) are ignored too.
 */
export async function handleRazorpayWebhook(rawBody: string, signature: string | null, secret: string | undefined): Promise<WebhookResult> {
  if (!secret) return { status: 503, body: "Razorpay webhook secret is not configured." };
  if (rawBody.length > MAX_WEBHOOK_BYTES) return { status: 413, body: "Too large." };
  if (!webhookSignatureValid(rawBody, signature, secret)) {
    log.warn("razorpay webhook refused: bad signature", { event: "razorpay_webhook_refused" });
    return { status: 401, body: "Invalid signature." };
  }
  let event: { event?: unknown; payload?: { payment?: { entity?: Entity }; order?: { entity?: Entity } } };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: "Invalid JSON." };
  }
  if (typeof event !== "object" || event === null) return { status: 400, body: "Invalid JSON." };
  const name = typeof event.event === "string" ? event.event : "";
  if (name.startsWith("payment_link.")) {
    // Loaded here, not at the top: lib/invoices.ts imports this file.
    const { handlePaymentLinkEvent } = await import("./invoices");
    return { status: 200, body: await handlePaymentLinkEvent(name, event.payload) };
  }
  const payment = event.payload?.payment?.entity ?? {};
  const orderId = typeof payment.order_id === "string" ? payment.order_id : typeof event.payload?.order?.entity?.id === "string" ? event.payload.order.entity.id : "";
  const paymentId = typeof payment.id === "string" ? payment.id : "";
  if (!orderId || !paymentId || !["payment.captured", "order.paid", "payment.failed"].includes(name)) return { status: 200, body: "Ignored." };

  const db = await getDb();
  const [row] = await db.select().from(schema.hirePayment).where(eq(schema.hirePayment.orderId, orderId));
  if (!row) return { status: 200, body: "Ignored." };

  if (name === "payment.failed") {
    if (row.status !== "paid") {
      const reason = typeof payment.error_description === "string" ? payment.error_description.slice(0, 500) : "Payment failed";
      await db.update(schema.hirePayment).set({ status: "failed", paymentId, failureReason: reason, updatedAt: new Date() }).where(eq(schema.hirePayment.id, row.id));
    }
    return { status: 200, body: "OK." };
  }
  if (payment.amount !== row.amount || payment.currency !== row.currency) {
    log.error("razorpay webhook amount mismatch", { event: "razorpay_amount_mismatch" });
    return { status: 200, body: "Amount mismatch; not recorded." };
  }
  await markPaid(orderId, paymentId);
  return { status: 200, body: "OK." };
}

// --- Admin ----------------------------------------------------------------------------------------------------------

export type PaymentFilter = "paid" | "failed" | "created" | "all";

export async function listPayments(filter: PaymentFilter = "paid") {
  const db = await getDb();
  const p = schema.hirePayment;
  return db
    .select()
    .from(p)
    .where(filter === "all" ? undefined : eq(p.status, filter))
    .orderBy(desc(p.createdAt))
    .limit(300);
}

/** Removes the record here (e.g. a privacy request); the payment in Razorpay is not touched or refunded. */
export async function deletePayment(actor: Actor, id: string) {
  if (actor.role !== "admin") throw new PostError("Only admins can manage payments.", 403);
  const db = await getDb();
  await db.delete(schema.hirePayment).where(eq(schema.hirePayment.id, id));
  await audit(actor, "payment.delete", id);
}

export const RAZORPAY_DASHBOARD_PAYMENT = (paymentId: string) => `https://dashboard.razorpay.com/app/payments/${encodeURIComponent(paymentId)}`;
export const MERCHANT_NAME = site.name;
