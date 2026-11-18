"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ComponentType } from "react";
import { checkAccess, OFF_MESSAGE, SignInPrompt } from "./AskGate";
import type { PanelProps } from "./AskPanel";
import { articleSlug, askHiddenOn, OPEN_EVENT, SIGNIN_EVENT, THREAD_KEY, type AskClientConfig, type AskContext } from "./types";

type Props = { config: AskClientConfig; launcher: "pill" | "icon"; hideOn: string[] };
type View = "closed" | "checking" | "panel" | "signin" | "off";

const PHONE = "(max-width: 639px)";
const noop = () => () => {};
const load = () => import("./AskPanel").then((m) => m.AskPanel);

function savedThread(): boolean {
  try {
    return Boolean(window.sessionStorage.getItem(THREAD_KEY));
  } catch {
    return false;
  }
}

/**
 * Sitewide "Ask the Blog": a launcher in the bottom-right corner of every public page (AskSitewide.tsx decides
 * whether it is rendered at all), and the chat panel it opens. Mounted in the root layout, so the panel and the
 * conversation survive client-side navigation; the conversation itself lives in thread.ts.
 *
 * - The panel and its streaming code are a separate chunk, prefetched on hover/focus and loaded on the first open.
 * - Desktop: a non-modal panel above the launcher; the reader can keep scrolling the article. Phone: a full-screen
 *   modal sheet; the rest of the page is made inert and following a source closes it.
 * - Inline cards (AskBlog with sitewide on) open this panel through the OPEN_EVENT window event.
 */
export function AskDock({ config, launcher, hideOn }: Props) {
  const pathname = usePathname() || "/";
  const hidden = askHiddenOn(pathname, hideOn);
  const [Panel, setPanel] = useState<ComponentType<PanelProps> | null>(null);
  const [view, setView] = useState<View>("closed");
  const [phone, setPhone] = useState(false);
  const [compact, setCompact] = useState(false);
  const [context, setContext] = useState<AskContext>(null);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const open = view !== "closed";

  useEffect(() => {
    const mq = window.matchMedia(PHONE);
    const on = () => setPhone(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  // False on the server and during hydration, true after: sessionStorage is only read in the browser.
  const mounted = useSyncExternalStore(noop, () => true, () => false);
  const dot = mounted && !open && savedThread();

  // The pill shrinks to a round icon once the reader is past the first screen, so it covers less of the text.
  useEffect(() => {
    if (launcher !== "pill") return;
    const on = () => setCompact(window.scrollY > Math.min(480, window.innerHeight * 0.6));
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, [launcher]);

  // The open article, for "Reading: …" and page context. The heading is read after navigation has rendered it.
  useEffect(() => {
    const slug = articleSlug(pathname);
    const t = window.setTimeout(() => {
      // Only a rendered article counts: a /blog/<slug> URL can also be a 404 or a members-only prompt.
      const title = document.querySelector("main article h1")?.textContent?.trim();
      setContext(slug && title ? { slug, title } : null);
    }, 0);
    return () => window.clearTimeout(t);
  }, [pathname]);

  const close = useCallback(() => {
    setView("closed");
    requestAnimationFrame(() => button.current?.focus());
  }, []);

  const show = useCallback(async () => {
    setView("checking");
    const [access, P] = await Promise.all([checkAccess(config.audience), Panel ? Promise.resolve(Panel) : load()]);
    setPanel(() => P);
    setView(access === "ok" ? "panel" : access);
  }, [Panel, config.audience]);

  useEffect(() => {
    const onOpen = () => void show();
    const onSignIn = () => setView("signin");
    window.addEventListener(OPEN_EVENT, onOpen);
    window.addEventListener(SIGNIN_EVENT, onSignIn);
    return () => {
      window.removeEventListener(OPEN_EVENT, onOpen);
      window.removeEventListener(SIGNIN_EVENT, onSignIn);
    };
  }, [show]);

  // Phone sheet: modal. Everything else on the page is inert and does not scroll behind it.
  useEffect(() => {
    if (!open || !phone || hidden) return;
    const others = [...document.body.children].filter((el): el is HTMLElement => el instanceof HTMLElement && el !== root.current && !el.inert);
    others.forEach((el) => (el.inert = true));
    const overflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    return () => {
      others.forEach((el) => (el.inert = false));
      document.documentElement.style.overflow = overflow;
    };
  }, [open, phone, hidden]);

  // Esc closes from every view (the chat panel also handles it, for the inline card).
  useEffect(() => {
    if (!open || hidden) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, hidden, close]);

  // On a hidden path (sign-in, admin…) nothing is shown; an open panel comes back when the reader returns.
  if (hidden) return null;

  const icon = compact || launcher === "icon";
  const panelBox = phone
    ? "fixed inset-0 z-50 flex flex-col bg-surface pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]"
    : "fixed bottom-[calc(1.25rem+3.75rem+env(safe-area-inset-bottom))] right-[max(1.25rem,env(safe-area-inset-right))] z-40 flex h-[min(40rem,calc(100dvh-7.5rem))] w-[min(25rem,calc(100vw-2.5rem))] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl motion-safe:animate-[ask-rise_.18s_ease-out]";
  return (
    // data-ask-dock: globals.css gives the footer room at the bottom, so its last row can scroll clear of the launcher.
    <div ref={root} data-ask-dock="" className="print:hidden">
      {open && (
        <div id="ask-blog-panel" role="dialog" aria-modal={phone} aria-labelledby="ask-blog-title" className={panelBox}>
          {view === "panel" && Panel ? (
            <Panel
              variant="float"
              headingId="ask-blog-title"
              copy={config.copy}
              maxQuestion={config.maxQuestion}
              conversation={config.conversation}
              context={context}
              onClose={close}
              onNavigate={phone ? () => setView("closed") : undefined}
            />
          ) : (
            <div className="p-5">
              <h2 id="ask-blog-title" className="sr-only">
                Ask the Blog
              </h2>
              {view === "signin" ? <SignInPrompt next={pathname} onClose={close} /> : view === "off" ? <p role="status" className="text-[0.9375rem] text-fg-muted">{OFF_MESSAGE}</p> : <p className="text-sm text-fg-subtle">Opening…</p>}
            </div>
          )}
        </div>
      )}
      {!(open && phone) && (
        <button
          ref={button}
          type="button"
          onClick={() => (open ? close() : void show())}
          onPointerEnter={() => void load()}
          onFocus={() => void load()}
          aria-expanded={open}
          aria-controls={open ? "ask-blog-panel" : undefined}
          aria-label={open ? "Close Ask the Blog" : icon ? config.copy.button : undefined}
          title={icon && !open ? config.copy.button : undefined}
          className={`fixed bottom-[max(1.25rem,env(safe-area-inset-bottom))] right-[max(1.25rem,env(safe-area-inset-right))] z-40 inline-flex h-12 items-center justify-center gap-2 rounded-full bg-accent font-semibold text-on-accent shadow-lg transition-[background-color,width,padding] hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${icon || open ? "w-12" : "pl-4 pr-5 text-sm"}`}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d={open ? "M6 6l12 12M18 6L6 18" : "M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"} />
          </svg>
          {!icon && !open && <span>{config.copy.button}</span>}
          {dot && !open && <span aria-hidden="true" className="absolute right-1 top-1 h-2.5 w-2.5 rounded-full border-2 border-accent bg-on-accent" />}
          {dot && !open && <span className="sr-only"> (your conversation is kept)</span>}
        </button>
      )}
    </div>
  );
}
