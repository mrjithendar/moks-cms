import { recordSeoApiRequest } from "../../metrics";
import { accessToken, TokenError, type ServiceAccount } from "./auth";

/**
 * Calls to Google APIs: bearer token, timeout, exponential backoff with full jitter on 429 / 5xx / network errors,
 * and a clean stop on 401 / 403 (an "auth" error the sync records on the integration). Every call is counted in
 * the run's stats (api_requests, retries) and in Prometheus (provider label only, never URLs).
 */
export type ErrorCode = "auth" | "quota" | "bad_request" | "unavailable" | "not_found" | "budget";

export class GoogleApiError extends Error {
  constructor(
    message: string,
    readonly code: ErrorCode,
    readonly status?: number,
  ) {
    super(message);
  }
}

export type RunStats = { apiRequests: number; retries: number };

export type ApiContext = {
  sa: ServiceAccount;
  scope: string;
<<<<<<< HEAD
  provider: "gsc" | "ga4" | "url_inspection" | "psi" | "gsc_sitemaps";
=======
  provider: "gsc" | "ga4" | "url_inspection" | "psi";
>>>>>>> b2fdd38e5c9ee8e194e969e929c61253a9beaafd
  stats: RunStats;
  /** Stop before exceeding this many requests in the run (quota protection). */
  maxRequests: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  maxRetries?: number;
  timeoutMs?: number;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Full jitter: random in [0, min(cap, base·2^attempt)). */
export function backoffDelay(attempt: number, random: () => number = Math.random, baseMs = 1000, capMs = 32_000): number {
  return Math.floor(random() * Math.min(capMs, baseMs * 2 ** attempt));
}

/** Google's error message, trimmed; never includes request bodies or tokens. */
async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string; status?: string } };
    const m = body.error?.message ?? body.error?.status ?? "";
    return m.replace(/ya29\.[\w.-]+/g, "[token]").slice(0, 300);
  } catch {
    return "";
  }
}

<<<<<<< HEAD
export async function googleJson<T>(ctx: ApiContext, url: string, body: unknown, method: "POST" | "GET" | "PUT" = "POST"): Promise<T> {
=======
export async function googleJson<T>(ctx: ApiContext, url: string, body: unknown, method: "POST" | "GET" = "POST"): Promise<T> {
>>>>>>> b2fdd38e5c9ee8e194e969e929c61253a9beaafd
  const fetchImpl = ctx.fetchImpl ?? fetch;
  const sleep = ctx.sleep ?? defaultSleep;
  const maxRetries = ctx.maxRetries ?? 4;
  for (let attempt = 0; ; attempt++) {
    if (ctx.stats.apiRequests >= ctx.maxRequests) throw new GoogleApiError(`Request budget for this run (${ctx.maxRequests}) is used up.`, "budget");
    let token: string;
    try {
      token = await accessToken(ctx.sa, ctx.scope, fetchImpl);
    } catch (e) {
      if (e instanceof TokenError) throw new GoogleApiError(e.message, e.code);
      throw e;
    }
    ctx.stats.apiRequests++;
    let res: Response | null = null;
    try {
      res = await fetchImpl(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
        ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(ctx.timeoutMs ?? 60_000),
      });
    } catch {
      res = null;
    }
    const status = res?.status ?? 0;
    recordSeoApiRequest(ctx.provider, res?.ok ? "ok" : status === 0 ? "network" : status === 429 ? "rate_limited" : status >= 500 ? "server_error" : "client_error");
<<<<<<< HEAD
    if (res?.ok) {
      // sitemaps.submit (PUT) answers 204 / an empty body.
      const text = await res.text();
      return (text ? JSON.parse(text) : {}) as T;
    }
=======
    if (res?.ok) return (await res.json()) as T;
>>>>>>> b2fdd38e5c9ee8e194e969e929c61253a9beaafd
    const retryable = !res || status === 429 || status >= 500;
    if (retryable && attempt < maxRetries) {
      ctx.stats.retries++;
      const retryAfter = Number(res?.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 60) * 1000 : backoffDelay(attempt, ctx.random));
      continue;
    }
    const message = res ? await errorMessage(res) : "network error";
    if (status === 401 || status === 403) throw new GoogleApiError(`Google denied access (HTTP ${status})${message ? `: ${message}` : ""}. Check that the service account has access to the property.`, "auth", status);
    if (status === 429) throw new GoogleApiError(`Google quota exceeded after ${attempt} retries${message ? `: ${message}` : ""}.`, "quota", status);
    if (status === 404) throw new GoogleApiError(`Not found (HTTP 404)${message ? `: ${message}` : ""}. Check the property id.`, "not_found", status);
    if (status === 400) throw new GoogleApiError(`Google rejected the request (HTTP 400)${message ? `: ${message}` : ""}.`, "bad_request", status);
    throw new GoogleApiError(`Google API unavailable (${status ? `HTTP ${status}` : "network error"}) after ${attempt} retries.`, "unavailable", status || undefined);
  }
}
