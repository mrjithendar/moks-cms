"use client";

import { useRef, useState, type ComponentType } from "react";

type PanelProps = { onClose: () => void };

/**
 * "Ask the Blog" entry point: a single button, rendered only when ASK_BLOG_ENABLED is on (AskBlog.tsx). The panel and
 * its streaming code are a separate chunk loaded on the first interaction (click, or keyboard activation), so pages
 * carry no extra JavaScript work until a reader asks. Hover/focus prefetch the chunk so opening feels instant.
 */
export function AskLauncher() {
  const [Panel, setPanel] = useState<ComponentType<PanelProps> | null>(null);
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const load = () => import("./AskPanel").then((m) => m.AskPanel);
  const openPanel = async () => {
    const P = Panel ?? (await load());
    setPanel(() => P);
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  return (
    <section aria-label="Ask the Blog" className="mt-12 rounded-xl border border-line bg-surface p-5 sm:p-6">
      {!open ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[0.9375rem] text-fg-muted">Have a question? Get an answer from the articles on this site, with links to the sections it comes from.</p>
          <button ref={button} type="button" onClick={openPanel} onPointerEnter={() => void load()} onFocus={() => void load()} aria-expanded={false} className="shrink-0 inline-flex h-10 items-center justify-center rounded-lg bg-accent px-4 text-sm font-semibold text-on-accent transition-colors hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60">
            Ask the Blog
          </button>
        </div>
      ) : (
        Panel && <Panel onClose={close} />
      )}
    </section>
  );
}
