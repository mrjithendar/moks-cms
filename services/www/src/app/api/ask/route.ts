import { z } from "zod";
import { hit } from "@/lib/rate-limit";
import { ipHash } from "@/lib/seo-agent/ask";
import { askState } from "@/lib/seo-agent/ask-settings";
import { AgentError, askStream } from "@/lib/seo-agent/client";
import { getSessionUser } from "@/lib/session";

export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex", "X-Content-Type-Options": "nosniff" };

/**
 * The client address for rate limiting. Envoy (Istio ingress) sets x-envoy-external-address to the address it trusts;
 * otherwise the right-most X-Forwarded-For hop, which the gateway appended. The left-most entry is client-controlled
 * and would let anyone dodge the limit.
 */
export function clientAddress(h: Headers): string | null {
  const envoy = h.get("x-envoy-external-address")?.trim();
  if (envoy) return envoy;
  const hops = (h.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return hops.at(-1) ?? h.get("x-real-ip")?.trim() ?? null;
}

const fail = (status: number, error: string, extra: Record<string, string> = {}, code?: string) => Response.json({ error, ...(code ? { code } : {}) }, { status, headers: { ...HEADERS, ...extra } });

/**
 * GET /api/ask — what the widget needs before it opens: whether the assistant is on, who may use it, and whether this
 * browser is signed in. Pages are cached, so the widget cannot know any of this from the HTML. The session is only
 * looked up in signed-in-only mode.
 */
export async function GET(): Promise<Response> {
  const { on, settings } = await askState();
  if (!on) return Response.json({ enabled: false }, { headers: HEADERS });
  const signedIn = settings.audience === "members" ? Boolean(await getSessionUser()) : null;
  return Response.json({ enabled: true, audience: settings.audience, signedIn }, { headers: HEADERS });
}

/**
 * POST /api/ask — public "Ask the Blog". Off unless ASK_BLOG_ENABLED=true AND an admin has switched it on (Admin →
 * Automation & AI → Ask the Blog). Same-origin JSON only. In signed-in-only mode the session is checked here, on the
 * server, for every question (401 without one). Per-IP, per-account (signed-in-only mode) and global rate limits
 * (Postgres-backed limiter shared by both replicas) before anything reaches the agent; the agent enforces the daily
 * cost cap, guards and caching. Streams server-sent events through unchanged.
 */
export async function POST(req: Request): Promise<Response> {
  const { on, settings } = await askState();
  if (!on) return fail(404, "Not found.");
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  try {
    if (!origin || new URL(origin).host !== host) return fail(403, "Cross-site request refused.");
  } catch {
    return fail(403, "Cross-site request refused.");
  }
  const user = settings.audience === "members" ? await getSessionUser() : null;
  if (settings.audience === "members" && !user) return fail(401, "Sign in to ask a question.", {}, "signin");
  if (!(req.headers.get("content-type") ?? "").includes("application/json")) return fail(415, "Send JSON.");
  const { limits } = settings;
  const body = z.object({ question: z.string().trim().min(1).max(limits.maxQuestion) });
  const text = await req.text();
  if (text.length > 4000) return fail(413, "Question too long.");
  let parsed;
  try {
    parsed = body.safeParse(JSON.parse(text));
  } catch {
    return fail(400, "Invalid JSON.");
  }
  if (!parsed.success) return fail(400, `Ask a question of up to ${limits.maxQuestion} characters.`);
  const ip = clientAddress(req.headers) ?? "unknown";
  // Signed-in-only mode counts per account as well, so switching networks does not reset a reader's allowance.
  const who = user ? [`ask:ip:${ip}`, `ask:user:${user.id}`] : [`ask:ip:${ip}`];
  let okMinute = true;
  for (const k of who) okMinute = okMinute && (await hit(`${k}:m`, limits.perMinute, 60));
  let okDay = okMinute;
  for (const k of who) okDay = okDay && (await hit(`${k}:d`, limits.perDay, 86_400));
  const okGlobal = okDay && (await hit("ask:global:m", 120, 60));
  if (!okMinute || !okDay || !okGlobal) return fail(429, "Too many questions. Please try again in a little while.", { "Retry-After": okMinute ? "3600" : "60" });
  try {
    const upstream = await askStream(parsed.data.question, ipHash(ip));
    return new Response(upstream.body, { status: 200, headers: { ...HEADERS, "Content-Type": "text/event-stream; charset=utf-8", "X-Accel-Buffering": "no" } });
  } catch (e) {
    return fail(e instanceof AgentError && e.status < 500 ? 400 : 503, "The assistant is unavailable right now. Please use search instead.");
  }
}
