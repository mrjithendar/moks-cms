import { sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { hit } from "@/lib/rate-limit";
import { askState } from "@/lib/seo-agent/ask-settings";
import { clientAddress } from "../route";

export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex", "X-Content-Type-Options": "nosniff" };
const body = z.object({ token: z.string().regex(/^[0-9a-f]{32}$/), helpful: z.boolean() });

/**
 * POST /api/ask/feedback — Helpful / Not helpful on one answer (Admin → Ask the Blog → "Helpful / Not helpful").
 * The seo-agent hands the widget a random token with each answer it logs; the rating is matched on that token only,
 * so it cannot be aimed at someone else's row, and it stores neither the account nor the IP address. A reader can
 * change their mind for a day. The answer is always 204 for a well-formed request, so the endpoint does not reveal
 * which tokens exist.
 */
export async function POST(req: Request): Promise<Response> {
  const { on, settings } = await askState();
  if (!on || !settings.conversation.feedback) return Response.json({ error: "Not found." }, { status: 404, headers: HEADERS });
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  try {
    if (!origin || new URL(origin).host !== host) return Response.json({ error: "Cross-site request refused." }, { status: 403, headers: HEADERS });
  } catch {
    return Response.json({ error: "Cross-site request refused." }, { status: 403, headers: HEADERS });
  }
  const text = await req.text();
  if (text.length > 200) return Response.json({ error: "Too large." }, { status: 413, headers: HEADERS });
  let parsed;
  try {
    parsed = body.safeParse(JSON.parse(text));
  } catch {
    return Response.json({ error: "Invalid JSON." }, { status: 400, headers: HEADERS });
  }
  if (!parsed.success) return Response.json({ error: "Invalid feedback." }, { status: 400, headers: HEADERS });
  const ip = clientAddress(req.headers) ?? "unknown";
  if (!(await hit(`ask-feedback:ip:${ip}:m`, 30, 60))) return Response.json({ error: "Too many requests." }, { status: 429, headers: { ...HEADERS, "Retry-After": "60" } });
  const db = await getDb();
  await db
    .execute(
      sql`update seo_ask_log set feedback = ${parsed.data.helpful ? 1 : -1}, feedback_at = now() where feedback_token = ${parsed.data.token} and at >= now() - interval '1 day'`,
    )
    .catch(() => undefined); // not migrated yet (0029): nothing to record, and nothing for the reader to fix
  return new Response(null, { status: 204, headers: HEADERS });
}
