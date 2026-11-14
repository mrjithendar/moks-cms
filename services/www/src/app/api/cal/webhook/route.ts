import { handleCalWebhook } from "@/lib/calcom";
import { readBodyTextOrNull } from "@/lib/read-body";
import { effectiveEnv } from "@/lib/runtime-settings";

// Called by Cal.com (server to server) for booking events; never cached.
export const dynamic = "force-dynamic";

const PLAIN = { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" };

/** POST /api/cal/webhook: Cal.com booking events, verified with the secret in Advanced settings → Cal.com bookings. */
export async function POST(req: Request) {
  // Unauthenticated until the signature is checked: stop reading at the limit, with or without a Content-Length.
  const raw = await readBodyTextOrNull(req, 256 * 1024);
  if (raw === null) return new Response("Too large.", { status: 413, headers: PLAIN });
  const { CAL_WEBHOOK_SECRET } = await effectiveEnv();
  const r = await handleCalWebhook(raw, req.headers.get("x-cal-signature-256"), CAL_WEBHOOK_SECRET);
  return new Response(r.body, { status: r.status, headers: PLAIN });
}
