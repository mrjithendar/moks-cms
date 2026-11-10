import { z } from "zod";
import { hit } from "@/lib/rate-limit";
import { ASK_LIMITS, ipHash } from "@/lib/seo-agent/ask";
import { AgentError, askStream } from "@/lib/seo-agent/client";
import { askEnabled } from "@/lib/seo-agent/config";

export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex", "X-Content-Type-Options": "nosniff" };
const body = z.object({ question: z.string().trim().min(1).max(ASK_LIMITS.maxQuestion) });

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

const fail = (status: number, error: string, extra: Record<string, string> = {}) => Response.json({ error }, { status, headers: { ...HEADERS, ...extra } });

/**
 * POST /api/ask — public "Ask the Blog". Off unless ASK_BLOG_ENABLED=true. Same-origin JSON only; per-IP and global
 * rate limits (Postgres-backed limiter shared by both replicas) before anything reaches the agent; the agent enforces
 * the daily cost cap, guards and caching. Streams server-sent events through unchanged.
 */
export async function POST(req: Request): Promise<Response> {
  if (!askEnabled()) return fail(404, "Not found.");
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  try {
    if (!origin || new URL(origin).host !== host) return fail(403, "Cross-site request refused.");
  } catch {
    return fail(403, "Cross-site request refused.");
  }
  if (!(req.headers.get("content-type") ?? "").includes("application/json")) return fail(415, "Send JSON.");
  const text = await req.text();
  if (text.length > 4000) return fail(413, "Question too long.");
  let parsed;
  try {
    parsed = body.safeParse(JSON.parse(text));
  } catch {
    return fail(400, "Invalid JSON.");
  }
  if (!parsed.success) return fail(400, `Ask a question of up to ${ASK_LIMITS.maxQuestion} characters.`);
  const ip = clientAddress(req.headers) ?? "unknown";
  const okMinute = await hit(`ask:ip:${ip}:m`, ASK_LIMITS.perMinute, 60);
  const okDay = okMinute && (await hit(`ask:ip:${ip}:d`, ASK_LIMITS.perDay, 86_400));
  const okGlobal = okDay && (await hit("ask:global:m", 120, 60));
  if (!okMinute || !okDay || !okGlobal) return fail(429, "Too many questions. Please try again in a little while.", { "Retry-After": okMinute ? "3600" : "60" });
  try {
    const upstream = await askStream(parsed.data.question, ipHash(ip));
    return new Response(upstream.body, { status: 200, headers: { ...HEADERS, "Content-Type": "text/event-stream; charset=utf-8", "X-Accel-Buffering": "no" } });
  } catch (e) {
    return fail(e instanceof AgentError && e.status < 500 ? 400 : 503, "The assistant is unavailable right now. Please use search instead.");
  }
}
