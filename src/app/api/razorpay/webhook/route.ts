import { handleRazorpayWebhook, MAX_WEBHOOK_BYTES } from "@/lib/razorpay";
import { readBodyTextOrNull } from "@/lib/read-body";
import { effectiveEnv } from "@/lib/runtime-settings";

// Called by Razorpay (server to server) for payment events; never cached.
export const dynamic = "force-dynamic";

const PLAIN = { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" };

/** POST /api/razorpay/webhook: payment events, verified with the secret in Advanced settings → Razorpay payments. */
export async function POST(req: Request) {
  // Unauthenticated until the signature is checked: stop reading at the limit, with or without a Content-Length.
  const raw = await readBodyTextOrNull(req, MAX_WEBHOOK_BYTES);
  if (raw === null) return new Response("Too large.", { status: 413, headers: PLAIN });
  const { RAZORPAY_WEBHOOK_SECRET } = await effectiveEnv();
  const r = await handleRazorpayWebhook(raw, req.headers.get("x-razorpay-signature"), RAZORPAY_WEBHOOK_SECRET);
  return new Response(r.body, { status: r.status, headers: PLAIN });
}
