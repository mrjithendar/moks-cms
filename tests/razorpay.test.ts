import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bookingLinkAfterPayment, callAmountMinor, callDurations, moneyLabel, paidCallOpen, payCurrencyFor, type HireMe } from "@/lib/hire-me";
import { defaultConfig, validateConfig, type SiteConfig } from "@/lib/site-config/schema";
import { freshDb } from "./db-helpers";

vi.mock("server-only", () => ({}));
const mails: { to: string; subject: string; body: string }[] = [];
vi.mock("@/lib/mail", () => ({ sendMail: async (to: string, subject: string, body: string) => void mails.push({ to, subject, body }) }));
vi.mock("@/lib/turnstile", () => ({ verifyTurnstile: async (token: string | null) => token === "ok" }));
vi.mock("@/lib/rate-limit", () => ({ hit: async () => true }));
let env: Record<string, string | undefined> = {};
vi.mock("@/lib/runtime-settings", () => ({ effectiveEnv: async () => env }));
let published: SiteConfig = defaultConfig();
vi.mock("@/lib/site-config/store", () => ({ getPublishedConfig: async () => ({ config: published, version: 1, updatedAt: null, fallbacks: [] }) }));

const { checkoutSignatureValid, confirmCallPayment, createCallOrder, handleRazorpayWebhook, listPayments, webhookSignatureValid } = await import("@/lib/razorpay");
const { getDb, schema } = await import("@/db");

const KEY_SECRET = "testkeysecret1234567890";
const WEBHOOK_SECRET = "webhook-secret-123456";
const hmac = (secret: string, data: string) => createHmac("sha256", secret).update(data).digest("hex");

function withPaidCalls(patch: (h: HireMe) => void = () => {}): SiteConfig {
  const c = defaultConfig();
  Object.assign(c.hireMe.paidCall, { enabled: true, ratePerMinuteInr: 50, ratePerMinuteUsd: 1.5, minMinutes: 15, maxMinutes: 60, stepMinutes: 15, bookingUrl: "https://cal.com/me/paid" });
  patch(c.hireMe);
  return c;
}

describe("paid call pricing", () => {
  const pc = withPaidCalls().hireMe.paidCall;

  it("India pays in INR; every other or unknown country pays in USD", () => {
    expect(payCurrencyFor("IN")).toBe("INR");
    expect(payCurrencyFor("in")).toBe("INR");
    for (const c of ["US", "SG", "GB", "XX", "T1", "", null, undefined]) expect(payCurrencyFor(c)).toBe("USD");
  });

  it("offers min..max in steps, and prices minutes × the rate in the smallest unit", () => {
    expect(callDurations(pc)).toEqual([15, 30, 45, 60]);
    expect(callAmountMinor(pc, "INR", 30)).toBe(150_000); // ₹50 × 30 = ₹1,500
    expect(callAmountMinor(pc, "USD", 30)).toBe(4_500); // $1.50 × 30 = $45
    expect(callAmountMinor(pc, "USD", 20)).toBeNull(); // not a step
    expect(callAmountMinor(pc, "USD", 75)).toBeNull(); // above max
    expect(callAmountMinor(pc, "USD", 30.5)).toBeNull();
  });

  it("formats money in each currency", () => {
    expect(moneyLabel(150_000, "INR")).toBe("₹1,500");
    expect(moneyLabel(4_500, "USD")).toBe("$45");
    expect(moneyLabel(250, "USD")).toBe("$2.50");
  });

  it("the defaults keep paid calls off and valid; switching on needs both rates and a booking link", () => {
    const d = defaultConfig();
    expect(paidCallOpen(d.hireMe)).toBe(false);
    expect(validateConfig(d)).toMatchObject({ ok: true });
    expect(validateConfig(withPaidCalls())).toMatchObject({ ok: true });
    expect(validateConfig(withPaidCalls((h) => (h.paidCall.ratePerMinuteUsd = 0)))).toMatchObject({ ok: false });
    expect(validateConfig(withPaidCalls((h) => (h.paidCall.bookingUrl = "")))).toMatchObject({ ok: false });
    expect(validateConfig(withPaidCalls((h) => (h.paidCall.ratePerMinuteInr = 1.234)))).toMatchObject({ ok: false });
    expect(validateConfig(withPaidCalls((h) => (h.paidCall.minMinutes = 90)))).toMatchObject({ ok: false });
    expect(paidCallOpen(withPaidCalls((h) => (h.availability = "unavailable")).hireMe)).toBe(false);
  });

  it("fills the paid length and the payer's details into the booking link", () => {
    const u = new URL(bookingLinkAfterPayment("https://cal.com/me/paid", { minutes: 45, name: "Ada L", email: "ada@example.test", paymentId: "pay_ABC123" }));
    expect(u.searchParams.get("duration")).toBe("45");
    expect(u.searchParams.get("email")).toBe("ada@example.test");
    expect(u.searchParams.get("metadata[razorpayPaymentId]")).toBe("pay_ABC123");
  });
});

