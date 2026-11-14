"use client";

import { usePathname } from "next/navigation";
import { useRef, useState, type ComponentType } from "react";
import type { PanelProps } from "./AskPanel";

export type AskCopy = { button: string; intro: string; placeholder: string; disclaimer: string; examples: string[] };
type Props = { copy: AskCopy; audience: "members" | "everyone"; maxQuestion: number };
type View = "closed" | "checking" | "panel" | "signin" | "off";

const primary = "inline-flex h-10 items-center justify-center rounded-lg bg-accent px-4 text-sm font-semibold text-on-accent transition-colors hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60";
const secondary = "inline-flex h-10 items-center justify-center rounded-lg border border-line-strong px-4 text-sm font-semibold text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/**
 * "Ask the Blog" entry point: a single button, rendered only when the assistant is on (AskBlog.tsx). The panel and
 * its streaming code are a separate chunk loaded on the first interaction (click, or keyboard activation), so pages
 * carry no extra JavaScript work until a reader asks. Hover/focus prefetch the chunk so opening feels instant.
 *
 * Signed-in-only mode (Admin → Automation & AI → Ask the Blog): the page is cached and cannot know who is reading, so
 * opening asks GET /api/ask first. A signed-out reader gets a prompt to sign in (returning to this page) instead of
 * the question box. The server checks the session again on every question.
 */
export function AskLauncher({ copy, audience, maxQuestion }: Props) {
  const pathname = usePathname();
  const [Panel, setPanel] = useState<ComponentType<PanelProps> | null>(null);
  const [view, setView] = useState<View>("closed");
  const button = useRef<HTMLButtonElement>(null);
  const load = () => import("./AskPanel").then((m) => m.AskPanel);
  const openPanel = async () => {
    if (audience === "members") {
      setView("checking");
      const status = (await fetch("/api/ask", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)) as { enabled?: boolean; signedIn?: boolean | null } | null;
      if (status && !status.enabled) {
        setView("off");
        return;
      }
      if (status && status.signedIn === false) {
        setView("signin");
        return;
      }
    }
    const P = Panel ?? (await load());
    setPanel(() => P);
    setView("panel");
  };
  const close = () => {
    setView("closed");
    button.current?.focus();
  };
  const next = encodeURIComponent(pathname || "/");
  return (
    <section aria-label="Ask the Blog" className="mt-12 rounded-xl border border-line bg-surface p-5 sm:p-6">
      {view === "closed" || view === "checking" ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[0.9375rem] text-fg-muted">{copy.intro}</p>
          <button ref={button} type="button" onClick={openPanel} onPointerEnter={() => void load()} onFocus={() => void load()} aria-expanded={false} disabled={view === "checking"} className={`shrink-0 ${primary}`}>
            {copy.button}
          </button>
        </div>
      ) : view === "signin" ? (
        <div role="status">
          <h2 className="text-lg font-semibold text-fg">Sign in to ask a question</h2>
          <p className="mt-2 text-[0.9375rem] text-fg-muted">Ask the Blog is for signed-in readers. An account is free and takes a minute.</p>
          <div className="mt-4 flex flex-col gap-3 sm:flex-row">
            <a href={`/login?next=${next}`} className={primary}>
              Sign in
            </a>
            <a href={`/login?mode=signup&next=${next}`} className={secondary}>
              Create a free account
            </a>
            <button type="button" onClick={close} className={secondary}>
              Not now
            </button>
          </div>
        </div>
      ) : view === "off" ? (
        <p role="status" className="text-[0.9375rem] text-fg-muted">
          Ask the Blog is switched off right now. Please use search instead.
        </p>
      ) : (
        Panel && <Panel onClose={close} onNeedSignIn={() => setView("signin")} copy={copy} maxQuestion={maxQuestion} />
      )}
    </section>
  );
}
