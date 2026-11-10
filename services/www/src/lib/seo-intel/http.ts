import "server-only";
import type { z } from "zod";
import { actorOf } from "../admin";
import { audit } from "../audit";
import { reportError, routeFields } from "../http-errors";
import { hit } from "../rate-limit";
import { getSessionUser, type SessionUser } from "../session";
import { isNextControlFlow } from "../trace";
import type { Actor } from "../posts";

/**
 * Every /api/admin/seo/* route goes through `seoRoute`:
 * - admin only: 401 without a session, 403 for authors and readers (decided on the server, every request);
 * - mutations: same-origin `Origin` header (CSRF; cookies are SameSite too) and JSON bodies only;
 * - rate limit per admin and route (Postgres-backed, shared by both replicas);
 * - zod validation → 400 with the list of issues;
 * - unexpected errors → logged once with a reference; the response never contains internals or secrets;
 * - `Cache-Control: no-store`, `X-Robots-Tag: noindex`.
 * Mutations are audit-logged by the handler with `ctx.audit(…)` (before/after, never secrets).
 */
const HEADERS = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex", "X-Content-Type-Options": "nosniff" };

export class SeoApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly issues: string[] = [],
  ) {
    super(message);
  }
}

export function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return Response.json(body, { status, headers: { ...HEADERS, ...extra } });
}

function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export type SeoCtx = {
  user: SessionUser;
  actor: Actor;
  /** Parsed JSON body (mutations only). */
  body: unknown;
  query: URLSearchParams;
  audit: (action: string, target?: string, detail?: Record<string, unknown>) => Promise<void>;
};

type Opts = { mutating?: boolean; rate?: { max: number; windowSeconds: number } };

/** Defaults: reads 120/min, mutations 30/min per admin and route. */
export function seoRoute<P = Record<string, string>>(name: string, opts: Opts, fn: (req: Request, ctx: SeoCtx, params: P) => Promise<Response>) {
  return async (req: Request, routeCtx?: { params?: Promise<P> }): Promise<Response> => {
    try {
      const user = await getSessionUser();
      if (!user) return json({ error: "Sign in as an admin.", code: "auth_required" }, 401);
      if (user.role !== "admin") return json({ error: "Admins only.", code: "forbidden" }, 403);
      if (opts.mutating) {
        if (!sameOrigin(req)) return json({ error: "Cross-site request refused.", code: "cross_site" }, 403);
      }
      const rate = opts.rate ?? (opts.mutating ? { max: 30, windowSeconds: 60 } : { max: 120, windowSeconds: 60 });
      if (!(await hit(`seo:${name}:${user.id}`, rate.max, rate.windowSeconds))) return json({ error: "Too many requests. Try again shortly.", code: "rate_limited" }, 429, { "Retry-After": String(rate.windowSeconds) });
      let body: unknown = undefined;
      if (opts.mutating && req.method !== "DELETE") {
        const type = req.headers.get("content-type") ?? "";
        const text = await req.text();
        if (text) {
          if (!type.includes("application/json")) return json({ error: "Send JSON.", code: "unsupported_media_type" }, 415);
          if (text.length > 200_000) return json({ error: "Request too large.", code: "too_large" }, 413);
          try {
            body = JSON.parse(text);
          } catch {
            return json({ error: "Invalid JSON.", code: "invalid_json" }, 400);
          }
        }
      }
      const actor = actorOf(user);
      const ctx: SeoCtx = {
        user,
        actor,
        body,
        query: new URL(req.url).searchParams,
        audit: (action, target, detail) => audit(actor, `seo.${action}`, target, detail),
      };
      const params = ((await routeCtx?.params) ?? {}) as P;
      return await fn(req, ctx, params);
    } catch (error) {
      if (isNextControlFlow(error)) throw error;
      if (error instanceof SeoApiError) return json({ error: error.message, code: error.code, ...(error.issues.length ? { issues: error.issues } : {}) }, error.status);
      const status = (error as { status?: unknown }).status;
      if (typeof status === "number" && status >= 400 && status < 500) {
        const issues = (error as { issues?: unknown }).issues;
        return json({ error: (error as Error).message, code: "invalid", ...(Array.isArray(issues) && issues.length ? { issues } : {}) }, status);
      }
      const ref = reportError(`seo api ${name} failed`, error, routeFields(req));
      return json({ error: "Something went wrong. The error has been logged.", code: "internal", reference: ref.reference }, 500);
    }
  };
}

/** zod parse → SeoApiError(400) with readable issues. */
export function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const r = schema.safeParse(value);
  if (!r.success) throw new SeoApiError("The request is not valid.", 400, "invalid", r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`));
  return r.data;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
