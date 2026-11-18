"use client";

import Link from "next/link";
import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { thread, type Citation, type Turn } from "./thread";
import type { AskContext, AskConversation, AskCopy } from "./types";

export type PanelProps = {
  copy: AskCopy;
  maxQuestion: number;
  conversation: AskConversation;
  context: AskContext;
  onClose: () => void;
  /** "float": the corner panel or the phone sheet (fills its parent); "inline": inside the card on the page. */
  variant: "float" | "inline";
  /** Called when the reader follows a source link (the phone sheet closes so the article is visible). */
  onNavigate?: () => void;
  headingId?: string;
};

const NO_TURNS: Turn[] = [];
const CITE = /\[(\d{1,2}(?:\s*[,;]\s*\d{1,2})*)\]/g;
const iconBtn = "inline-flex h-8 w-8 items-center justify-center rounded-lg text-fg-muted transition-colors hover:bg-surface-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-accent";

function Svg({ d, filled = false }: { d: string; filled?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4" fill={filled ? "currentColor" : "none"} stroke={filled ? "none" : "currentColor"} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}
const ICONS = {
  plus: "M12 5v14M5 12h14",
  close: "M6 6l12 12M18 6L6 18",
  send: "M12 19V5M5 12l7-7 7 7",
  stop: "M7 7h10v10H7z",
  copy: "M9 9h11v11H9zM5 15V5a2 2 0 0 1 2-2h10",
  up: "M7 10v11M2 12v7a2 2 0 0 0 2 2h3V10H4a2 2 0 0 0-2 2zm5-2 4-7a3 3 0 0 1 3 3v4h5.5a2 2 0 0 1 2 2.3l-1.4 8A2 2 0 0 1 18.1 21H7",
  down: "M17 14V3m5 9V5a2 2 0 0 0-2-2h-3v11h3a2 2 0 0 0 2-2zm-5 2-4 7a3 3 0 0 1-3-3v-4H4.5a2 2 0 0 1-2-2.3l1.4-8A2 2 0 0 1 5.9 3H17",
};

/** A site link through next/link (the panel and the conversation stay mounted); anything else as a plain anchor. */
function SiteLink({ href, children, className, onNavigate, label }: { href: string; children: ReactNode; className?: string; onNavigate?: () => void; label?: string }) {
  return href.startsWith("/") && !href.startsWith("//") ? (
    <Link href={href} className={className} onClick={onNavigate} aria-label={label}>
      {children}
    </Link>
  ) : (
    <a href={href} className={className} aria-label={label}>
      {children}
    </a>
  );
}

/**
 * The answer: plain text (never HTML from the model) whose [n] markers become numbered links to the cited section.
 * The agent tells which markers point at which citation (`refs`); a marker it does not map (an answer cached before
 * refs existed, or text still streaming) stays as text.
 */
function AnswerText({ turn, onNavigate }: { turn: Turn; onNavigate?: () => void }) {
  const byRef = new Map<number, number>();
  turn.citations.forEach((c, i) => c.refs?.forEach((r) => byRef.set(r, i)));
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of turn.text.matchAll(CITE)) {
    const idx = (m[1] ?? "").split(/[,;]/).map((n) => byRef.get(Number(n.trim())));
    const cited = [...new Set(idx)].map((i) => (i === undefined ? undefined : { i, c: turn.citations[i] }));
    if (!cited.length || cited.some((x) => !x?.c)) continue;
    out.push(turn.text.slice(last, m.index));
    out.push(
      <Fragment key={m.index}>
        {(cited as { i: number; c: Citation }[]).map(({ i, c }) => (
          <SiteLink key={i} href={c.url} onNavigate={onNavigate} label={`Source ${i + 1}: ${c.title}`} className="mx-0.5 inline-flex h-[1.15rem] min-w-[1.15rem] items-center justify-center rounded-[5px] border border-line-strong bg-surface-sunken px-1 align-[1px] font-mono text-[0.68rem] font-medium text-accent-text no-underline hover:border-accent">
            {i + 1}
          </SiteLink>
        ))}
      </Fragment>,
    );
    last = m.index + m[0].length;
  }
  out.push(turn.text.slice(last));
  return <p className="whitespace-pre-wrap text-[0.9rem] leading-relaxed text-fg">{out}</p>;
}

function Sources({ items, numbered, onNavigate }: { items: Citation[]; numbered: boolean; onNavigate?: () => void }) {
  return (
    <ol className="grid gap-1.5" aria-label={numbered ? "Sources on this site" : "Related articles"}>
      {items.map((c, i) => {
        const [title, section] = c.title.split(" › ");
        return (
          <li key={c.url}>
            <SiteLink href={c.url} onNavigate={onNavigate} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 rounded-lg border border-line bg-canvas px-2.5 py-2 no-underline transition-colors hover:border-line-strong">
              <span className="row-span-2 pt-px font-mono text-[0.7rem] text-fg-subtle">{numbered ? i + 1 : "→"}</span>
              <span className="truncate text-[0.8rem] font-semibold text-fg">{title}</span>
              <span className="truncate text-[0.75rem] text-fg-subtle">{section ?? "Article"}</span>
            </SiteLink>
          </li>
        );
      })}
    </ol>
  );
}

function TurnView({ turn, conversation, onNavigate }: { turn: Turn; conversation: AskConversation; onNavigate?: () => void }) {
  const [copied, setCopied] = useState(false);
  const answered = turn.status === "done" && turn.outcome === "answered";
  const links = turn.citations.length ? turn.citations : turn.related;
  const copy = async () => {
    const sources = turn.citations.map((c, i) => `[${i + 1}] ${c.title} — ${new URL(c.url, window.location.origin).href}`).join("\n");
    try {
      await navigator.clipboard.writeText(sources ? `${turn.text}\n\n${sources}` : turn.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard refused: nothing to do */
    }
  };
  return (
    <li className="grid gap-2">
      <p className="max-w-[85%] justify-self-end rounded-2xl rounded-br-md border border-accent/20 bg-accent-soft px-3 py-2 text-[0.875rem] leading-snug text-fg [overflow-wrap:anywhere]">{turn.q}</p>
      <div className="grid gap-2">
        {turn.text ? <AnswerText turn={turn} onNavigate={onNavigate} /> : turn.status === "streaming" ? <p className="text-[0.85rem] text-fg-subtle">Looking through the articles…</p> : null}
        {turn.status === "error" && <p className="rounded-lg border border-line bg-surface-muted px-3 py-2 text-[0.85rem] text-fg-muted">{turn.error}</p>}
        {turn.status === "stopped" && <p className="text-xs text-fg-subtle">Stopped.</p>}
        {turn.status === "done" && links.length > 0 && (
          <div className="grid gap-1.5">
            {!turn.citations.length && <span className="text-xs text-fg-subtle">Related articles</span>}
            <Sources items={links} numbered={turn.citations.length > 0} onNavigate={onNavigate} />
          </div>
        )}
        {answered && (
          <div className="-ml-1.5 flex items-center gap-0.5">
            <button type="button" onClick={copy} className={iconBtn} aria-label={copied ? "Copied" : "Copy answer"} title={copied ? "Copied" : "Copy answer"}>
              <Svg d={ICONS.copy} />
            </button>
            {conversation.feedback && turn.token && (
              <>
                <button type="button" onClick={() => thread.rate(turn.id, true)} className={`${iconBtn} ${turn.feedback === 1 ? "text-accent-text" : ""}`} aria-pressed={turn.feedback === 1} aria-label="Helpful" title="Helpful">
                  <Svg d={ICONS.up} />
                </button>
                <button type="button" onClick={() => thread.rate(turn.id, false)} className={`${iconBtn} ${turn.feedback === -1 ? "text-accent-text" : ""}`} aria-pressed={turn.feedback === -1} aria-label="Not helpful" title="Not helpful">
                  <Svg d={ICONS.down} />
                </button>
                {turn.feedback && <span className="ml-1 text-xs text-fg-subtle">Thanks for the feedback.</span>}
              </>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

export function AskPanel({ copy, maxQuestion, conversation, context, onClose, variant, onNavigate, headingId }: PanelProps) {
  const id = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [q, setQ] = useState("");
  // configure() runs before the first read, so a disabled "keep the conversation" never loads a stale thread.
  const [ready] = useState(() => {
    thread.configure(conversation.keepThread);
    return true;
  });
  const turns = useSyncExternalStore(thread.subscribe, thread.get, () => NO_TURNS);
  const busy = turns.some((t) => t.status === "streaming");
  const lastDone = [...turns].reverse().find((t) => t.status !== "streaming");

  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  // Screen readers hear the finished answer once, not every streamed piece.
  const announce = lastDone?.status === "done" ? lastDone.text : "";
  // Follow the answer as it streams, unless the reader has scrolled up to read something.
  useLayoutEffect(() => {
    const el = log.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [turns]);
  const placeholder = turns.length ? (conversation.followUps ? "Ask a follow-up…" : "Ask another question…") : copy.placeholder;
  // Grow the question box with its text (or a wrapping placeholder), up to about six lines.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 150)}px`;
  }, [q, placeholder]);

  const send = (text = q) => {
    if (!text.trim() || busy) return;
    stick.current = true;
    void thread.send(text, { conversation, context, maxQuestion });
    setQ("");
  };

  const float = variant === "float";
  const near = q.length > maxQuestion * 0.8;
  return (
    <div className={float ? "flex h-full min-h-0 flex-col" : "flex flex-col"}>
      <div className={`flex items-center gap-1 ${float ? "border-b border-line py-2.5 pl-4 pr-2.5" : ""}`}>
        <h2 id={headingId} className="flex-1 text-[0.95rem] font-semibold text-fg">
          Ask the Blog
        </h2>
        {ready && turns.length > 0 && (
          <button type="button" onClick={() => thread.clear()} className={iconBtn} aria-label="New chat" title="New chat">
            <Svg d={ICONS.plus} />
          </button>
        )}
        <button type="button" onClick={onClose} className={iconBtn} aria-label="Close Ask the Blog">
          <Svg d={ICONS.close} />
        </button>
      </div>
      {context && conversation.pageContext && (
        <p className={`flex min-w-0 items-center rounded-lg border border-line bg-surface-muted px-2.5 py-1.5 text-xs text-fg-muted ${float ? "mx-3.5 mt-2.5" : "mt-3"}`}>
          <span className="truncate">
            Reading: <span className="font-semibold text-fg">{context.title}</span>
          </span>
        </p>
      )}
      <div
        ref={log}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className={float ? "min-h-0 flex-1 overflow-y-auto overscroll-contain px-3.5 py-3.5" : "mt-3 max-h-[28rem] overflow-y-auto py-1"}
      >
        {turns.length === 0 ? (
          <div className="grid gap-3">
            <p className="text-[0.875rem] text-fg-muted">{copy.intro}</p>
            {copy.examples.length > 0 && (
              <ul aria-label="Example questions" className="flex flex-wrap gap-1.5">
                {copy.examples.map((x) => (
                  <li key={x}>
                    <button type="button" onClick={() => send(x)} className="rounded-full border border-line bg-surface px-3 py-1.5 text-left text-[0.8rem] text-fg-muted transition-colors hover:bg-surface-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-accent">
                      {x}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <ol aria-label="Conversation" className="grid gap-5">
            {turns.map((t) => (
              <TurnView key={t.id} turn={t} conversation={conversation} onNavigate={onNavigate} />
            ))}
          </ol>
        )}
      </div>
      <p aria-live="polite" className="sr-only">
        {announce}
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        className={`grid gap-1.5 ${float ? "border-t border-line px-3 pb-2.5 pt-2.5" : "mt-3"}`}
      >
        <div className="flex items-end gap-2 rounded-xl border border-line-strong bg-canvas py-1.5 pl-3 pr-1.5 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20">
          <label htmlFor={`${id}-q`} className="sr-only">
            Your question about the articles on this site
          </label>
          <textarea
            id={`${id}-q`}
            ref={input}
            value={q}
            rows={1}
            maxLength={maxQuestion}
            onChange={(e) => setQ(e.target.value.slice(0, maxQuestion))}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={placeholder}
            className="min-w-0 flex-1 resize-none bg-transparent py-1 text-[0.875rem] leading-snug text-fg placeholder:text-fg-subtle focus:outline-none"
          />
          {busy ? (
            <button type="button" onClick={() => thread.stop()} className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-fg text-canvas focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent" aria-label="Stop answering">
              <Svg d={ICONS.stop} filled />
            </button>
          ) : (
            <button type="submit" disabled={!q.trim()} className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent text-on-accent transition-colors hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50" aria-label="Ask">
              <Svg d={ICONS.send} />
            </button>
          )}
        </div>
        <div className="flex justify-between gap-3 text-[0.7rem] leading-snug text-fg-subtle">
          <span>{copy.disclaimer}</span>
          {near && (
            <span className="shrink-0 tabular-nums">
              {q.length}/{maxQuestion}
            </span>
          )}
        </div>
      </form>
    </div>
  );
}
