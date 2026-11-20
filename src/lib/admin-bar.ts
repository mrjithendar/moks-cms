/**
 * The admin bar: a WordPress-style toolbar pinned to the top of every page for staff (components/admin-bar/AdminBar.tsx).
 *
 * Public pages are cached (the ISR page cache on every pod, and Cloudflare in front, which keys on the URL alone and
 * ignores cookies), so the bar is never part of the HTML: the browser draws it after the session says the reader is
 * staff, with data from GET /api/admin/bar (never cached). Two things make that smooth:
 * - a hint cookie (ADMIN_BAR_COOKIE, readable by scripts, grants nothing) remembers that this browser shows the bar,
 *   so the head script reserves its space before the first paint and the page does not jump when it appears;
 * - the same cookie, set to "off", remembers that this person hid the bar on public pages (it always shows in the admin).
 *
 * Pure and dependency-free: the root layout (head script), the bar (browser), the API and the tests import it.
 */

/** Hint cookie. Shared origin (Argo CD, Grafana… live under the same host): keep the moks- prefix. */
export const ADMIN_BAR_COOKIE = "moks-adminbar";

/** Cookie values: the bar shows on public pages, or this person hid it there. Absent: not known to be staff. */
export type BarPreference = "on" | "off";

/** Class on <html> while the bar is shown (or its space is reserved); globals.css sizes --adminbar-h from it. */
export const ADMIN_BAR_CLASS = "has-adminbar";

/** Pages that never show the bar: editor previews (also shown framed inside the editor) and the device previews. */
export function barExcludedPath(pathname: string): boolean {
  return /^\/preview(\/|$)/.test(pathname);
}

export function isAdminPath(pathname: string): boolean {
  return /^\/admin(\/|$)/.test(pathname);
}

/**
 * Runs in <head> before the first paint: reserve the bar's space when it is going to show, so nothing moves. In the
 * admin it always shows (every admin page requires a staff session); on public pages only when the hint cookie says so.
 * Never inside a frame (the editor's device previews frame the site).
 */
export function adminBarHeadScript(): string {
  return (
    `(function(){try{if(window.top!==window.self)return;var p=location.pathname;if(/^\\/preview(\\/|$)/.test(p))return;` +
    `var m=document.cookie.match(/(?:^|; )${ADMIN_BAR_COOKIE}=([^;]*)/);` +
    `if(/^\\/admin(\\/|$)/.test(p)||(m&&m[1]==="on"))document.documentElement.classList.add("${ADMIN_BAR_CLASS}");}catch(e){}})();`
  );
}

/** The cookie as the browser writes it: a year, whole site, Lax; Secure on https. */
export function barCookie(value: BarPreference | null, secure: boolean): string {
  const base = `${ADMIN_BAR_COOKIE}=${value ?? ""}; Path=/; SameSite=Lax${secure ? "; Secure" : ""}`;
  return value ? `${base}; Max-Age=31536000` : `${base}; Max-Age=0`;
}

export function readBarCookie(cookie: string): BarPreference | null {
  const m = new RegExp(`(?:^|; )${ADMIN_BAR_COOKIE}=([^;]*)`).exec(cookie);
  return m?.[1] === "on" || m?.[1] === "off" ? m[1] : null;
}

/** What a URL is, as far as the bar's "Edit" and "View" links are concerned. */
export type BarTarget =
  | { kind: "home" }
  | { kind: "post"; collection: "blog" | "news" | "projects"; slug: string }
  | { kind: "page"; slug: string }
  | { kind: "category"; slug: string }
  | { kind: "tag"; slug: string }
  | { kind: "author"; slug: string }
  | { kind: "listing"; collection: "blog" | "news" | "projects" }
  | { kind: "hire-me" }
  | { kind: "admin-post"; id: string }
  | { kind: "admin-page"; slug: string }
  | { kind: "admin" }
  | { kind: "other" };

