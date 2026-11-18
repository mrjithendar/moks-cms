"use client";

import type { AskAudienceMode } from "./types";

export const primaryBtn =
  "inline-flex h-10 items-center justify-center rounded-lg bg-accent px-4 text-sm font-semibold text-on-accent transition-colors hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60";
export const secondaryBtn = "inline-flex h-10 items-center justify-center rounded-lg border border-line-strong px-4 text-sm font-semibold text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

export type Access = "ok" | "signin" | "off";

/**
 * Pages are cached and cannot know who is reading, so in signed-in-only mode the widget asks GET /api/ask when the
 * reader opens it. A failed check lets the panel open: the server decides again on every question (401 → sign in).
 */
export async function checkAccess(audience: AskAudienceMode): Promise<Access> {
  if (audience !== "members") return "ok";
  const status = (await fetch("/api/ask", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)) as { enabled?: boolean; signedIn?: boolean | null } | null;
  if (status && !status.enabled) return "off";
  if (status && status.signedIn === false) return "signin";
  return "ok";
}

export function SignInPrompt({ next, onClose }: { next: string; onClose: () => void }) {
  const n = encodeURIComponent(next || "/");
  return (
    <div role="status">
      <h2 className="text-lg font-semibold text-fg">Sign in to ask a question</h2>
      <p className="mt-2 text-[0.9375rem] text-fg-muted">Ask the Blog is for signed-in readers. An account is free and takes a minute. You&apos;ll come back to this page.</p>
      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
        <a href={`/login?next=${n}`} className={primaryBtn}>
          Sign in
        </a>
        <a href={`/login?mode=signup&next=${n}`} className={secondaryBtn}>
          Create a free account
        </a>
        <button type="button" onClick={onClose} className={secondaryBtn}>
          Not now
        </button>
      </div>
    </div>
  );
}

export const OFF_MESSAGE = "Ask the Blog is switched off right now. Please use search instead.";
