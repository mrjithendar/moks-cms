"use server";

import { headers } from "next/headers";
import { clientInfo } from "@/lib/client-ip";
import { PostError } from "@/lib/posts";
import { callQuote, confirmCallPayment, createCallOrder, type CallOrder, type CallQuote } from "@/lib/razorpay";
import { getSessionUser } from "@/lib/session";

/** Paid calls on /hire-me (lib/razorpay.ts). The page stays cached; the visitor's currency is decided here, per request. */

type Result<T> = { ok: true; data: T } | { ok: false; error: string; issues?: string[] };

/**
 * The visitor's country and address from Cloudflare (CF-IPCountry, CF-Connecting-IP), used only when the request
 * really came through Cloudflare (lib/client-ip.ts): a request sent straight to the origin cannot choose its country,
 * and prices in USD.
 */
async function requestContext() {
  const { country, ip } = clientInfo(await headers());
  return { country, ip };
}

async function guard<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (error) {
    if (error instanceof PostError) return { ok: false, error: error.message, issues: error.issues };
    const { currentRequestId, reportError, withReference } = await import("@/lib/http-errors");
    const ref = reportError("paid call failed", error, { requestId: await currentRequestId() });
    return { ok: false, error: withReference("Something went wrong. Please try again later.", ref) };
  }
}

export async function paidCallQuoteAction(): Promise<Result<CallQuote>> {
  return guard(async () => callQuote((await requestContext()).country));
}

export type CallOrderFields = { name: string; email: string; minutes: number; topic: string };

export async function createCallOrderAction(data: CallOrderFields, token: string | null): Promise<Result<CallOrder>> {
  return guard(async () => {
    const ctx = await requestContext();
    return createCallOrder(data, { ...ctx, turnstileToken: token, signedIn: !!(await getSessionUser()) });
  });
}

export async function confirmCallPaymentAction(data: { orderId: string; paymentId: string; signature: string }): Promise<Result<{ bookingUrl: string; minutes: number }>> {
  return guard(() => confirmCallPayment(data));
}
