"use client";

import { useEffect, useId, useRef, useState } from "react";

type Citation = { title: string; url: string };
type Final = { outcome: string; answer: string; citations: Citation[]; related?: Citation[] };

/** Minimal SSE reader (POST, so EventSource does not apply). Calls onEvent per complete event. */
async function readSse(res: Response, onEvent: (name: string, data: unknown) => void) {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) !== -1) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const name = /^event: (.+)$/m.exec(chunk)?.[1] ?? "message";
      const data = /^data: (.+)$/m.exec(chunk)?.[1];
      if (data) onEvent(name, JSON.parse(data));
    }
  }
}

/** Plain text with [n] markers; citations are rendered as links below (never HTML from the model). */
function AnswerText({ text }: { text: string }) {
  return <p className="whitespace-pre-wrap text-[0.9375rem] leading-7 text-fg">{text}</p>;
}

export type PanelProps = {
  onClose: () => void;
  /** The server refused the question because the reader is not signed in (signed-in-only mode, or the session ended). */
  onNeedSignIn: () => void;
  copy: { placeholder: string; disclaimer: string; examples: string[] };
  maxQuestion: number;
};

export function AskPanel({ onClose, onNeedSignIn, copy, maxQuestion }: PanelProps) {
  const id = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [streamed, setStreamed] = useState("");
  const [final, setFinal] = useState<Final | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function ask(e: React.FormEvent, text = q) {
    e.preventDefault();
    const question = text.trim();
    if (!question || busy) return;
    setBusy(true);
    setStreamed("");
    setFinal(null);
    setError(null);
    try {
      const res = await fetch("/api/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question }) });
      if (res.status === 401) {
        onNeedSignIn();
        return;
      }
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? "The assistant is unavailable right now.");
        return;
      }
      await readSse(res, (name, data) => {
        if (name === "delta") setStreamed((s) => s + (data as { text: string }).text);
        if (name === "final") {
          const f = data as Final;
          // Switched off between the page being cached and this question (admin toggle or the agent's kill switch).
          if (f.outcome === "disabled") setError("Ask the Blog is switched off right now. Please use search instead.");
          else setFinal(f);
        }
      });
    } catch {
      setError("The assistant is unavailable right now. Please use search instead.");
    } finally {
      setBusy(false);
    }
  }

  const answer = final?.answer ?? streamed;
  const links = final ? (final.citations.length ? final.citations : (final.related ?? [])) : [];
  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <h2 className="text-lg font-semibold text-fg">Ask the Blog</h2>
        <button type="button" onClick={onClose} className="-mr-2 -mt-1 inline-flex h-9 w-9 items-center justify-center rounded-lg text-fg-muted hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-accent" aria-label="Close Ask the Blog">
          ✕
        </button>
      </div>
      <form onSubmit={ask} className="mt-3 flex flex-col gap-3">
        <label htmlFor={`${id}-q`} className="text-sm text-fg-muted">
          Your question about the articles on this site
        </label>
        <textarea
          id={`${id}-q`}
          ref={input}
          value={q}
          onChange={(e) => setQ(e.target.value.slice(0, maxQuestion))}
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), void ask(e))}
          rows={2}
          maxLength={maxQuestion}
          required
          className="w-full resize-y rounded-lg border border-line bg-canvas px-3 py-2 text-[0.9375rem] text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          placeholder={copy.placeholder}
        />
        {copy.examples.length > 0 && !answer && !busy && (
          <ul aria-label="Example questions" className="flex flex-wrap gap-2">
            {copy.examples.map((x) => (
              <li key={x}>
                <button
                  type="button"
                  onClick={(e) => {
                    setQ(x);
                    void ask(e, x);
                  }}
                  className="rounded-full border border-line px-3 py-1.5 text-left text-sm text-fg-muted hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-accent"
                >
                  {x}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-fg-subtle">{q.length}/{maxQuestion}</span>
          <button type="submit" className="inline-flex h-10 items-center justify-center rounded-lg bg-accent px-4 text-sm font-semibold text-on-accent transition-colors hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60" disabled={busy || !q.trim()}>
            {busy ? "Answering…" : "Ask"}
          </button>
        </div>
      </form>
      <div aria-live="polite" aria-busy={busy} className="mt-4 space-y-3">
        {error && <p className="text-sm text-red-700 dark:text-red-400">{error}</p>}
        {answer && <AnswerText text={answer} />}
        {links.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold text-fg">{final?.citations.length ? "Sources on this site" : "Related articles"}</h3>
            <ol className="mt-2 space-y-1.5 text-sm">
              {links.map((c, i) => (
                <li key={c.url} className="flex gap-2">
                  {final?.citations.length ? <span className="font-mono text-fg-subtle">[{i + 1}]</span> : null}
                  <a href={c.url} className="link [overflow-wrap:anywhere]">
                    {c.title}
                  </a>
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
      <p className="mt-4 text-xs text-fg-subtle">{copy.disclaimer}</p>
    </div>
  );
}
