import { handleCalWebhook } from "@/lib/calcom";
import { effectiveEnv } from "@/lib/runtime-settings";

// Called by Cal.com (server to server) for booking events; never cached.
export const dynamic = "force-dynamic";

const PLAIN = { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" };

/** POST /api/cal/webhook: Cal.com booking events, verified with the secret in Advanced settings → Cal.com bookings. */
export async function POST(req: Request) {
  const length = Number(req.headers.get("content-length") ?? 0);
  if (length > 256 * 1024) return new Response("Too large.", { status: 413, headers: PLAIN });
  const raw = await req.text();
  const { CAL_WEBHOOK_SECRET } = await effectiveEnv();
  const r = await handleCalWebhook(raw, req.headers.get("x-cal-signature-256"), CAL_WEBHOOK_SECRET);
  return new Response(r.body, { status: r.status, headers: PLAIN });
}