describe("signatures", () => {
  it("Checkout: HMAC of order_id|payment_id with the key secret", () => {
    const sig = hmac(KEY_SECRET, "order_A1B2C3|pay_X1Y2Z3");
    expect(checkoutSignatureValid("order_A1B2C3", "pay_X1Y2Z3", sig, KEY_SECRET)).toBe(true);
    expect(checkoutSignatureValid("order_A1B2C3", "pay_OTHER1", sig, KEY_SECRET)).toBe(false);
    expect(checkoutSignatureValid("order_A1B2C3", "pay_X1Y2Z3", sig, "")).toBe(false);
    expect(checkoutSignatureValid("order_A1B2C3", "pay_X1Y2Z3", "nothex", KEY_SECRET)).toBe(false);
  });

  it("Webhook: HMAC of the raw body with the webhook secret", () => {
    const body = '{"event":"payment.captured"}';
    expect(webhookSignatureValid(body, hmac(WEBHOOK_SECRET, body), WEBHOOK_SECRET)).toBe(true);
    expect(webhookSignatureValid(body + " ", hmac(WEBHOOK_SECRET, body), WEBHOOK_SECRET)).toBe(false);
    expect(webhookSignatureValid(body, hmac(WEBHOOK_SECRET, body), "")).toBe(false);
  });
});

