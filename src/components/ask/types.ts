/** Shared by the Ask the Blog client components. No React and no browser APIs here: the launcher imports it. */

export type AskCopy = { button: string; intro: string; placeholder: string; disclaimer: string; examples: string[] };
export type AskConversation = { followUps: boolean; turns: number; keepThread: boolean; pageContext: boolean; feedback: boolean };
export type AskAudienceMode = "members" | "everyone";

/** What the widget needs from the settings document (never the budget or other server-only fields). */
export type AskClientConfig = { copy: AskCopy; audience: AskAudienceMode; maxQuestion: number; conversation: AskConversation };

/** The article the reader has open, for "Reading: …" and page context. */
export type AskContext = { slug: string; title: string } | null;

/** sessionStorage key of the saved conversation (thread.ts). The launcher reads it to show the "conversation kept" dot. */
export const THREAD_KEY = "ask-blog:thread:v1";

/** Window events: anything on the page (the inline cards) can open the sitewide panel; a 401 asks for sign-in. */
export const OPEN_EVENT = "ask-blog:open";
export const SIGNIN_EVENT = "ask-blog:signin";

/** The open article from the URL: /blog/<slug> only (categories, tags and pages are not articles). */
export function articleSlug(pathname: string | null): string | null {
  const m = /^\/blog\/([a-z0-9][a-z0-9-]*)\/?$/.exec(pathname ?? "");
  return m?.[1] ?? null;
}

/**
 * Paths where the sitewide chat never shows, whatever is saved: the admin app, sign-in and account flows, setup,
 * previews and the MCP OAuth consent screens. The admin can add more (`sitewide.hideOn`).
 */
export const ASK_ALWAYS_HIDDEN = ["/admin", "/login", "/forgot-password", "/reset-password", "/account", "/setup", "/preview", "/mcp-oauth"] as const;

/** Whether `pathname` is `prefix` itself or below it ("/python-practice" hides "/python-practice/x", not "/python-practiced"). */
export function underPrefix(pathname: string, prefix: string): boolean {
  const p = prefix.length > 1 ? prefix.replace(/\/+$/, "") : prefix;
  return pathname === p || pathname.startsWith(`${p}/`);
}

export function askHiddenOn(pathname: string, hideOn: readonly string[]): boolean {
  return [...ASK_ALWAYS_HIDDEN, ...hideOn].some((p) => underPrefix(pathname, p));
}

