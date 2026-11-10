import { createSign } from "node:crypto";

/**
 * OAuth 2.0 for a Google service account (server-to-server): sign a JWT with the account's private key (RS256)
 * and exchange it for an access token. https://developers.google.com/identity/protocols/oauth2/service-account
 *
 * The key comes only from the environment: GOOGLE_SEO_SERVICE_ACCOUNT_JSON holds the JSON key file, raw or
 * base64-encoded. It is never stored in the database, logged, returned by an API or sent to an LLM. Errors
 * mention the variable name, never its contents.
 */
export const SCOPES = {
  searchConsole: "https://www.googleapis.com/auth/webmasters.readonly",
  analytics: "https://www.googleapis.com/auth/analytics.readonly",
  /** Write scope, only for sitemaps.submit (needs Full or Owner permission on the property; docs/seo/SUBMISSION.md). */
  searchConsoleWrite: "https://www.googleapis.com/auth/webmasters",
} as const;

export type ServiceAccount = { clientEmail: string; privateKey: string; tokenUri: string; projectId: string | null };

export class CredentialsError extends Error {
  readonly code = "not_configured";
}

const TOKEN_URI = "https://oauth2.googleapis.com/token";

/** Parse the key file. null when the variable is unset; CredentialsError when it is set but unusable. */
export function readServiceAccount(env: Record<string, string | undefined> = process.env): ServiceAccount | null {
  const raw = env.GOOGLE_SEO_SERVICE_ACCOUNT_JSON?.trim();
  if (!raw) return null;
  let text = raw;
  if (!raw.startsWith("{")) {
    try {
      text = Buffer.from(raw, "base64").toString("utf8");
    } catch {
      throw new CredentialsError("GOOGLE_SEO_SERVICE_ACCOUNT_JSON is neither JSON nor base64-encoded JSON.");
    }
  }
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new CredentialsError("GOOGLE_SEO_SERVICE_ACCOUNT_JSON is not valid JSON.");
  }
  if (data.type !== "service_account" || typeof data.client_email !== "string" || typeof data.private_key !== "string") {
    throw new CredentialsError("GOOGLE_SEO_SERVICE_ACCOUNT_JSON is not a service-account key (type, client_email, private_key).");
  }
  const tokenUri = typeof data.token_uri === "string" && data.token_uri.startsWith("https://") ? data.token_uri : TOKEN_URI;
  return { clientEmail: data.client_email, privateKey: data.private_key, tokenUri, projectId: typeof data.project_id === "string" ? data.project_id : null };
}

const b64url = (v: string | Buffer) => Buffer.from(v).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

export function signJwt(sa: ServiceAccount, scope: string, nowSeconds: number): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: sa.clientEmail, scope, aud: sa.tokenUri, iat: nowSeconds, exp: nowSeconds + 3600 }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${b64url(signer.sign(sa.privateKey))}`;
}

type Cached = { token: string; expiresAt: number };
const g = globalThis as unknown as { __seoTokens?: Map<string, Cached> };
const cache = (g.__seoTokens ??= new Map());

export function clearTokenCache() {
  cache.clear();
}

export class TokenError extends Error {
  constructor(
    message: string,
    readonly code: "auth" | "unavailable",
  ) {
    super(message);
  }
}

/** An access token for `scope`, cached until a minute before it expires. */
export async function accessToken(sa: ServiceAccount, scope: string, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<string> {
  const key = `${sa.clientEmail}|${scope}`;
  const hit = cache.get(key);
  if (hit && hit.expiresAt - 60_000 > now) return hit.token;
  const assertion = signJwt(sa, scope, Math.floor(now / 1000));
  let res: Response;
  try {
    res = await fetchImpl(sa.tokenUri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new TokenError("Google's token endpoint is unreachable.", "unavailable");
  }
  if (!res.ok) {
    // 400 invalid_grant = wrong/revoked key or clock skew; never echo the body (it can include the assertion).
    throw new TokenError(`Google refused the service-account credentials (HTTP ${res.status}).`, res.status >= 500 ? "unavailable" : "auth");
  }
  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new TokenError("Google's token response had no access token.", "unavailable");
  cache.set(key, { token: body.access_token, expiresAt: now + (body.expires_in ?? 3600) * 1000 });
  return body.access_token;
}