describe("order → payment → webhook", () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ url, body });
    return new Response(JSON.stringify({ id: `order_TEST${calls.length}AB`, amount: body.amount, currency: body.currency, status: "created" }), { status: 200 });
  }) as unknown as typeof fetch;
  const input = { name: "Ada Lovelace", email: "ada@example.test", minutes: 30, topic: "EKS costs" };
  const ctx = (country: string | null) => ({ country, ip: "203.0.113.5", turnstileToken: "ok", signedIn: false });

  beforeEach(async () => {
    await freshDb();
    calls.length = 0;
    mails.length = 0;
    env = { RAZORPAY_KEY_ID: "rzp_test_ABCDEFGHIJ1234", RAZORPAY_KEY_SECRET: KEY_SECRET, RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET };
    published = withPaidCalls();
    const db = await getDb();
    await db.insert(schema.user).values({ id: "admin-1", name: "Admin", email: "admin@example.test", emailVerified: true, role: "admin" });
  });

  it("charges INR from India and USD elsewhere, with the amount set on the server", async () => {
    const inr = await createCallOrder(input, ctx("IN"), fakeFetch);
    const usd = await createCallOrder({ ...input, email: "bob@example.test" }, ctx("US"), fakeFetch);
    expect(inr).toMatchObject({ currency: "INR", amount: 150_000, minutes: 30 });
    expect(usd).toMatchObject({ currency: "USD", amount: 4_500 });
    expect(calls[0]).toMatchObject({ url: "https://api.razorpay.com/v1/orders", body: { amount: 150_000, currency: "INR" } });
    expect((await listPayments("created")).map((p) => p.currency).sort()).toEqual(["INR", "USD"]);
  });

  it("refuses lengths not on offer, missing verification, and a switched-off or unconfigured page", async () => {
    await expect(createCallOrder({ ...input, minutes: 20 }, ctx("US"), fakeFetch)).rejects.toThrow(/call lengths/);
    await expect(createCallOrder(input, { ...ctx("US"), turnstileToken: null }, fakeFetch)).rejects.toThrow(/verification/);
    env = {};
    await expect(createCallOrder(input, ctx("US"), fakeFetch)).rejects.toThrow(/not configured/);
    published = defaultConfig();
    await expect(createCallOrder(input, ctx("US"), fakeFetch)).rejects.toThrow(/not available/);
    expect(calls).toHaveLength(0);
  });

  it("a verified Checkout response marks the order paid once and returns the booking link", async () => {
    const order = await createCallOrder(input, ctx("US"), fakeFetch);
    const signature = hmac(KEY_SECRET, `${order.orderId}|pay_TESTPAY001`);
    await expect(confirmCallPayment({ orderId: order.orderId, paymentId: "pay_TESTPAY001", signature: "0".repeat(64) })).rejects.toThrow(/could not be verified/);
    const done = await confirmCallPayment({ orderId: order.orderId, paymentId: "pay_TESTPAY001", signature });
    expect(new URL(done.bookingUrl).searchParams.get("duration")).toBe("30");
    await confirmCallPayment({ orderId: order.orderId, paymentId: "pay_TESTPAY001", signature }); // repeat: no second email
    const [p] = await listPayments("paid");
    expect(p).toMatchObject({ status: "paid", paymentId: "pay_TESTPAY001", amount: 4_500 });
    expect(mails).toHaveLength(1);
    expect(mails[0]!.subject).toContain("$45");
  });

  it("webhook: records captured payments that match the order, failures, and refuses forgeries", async () => {
    const order = await createCallOrder(input, ctx("IN"), fakeFetch);
    const delivery = (event: string, entity: Record<string, unknown>) => JSON.stringify({ event, payload: { payment: { entity: { order_id: order.orderId, ...entity } } } });

    const forged = delivery("payment.captured", { id: "pay_WH0001", amount: 150_000, currency: "INR" });
    expect((await handleRazorpayWebhook(forged, hmac("attacker-secret-xx", forged), WEBHOOK_SECRET)).status).toBe(401);
    expect((await handleRazorpayWebhook(forged, hmac(WEBHOOK_SECRET, forged), undefined)).status).toBe(503);

    const failed = delivery("payment.failed", { id: "pay_WH0001", amount: 150_000, currency: "INR", error_description: "Card declined" });
    await handleRazorpayWebhook(failed, hmac(WEBHOOK_SECRET, failed), WEBHOOK_SECRET);
    expect((await listPayments("failed"))[0]).toMatchObject({ failureReason: "Card declined" });

    const wrongAmount = delivery("payment.captured", { id: "pay_WH0002", amount: 100, currency: "INR" });
    await handleRazorpayWebhook(wrongAmount, hmac(WEBHOOK_SECRET, wrongAmount), WEBHOOK_SECRET);
    expect(await listPayments("paid")).toHaveLength(0);

    const captured = delivery("payment.captured", { id: "pay_WH0002", amount: 150_000, currency: "INR" });
    expect(await handleRazorpayWebhook(captured, hmac(WEBHOOK_SECRET, captured), WEBHOOK_SECRET)).toEqual({ status: 200, body: "OK." });
    expect((await listPayments("paid"))[0]).toMatchObject({ paymentId: "pay_WH0002", currency: "INR" });

    // A later failure event cannot undo a payment.
    await handleRazorpayWebhook(failed, hmac(WEBHOOK_SECRET, failed), WEBHOOK_SECRET);
    expect(await listPayments("paid")).toHaveLength(1);
  });
});
