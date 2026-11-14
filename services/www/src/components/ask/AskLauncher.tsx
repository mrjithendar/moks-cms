"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ComponentType } from "react";
import { checkAccess, OFF_MESSAGE, primaryBtn, SignInPrompt } from "./AskGate";
import type { PanelProps } from "./AskPanel";
import { articleSlug, OPEN_EVENT, SIGNIN_EVENT, type AskClientConfig, type AskContext } from "./types";

export type { AskCopy } from "./types";

type Props = {
  config: AskClientConfig;
  /** "opener": the sitewide chat is on, so the button opens the corner panel (one panel, one conversation per page). */
  mode: "inline" | "opener";
};
type View = "closed" | "checking" | "panel" | "signin" | "off";

const load = () => import("./AskPanel").then((m) => m.AskPanel);

/**
 * The "Ask the Blog" card at the end of the home page and of each article (Admin → Ask the Blog → inline cards),
 * rendered only when the assistant is on (AskBlog.tsx). With the sitewide chat on, its button opens the corner panel.
 * Otherwise it expands in place into the same chat panel, loaded as a separate chunk on the first interaction.
 */
export function AskLauncher({ config, mode }: Props) {
  const pathname = usePathname() || "/";
  const [Panel, setPanel] = useState<ComponentType<PanelProps> | null>(null);
  const [view, setView] = useState<View>("closed");
  const [context, setContext] = useState<AskContext>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (mode !== "inline") return;
    const onSignIn = () => setView((v) => (v === "panel" ? "signin" : v));
    window.addEventListener(SIGNIN_EVENT, onSignIn);
    return () => window.removeEventListener(SIGNIN_EVENT, onSignIn);
  }, [mode]);

  const openPanel = async () => {
    if (mode === "opener") {
      window.dispatchEvent(new CustomEvent(OPEN_EVENT));
      return;
    }
    setView("checking");
    const [access, P] = await Promise.all([checkAccess(config.audience), Panel ? Promise.resolve(Panel) : load()]);
    const slug = articleSlug(pathname);
    const title = document.querySelector("main article h1")?.textContent?.trim();
    setContext(slug && title ? { slug, title } : null);
    setPanel(() => P);
    setView(access === "ok" ? "panel" : access);
  };
  const close = () => {
    setView("closed");
    requestAnimationFrame(() => button.current?.focus());
  };
  return (
    <section aria-label="Ask the Blog" className="mt-12 rounded-xl border border-line bg-surface p-5 sm:p-6">
      {view === "closed" || view === "checking" ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[0.9375rem] text-fg-muted">{config.copy.intro}</p>
          <button
            ref={button}
            type="button"
            onClick={openPanel}
            onPointerEnter={() => void load()}
            onFocus={() => void load()}
            aria-expanded={mode === "inline" ? false : undefined}
            aria-haspopup={mode === "opener" ? "dialog" : undefined}
            disabled={view === "checking"}
            className={`shrink-0 ${primaryBtn}`}
          >
            {config.copy.button}
          </button>
        </div>
      ) : view === "signin" ? (
        <SignInPrompt next={pathname} onClose={close} />
      ) : view === "off" ? (
        <p role="status" className="text-[0.9375rem] text-fg-muted">
          {OFF_MESSAGE}
        </p>
      ) : (
        Panel && <Panel variant="inline" copy={config.copy} maxQuestion={config.maxQuestion} conversation={config.conversation} context={context} onClose={close} />
      )}
    </section>
  );
}
