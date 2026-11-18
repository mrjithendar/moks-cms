"use client";

import { SIGNIN_EVENT, THREAD_KEY, type AskContext, type AskConversation } from "./types";

/**
 * The Ask the Blog conversation: one per tab, outside React, so an answer keeps streaming (and is kept) when the
 * reader closes the panel or moves to another page. Saved to sessionStorage when the admin keeps threads
 * (conversation.keepThread), so a reload keeps it too; closing the tab or "New chat" clears it. Nothing is stored on
 * the server beyond the question log the agent already keeps.
 */

export type Citation = { title: string; url: string; refs?: number[] };
export type Turn = {
  id: string;
  q: string;
  status: "streaming" | "done" | "stopped" | "error";
  /** Streamed text until the final event, then the guarded answer. Plain text with [n] markers, never HTML. */
  text: string;
  outcome?: string;
  citations: Citation[];
  related: Citation[];
  error?: string;
  /** Handle for Helpful / Not helpful (only when the agent logged the answer with one). */
  token?: string;
  feedback?: 1 | -1;
};

const MAX_TURNS = 20;
const HISTORY_ANSWER_CHARS = 600;

let turns: Turn[] = [];
let loaded = false;
let keep = true;
let controller: AbortController | null = null;
const listeners = new Set<() => void>();

function load() {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  if (!keep) return;
  try {
    const raw = window.sessionStorage.getItem(THREAD_KEY);
    const saved = raw ? (JSON.parse(raw) as Turn[]) : [];
    // An answer that was streaming when the page went away will never finish here.
    if (Array.isArray(saved)) turns = saved.slice(-MAX_TURNS).map((t) => (t.status === "streaming" ? { ...t, status: "stopped" } : t));
  } catch {
    turns = [];
  }
}

function save() {
  if (typeof window === "undefined") return;
  try {
    if (keep && turns.length) window.sessionStorage.setItem(THREAD_KEY, JSON.stringify(turns));
    else window.sessionStorage.removeItem(THREAD_KEY);
  } catch {
    /* storage blocked (private mode): the thread still lives until the page is reloaded */
  }
}

function set(next: Turn[]) {
  turns = next.slice(-MAX_TURNS);
  save();
  for (const l of listeners) l();
}

function patch(id: string, p: Partial<Turn> | ((t: Turn) => Partial<Turn>)) {
  set(turns.map((t) => (t.id === id ? { ...t, ...(typeof p === "function" ? p(t) : p) } : t)));
}

export const thread = {
  /** Apply the admin's "keep the conversation" switch before the first read. */
  configure(keepThread: boolean) {
    keep = keepThread;
    if (!keep) {
      try {
        window.sessionStorage.removeItem(THREAD_KEY);
      } catch {
        /* ignore */
      }
    }
    load();
  },
  get: () => {
    load();
    return turns;
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
  busy: () => turns.some((t) => t.status === "streaming"),
  clear() {
    controller?.abort();
    set([]);
  },
  stop() {
    controller?.abort();
  },
  rate(id: string, helpful: boolean) {
    const t = turns.find((x) => x.id === id);
    if (!t?.token) return;
    patch(id, { feedback: helpful ? 1 : -1 });
    void fetch("/api/ask/feedback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: t.token, helpful }) }).catch(() => {});
  },
  send,
};

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

const OFF = "Ask the Blog is switched off right now. Please use search instead.";
const DOWN = "The assistant is unavailable right now. Please try again in a moment or use search.";

/** The earlier turns the agent may use to understand a follow-up: answered ones only, newest last. */
export function historyFor(all: Turn[], conversation: AskConversation, maxQuestion: number) {
  if (!conversation.followUps) return [];
  return all
    .filter((t) => t.status === "done" && (t.outcome === "answered" || t.outcome === "fallback"))
    .slice(-conversation.turns)
    .map((t) => ({ q: t.q.slice(0, maxQuestion), a: t.outcome === "answered" ? t.text.slice(0, HISTORY_ANSWER_CHARS) : "" }));
}

async function send(question: string, o: { conversation: AskConversation; context: AskContext; maxQuestion: number }) {
  const q = question.trim().slice(0, o.maxQuestion);
  if (!q || thread.busy()) return;
  const history = historyFor(thread.get(), o.conversation, o.maxQuestion);
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  set([...turns, { id, q, status: "streaming", text: "", citations: [], related: [] }]);
  const ctl = new AbortController();
  controller = ctl;
  const body: Record<string, unknown> = { question: q };
  if (history.length) body.history = history;
  if (o.conversation.pageContext && o.context) body.context = { slug: o.context.slug };
  try {
    const res = await fetch("/api/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal });
    if (res.status === 401) {
      set(turns.filter((t) => t.id !== id));
      window.dispatchEvent(new CustomEvent(SIGNIN_EVENT));
      return;
    }
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      patch(id, { status: "error", error: res.status === 404 ? OFF : (j.error ?? DOWN) });
      return;
    }
    let finished = false;
    await readSse(res, (name, data) => {
      if (name === "delta") patch(id, (t) => ({ text: t.text + (data as { text: string }).text }));
      if (name === "final") {
        finished = true;
        const f = data as { outcome: string; answer: string; citations?: Citation[]; related?: Citation[]; feedback_token?: string };
        if (f.outcome === "disabled") patch(id, { status: "error", error: OFF });
        else if (f.outcome === "error") patch(id, { status: "error", error: f.answer || DOWN });
        else patch(id, { status: "done", outcome: f.outcome, text: f.answer, citations: f.citations ?? [], related: f.related ?? [], token: f.feedback_token });
      }
    });
    if (!finished) patch(id, { status: "error", error: DOWN });
  } catch {
    patch(id, ctl.signal.aborted ? { status: "stopped" } : { status: "error", error: DOWN });
  } finally {
    if (controller === ctl) controller = null;
  }
}