const SLUG = /^[a-z0-9][a-z0-9-]{0,199}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COLLECTIONS = new Set(["blog", "news", "projects"]);
/** First path segments the site itself owns: never a page from Admin → Pages (site-pages.ts RESERVED_PAGE_SLUGS and the app routes). */
const NOT_PAGES = new Set([
  "admin", "api", "account", "login", "setup", "search", "media", "images", "authors", "category", "tag", "blog", "news", "projects",
  "feed", "page", "user-manual", "invoice", "_next", "hire-me", "preview", "python-practice", "ai-assistants", "forgot-password",
  "reset-password", "mcp-oauth",
]);

/** Pure: classify a pathname (no query, no host). Unknown or malformed paths are "other". */
export function barTarget(pathname: string): BarTarget {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/") return { kind: "home" };
  const parts = path.split("/").slice(1).map((p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return "\u0000";
    }
  });
  const [a, b, c] = parts;
  if (a === "admin") {
    if (b === "posts" && c && UUID.test(c)) return { kind: "admin-post", id: c };
    if (b === "pages" && c && c !== "new" && SLUG.test(c)) return { kind: "admin-page", slug: c };
    return { kind: "admin" };
  }
  if (a && COLLECTIONS.has(a)) {
    const collection = a as "blog" | "news" | "projects";
    if (parts.length === 1 || b === "page") return { kind: "listing", collection };
    if (parts.length === 2 && b && SLUG.test(b)) return { kind: "post", collection, slug: b };
    return { kind: "other" };
  }
  if (a === "category" && b && SLUG.test(b)) return { kind: "category", slug: b };
  if (a === "tag" && b && b.length <= 100 && !/[\u0000-\u001f]/.test(b)) return { kind: "tag", slug: b };
  if (a === "authors" && b && SLUG.test(b)) return { kind: "author", slug: b };
  if (a === "hire-me" && parts.length === 1) return { kind: "hire-me" };
  if (parts.length === 1 && a && SLUG.test(a) && !NOT_PAGES.has(a)) return { kind: "page", slug: a };
  return { kind: "other" };
}

/** A link in the bar. `external` opens in a new tab. */
export type BarLink = { label: string; href: string };

/** GET /api/admin/bar → the bar's contents for this person and this page. */
export type AdminBarData = {
  user: { name: string; email: string; image: string | null; role: "admin" | "author"; demo: boolean };
  /** Counts shown as badges (same as the admin menu's). */
  badges: { comments: number; messages: number; review: number };
  /** Links about the page being viewed: Edit / View / Insights / Customize. */
  context: BarLink[];
  /** Cache tools: admins use them; the read-only demo sees them disabled; authors do not see them. `cloudflare`: a
   * zone ID and API token are saved (Admin → Cache → Cloudflare settings), so purges reach Cloudflare too. */
  cache: { allowed: boolean; cloudflare: boolean } | null;
  /** Whether this person hid the bar on public pages (the admin always shows it). */
  preference: BarPreference;
};

/** POST /api/admin/cache actions. The cf-* ones touch Cloudflare only. */
export const CACHE_ACTIONS = ["purge-page", "clear-pages", "clear-data", "purge-all", "cf-everything", "cf-custom", "cf-test"] as const;
export type CacheAction = (typeof CACHE_ACTIONS)[number];

/**
 * A path that may be purged: a public URL path, no query or fragment, no dot segments, printable ASCII (encoded),
 * bounded. It travels to the other replicas on the cache bus, so it is checked again on arrival.
 */
export function purgeablePath(path: unknown): string | null {
  if (typeof path !== "string" || path.length > 512 || !path.startsWith("/") || path.startsWith("//")) return null;
  if (!/^\/[A-Za-z0-9\-._~%!$&'()*+,;=:@/]*$/.test(path)) return null;
  if (path.split("/").some((s) => s === "." || s === "..")) return null;
  const trimmed = path.replace(/\/+$/, "");
  return trimmed || "/";
}
