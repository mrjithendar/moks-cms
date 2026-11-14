/**
 * Read-only demo accounts (stored role "demo"): for showing the CMS to someone, not for running it.
 *
 * A demo account sees the admin exactly as an admin does, but only on reads. The proxy stamps every request with
 * its HTTP method (REQUEST_METHOD_HEADER, overwriting anything the client sent); getSessionUser() treats a demo
 * account as an admin on GET/HEAD and as a plain "demo" role on anything else (server actions, POST/PUT/PATCH/DELETE
 * routes). Every existing staff check therefore refuses its writes without each one knowing about demos. A missing
 * stamp counts as a write (fail closed).
 */

/** Set by the proxy on every request it forwards to the app; the value is the request's HTTP method. */
export const REQUEST_METHOD_HEADER = "x-moks-request-method";

/** Where the invitation's set-password link lands (the reset page, worded as an invitation). */
export const DEMO_INVITE_REDIRECT = "/reset-password?invite=demo";

export const DEMO_READ_ONLY_MESSAGE = "This is a read-only demo account. You can look around, but nothing you change is saved.";

/** Whether a request (by its proxy-stamped method and Next's server-action header) only reads. */
export function isReadRequest(headers: Pick<Headers, "get">): boolean {
  const method = headers.get(REQUEST_METHOD_HEADER);
  if (method !== "GET" && method !== "HEAD") return false;
  // A server action is always a POST, so this only matters if a proxy stamp were ever missed; belt and braces.
  return !headers.get("next-action");
}

/** Strip any existing ?ok= / ?error= from a same-site path and append the read-only notice. */
export function demoDeniedTarget(referer: string | null, fallback = "/admin"): string {
  let path = fallback;
  if (referer) {
    try {
      const url = new URL(referer, "https://same-origin.invalid");
      // Only the path and query of the page the person was on: never another site.
      if (url.pathname.startsWith("/admin") || url.pathname.startsWith("/account")) {
        url.searchParams.delete("ok");
        url.searchParams.delete("error");
        path = url.pathname + url.search;
      }
    } catch {
      // keep the fallback
    }
  }
  return `${path}${path.includes("?") ? "&" : "?"}error=${encodeURIComponent(DEMO_READ_ONLY_MESSAGE)}`;
}

/** How long an invitation's set-password link works (a password reset link works for one hour). */
export const DEMO_INVITE_HOURS = 72;

export const DEMO_INVITE_SUBJECT = "Your invitation to the Jithendar.com CMS demo";

export function demoInviteText(url: string, site: string): string {
  return [
    "You have been invited to a read-only demo of the Jithendar.com publishing platform.",
    "You can open every admin page the site owner sees. Nothing you change is saved, and nothing is published or sent.",
    "",
    `Choose a password to get started: ${url}`,
    "",
    `The link works once, for ${DEMO_INVITE_HOURS / 24} days. If it has expired, ask for a new one at ${site}/forgot-password with this email address.`,
    "",
    "If you were not expecting this invitation, ignore this email.",
  ].join("\n");
}
