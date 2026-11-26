"use client";

import { useRouter } from "next/navigation";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { formatDuration, formatTokens, formatUsd } from "@/lib/crewai/format";
import { Facts } from "./Facts";
import { RunStatusIcon } from "./RunStatusIcon";

export type LogLine = { id: number; step: string | null; level: string; logger: string | null; event: string | null; message: string; context: Record<string, unknown>; at: string };
export type StepView = { step: string; status: string; seconds: number | null; error: string | null; count: number };
type Transcript = { agent: string | null; model: string | null; outcome: string; inputTokens: number; outputTokens: number; costUsd: number; latencyMs: number | null; system: string | null; prompt: string | null; response: string | null; error: string | null };
type Group = { key: string; title: string; status: string; seconds: number | null; error: string | null; count: number; lines: LogLine[] };

const SETUP = "\u0000setup";
const COMPLETE = "\u0000complete";
const RANK: Record<string, number> = { debug: 0, info: 1, warning: 2, error: 3 };
const LEVEL_TONE: Record<string, string> = { error: "text-red-700 dark:text-red-300", warning: "text-amber-800 dark:text-amber-200", info: "text-fg", debug: "text-fg-subtle" };
const LEVEL_BG: Record<string, string> = { error: "bg-red-50 dark:bg-red-500/10", warning: "bg-amber-50/70 dark:bg-amber-500/10" };
const FINISHED = ["succeeded", "failed", "cancelled", "paused_budget"];
const MAX_LINES = 20_000;

/** Lines → groups in run order: "Set up run" (before the first step), one group per step, "Complete run". */
function groupLines(lines: LogLine[], steps: StepView[], runStatus: string): Group[] {
  const groups = new Map<string, Group>();
  const add = (key: string, title: string, s?: StepView) => {
    if (!groups.has(key)) groups.set(key, { key, title, status: s?.status ?? "pending", seconds: s?.seconds ?? null, error: s?.error ?? null, count: s?.count ?? 1, lines: [] });
    return groups.get(key)!;
  };
  const byName = new Map(steps.map((s) => [s.step, s]));
  let stepped = false;
  const setup = add(SETUP, "Set up run");
  setup.status = "succeeded";
  for (const s of steps) add(`step:${s.step}`, s.step, s);
  for (const l of lines) {
    if (l.step) {
      stepped = true;
      add(`step:${l.step}`, l.step, byName.get(l.step)).lines.push(l);
    } else (stepped ? add(COMPLETE, "Complete run") : setup).lines.push(l);
  }
  // Like GitHub's "Complete job": the wrap-up itself succeeded; a failure shows on the step where it happened.
  if (FINISHED.includes(runStatus)) add(COMPLETE, "Complete run").status = runStatus === "cancelled" ? "cancelled" : "succeeded";
  const out = [...groups.values()];
  const complete = out.findIndex((g) => g.key === COMPLETE);
  if (complete >= 0) out.push(...out.splice(complete, 1));
  return out.filter((g) => g.key !== SETUP || g.lines.length > 0);
}

function highlight(text: string, q: string): ReactNode {
  if (!q) return text;
  const parts: ReactNode[] = [];
  const lower = text.toLowerCase();
  let i = 0;
  for (let at = lower.indexOf(q); at >= 0 && parts.length < 200; at = lower.indexOf(q, at + q.length)) {
    parts.push(text.slice(i, at), <mark key={at} className="rounded-sm bg-amber-200 text-fg dark:bg-amber-400/40">{text.slice(at, at + q.length)}</mark>);
    i = at + q.length;
  }
  parts.push(text.slice(i));
  return parts;
}

function time(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString("en-GB", { hour12: false }) + `.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

/** What a line says on screen. A model call's numbers are its badges, and its agent its chip, so the text is short. */
function lineText(l: LogLine): string {
  if (l.event !== "llm_call") return l.message;
  const outcome = typeof l.context.outcome === "string" && l.context.outcome !== "ok" ? ` ${l.context.outcome}` : "";
  return `model call${outcome} · ${String(l.context.model ?? "")}`;
}

/** Facts worth a badge on known events (the rest is in the line's details). */
function badges(l: LogLine): string[] {
  const c = l.context;
  if (l.event === "llm_call") return [`${formatTokens(Number(c.input_tokens ?? 0))} in`, `${formatTokens(Number(c.output_tokens ?? 0))} out`, formatUsd(Number(c.cost_usd ?? 0)), formatDuration(Number(c.seconds ?? 0) * 1000)];
  if (l.event === "crew_tool_call" || l.event === "webapp_call") return [formatDuration(Number(c.seconds ?? 0) * 1000)];
  if (l.event === "crew_task" || l.event === "flow_step") return [formatDuration(Number(c.seconds ?? 0) * 1000), ...(c.tokens ? [`${formatTokens(Number(c.tokens))} tokens`] : [])];
  if (l.event === "crew_finished") return [String(c.status ?? ""), `${formatTokens(Number(c.tokens ?? 0))} tokens`, formatUsd(Number(c.cost_usd ?? 0))];
  return [];
}

function TranscriptPanel({ id }: { id: number }) {
  const [state, setState] = useState<{ call?: Transcript; error?: string }>({});
  const [tab, setTab] = useState<"prompt" | "system" | "response">("response");
  useEffect(() => {
    let off = false;
    fetch(`/api/admin/crewai/calls/${id}`)
      .then(async (r) => {
        const d = (await r.json().catch(() => ({}))) as { call?: Transcript; error?: string };
        if (!off) setState(r.ok ? { call: d.call } : { error: d.error ?? `HTTP ${r.status}` });
      })
      .catch(() => !off && setState({ error: "Network error." }));
    return () => {
      off = true;
    };
  }, [id]);
  if (state.error) return <p className="px-3 py-2 font-sans text-xs text-fg-muted">{state.error}</p>;
  const c = state.call;
  if (!c) return <p className="px-3 py-2 font-sans text-xs text-fg-subtle">Loading transcript…</p>;
  const text = tab === "prompt" ? c.prompt : tab === "system" ? c.system : (c.response ?? c.error);
  return (
    <div className="my-1 rounded-lg border border-line bg-surface font-sans">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2 text-xs text-fg-muted">
        <span className="font-semibold text-fg">{c.agent ?? "model"}</span>
        <span>{c.model}</span>
        <span>{c.inputTokens.toLocaleString("en")} in · {c.outputTokens.toLocaleString("en")} out · {formatUsd(c.costUsd)} · {formatDuration(c.latencyMs)}</span>
        {c.outcome !== "ok" && <span className="rounded bg-red-50 px-1.5 text-red-700 dark:bg-red-500/10 dark:text-red-300">{c.outcome}</span>}
        <span className="ml-auto inline-flex rounded-md border border-line p-0.5" role="tablist" aria-label="Transcript part">
          {(["response", "prompt", "system"] as const).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`rounded px-2 py-0.5 ${tab === t ? "bg-surface-sunken font-semibold text-fg" : ""}`}>
              {t === "response" ? "Answer" : t === "prompt" ? "Prompt" : "System"}
            </button>
          ))}
        </span>
        <button type="button" className="rounded border border-line px-2 py-0.5 hover:bg-surface-muted" onClick={() => void navigator.clipboard?.writeText(text ?? "")}>Copy</button>
      </div>
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap p-3 font-mono text-xs leading-5 text-fg [overflow-wrap:anywhere]">{text || "—"}</pre>
    </div>
  );
}

/**
 * The run's log, like a GitHub Actions job log: one collapsible group per step (status, time, line count), numbered
 * lines that link (#L<id>), search with highlights, a level filter, timestamps, follow while live, details per line and
 * the transcript of each model call. Live runs stream from /api/admin/crewai/runs/{id}/logs (server-sent events).
 */
export function LogViewer({ runId, initial, live, steps, runStatus, hasMore }: { runId: string; initial: LogLine[]; live: boolean; steps: StepView[]; runStatus: string; hasMore: boolean }) {
  const router = useRouter();
  const [logs, setLogs] = useState<LogLine[]>(initial);
  const [status, setStatus] = useState(runStatus);
  const [more, setMore] = useState(hasMore);
  const [level, setLevel] = useState("info");
  const [query, setQuery] = useState("");
  const [stamps, setStamps] = useState(false);
  const [follow, setFollow] = useState(true);
  const [open, setOpen] = useState<Set<string> | null>(null); // null: the default (failed / running groups)
  const [details, setDetails] = useState<Set<number>>(new Set());
  const [calls, setCalls] = useState<Set<number>>(new Set());
  const [target, setTarget] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const lastId = useRef(initial.length ? initial[initial.length - 1]!.id : 0);
  const isLive = live && !FINISHED.includes(status);

  // The server ends a stream after ~5 minutes even while the run goes on: then a new one carries on from the last line
  // (`stream` counts them). Without it a long run's log stopped at its first 5 minutes until the page was reloaded.
  const [stream, setStream] = useState(0);
  useEffect(() => {
    if (!live) return;
    let going = false; // the stream's last status: queued or running
    const es = new EventSource(`/api/admin/crewai/runs/${runId}/logs?after=${lastId.current}`);
    es.addEventListener("log", (e) => {
      const l = JSON.parse((e as MessageEvent).data) as LogLine;
      if (l.id <= lastId.current) return;
      lastId.current = l.id;
      setLogs((x) => (x.length >= MAX_LINES ? x : [...x, l]));
    });
    es.addEventListener("status", (e) => {
      const s = (JSON.parse((e as MessageEvent).data) as { status: string }).status;
      going = s === "queued" || s === "running";
      setStatus(s);
    });
    es.addEventListener("end", () => {
      es.close();
      router.refresh();
      if (going) setStream((n) => n + 1);
    });
    return () => es.close();
  }, [live, runId, router, stream]);

  // #L<id> in the URL: open its group and scroll to it.
  useEffect(() => {
    const read = () => {
      const m = /^#L(\d+)$/.exec(window.location.hash);
      setTarget(m ? Number(m[1]) : null);
    };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);

  const q = query.trim().toLowerCase();
  const shown = useMemo(() => logs.filter((l) => (RANK[l.level] ?? 1) >= (RANK[level] ?? 0) && (!q || l.message.toLowerCase().includes(q))), [logs, level, q]);
  const groups = useMemo(() => groupLines(shown, steps, status), [shown, steps, status]);
  const matches = q ? shown.length : 0;

  const isOpen = useCallback(
    (g: Group) => {
      if (q && g.lines.length) return true;
      if (target != null && g.lines.some((l) => l.id === target)) return true;
      if (open) return open.has(g.key);
      return g.status === "failed" || g.status === "running" || (isLive && g === groups[groups.length - 1]);
    },
    [open, q, target, isLive, groups],
  );
  const toggle = (g: Group) => setOpen(new Set([...groups.filter((x) => (x.key === g.key ? !isOpen(x) : isOpen(x))).map((x) => x.key)]));

  useEffect(() => {
    if (target == null) return;
    document.getElementById(`L${target}`)?.scrollIntoView({ block: "center" });
  }, [target, groups]);

  useEffect(() => {
    if (isLive && follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [logs.length, isLive, follow]);

  const loadMore = async () => {
    const r = await fetch(`/api/admin/crewai/runs/${runId}/logs?format=json&after=${lastId.current}`);
    const d = (await r.json().catch(() => ({}))) as { logs?: LogLine[] };
    const rows = d.logs ?? [];
    if (rows.length) lastId.current = rows[rows.length - 1]!.id;
    setLogs((x) => [...x, ...rows]);
    setMore(rows.length === 500);
  };

  const flip = (set: Set<number>, id: number) => {
    const n = new Set(set);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  };

  return (
    <section aria-labelledby="run-log" className="overflow-hidden rounded-xl border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-surface-muted px-3 py-2">
        <h2 id="run-log" className="mr-1 text-sm font-semibold text-fg">
          Log
          {isLive && (
            <span className="ml-2 inline-flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-300">
              <span className="h-2 w-2 motion-safe:animate-pulse rounded-full bg-emerald-500" aria-hidden="true" />
              live
            </span>
          )}
        </h2>
        <label className="relative min-w-0 flex-1 basis-48">
          <span className="sr-only">Search the log</span>
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search logs" className="min-h-9 w-full rounded-md border border-line bg-surface px-3 text-sm" />
          {q && <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-fg-subtle" aria-live="polite">{matches} {matches === 1 ? "match" : "matches"}</span>}
        </label>
        <label className="flex items-center gap-1.5 text-xs text-fg-muted">
          Level
          <select value={level} onChange={(e) => setLevel(e.target.value)} className="min-h-9 rounded-md border border-line bg-surface px-2 text-sm">
            <option value="debug">Everything</option>
            <option value="info">Info and up</option>
            <option value="warning">Warnings and errors</option>
            <option value="error">Errors</option>
          </select>
        </label>
        <label className="flex min-h-9 items-center gap-1.5 text-xs text-fg-muted">
          <input type="checkbox" checked={stamps} onChange={(e) => setStamps(e.target.checked)} /> Timestamps
        </label>
        {isLive && (
          <label className="flex min-h-9 items-center gap-1.5 text-xs text-fg-muted">
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow
          </label>
        )}
        <span className="flex flex-wrap gap-1 text-xs">
          <button type="button" className="min-h-9 rounded-md px-2 text-fg-muted hover:bg-surface-sunken hover:text-fg" onClick={() => setOpen(new Set(groups.map((g) => g.key)))}>Expand all</button>
          <button type="button" className="min-h-9 rounded-md px-2 text-fg-muted hover:bg-surface-sunken hover:text-fg" onClick={() => setOpen(new Set())}>Collapse all</button>
          <a href={`/api/admin/crewai/runs/${runId}/logs?format=text`} className="inline-flex min-h-9 items-center rounded-md px-2 text-fg-muted hover:bg-surface-sunken hover:text-fg" download>Download</a>
        </span>
      </div>
      <div ref={box} className="max-h-[75vh] overflow-auto">
        {groups.length === 0 && <p className="p-4 text-sm text-fg-muted">{isLive ? "Waiting for the first log line…" : "No log lines were recorded for this run."}</p>}
        {groups.map((g) => {
          const expanded = isOpen(g);
          const errors = g.lines.filter((l) => l.level === "error").length;
          return (
            <div key={g.key} className="border-b border-line last:border-b-0">
              <button type="button" onClick={() => toggle(g)} aria-expanded={expanded} className="flex min-h-10 w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-surface-muted">
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" className={`shrink-0 text-fg-subtle transition-transform ${expanded ? "rotate-90" : ""}`}>
                  <path d="M4 2.5 7.5 6 4 9.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
                <RunStatusIcon status={g.status} />
                <span className={`min-w-0 flex-1 truncate ${g.key.startsWith("step:") ? "font-mono" : "font-medium"} text-fg`}>
                  {g.title}
                  {g.count > 1 ? <span className="ml-1 text-fg-subtle">×{g.count}</span> : null}
                </span>
                {errors > 0 && <span className="rounded-full bg-red-50 px-2 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-300">{errors} error{errors === 1 ? "" : "s"}</span>}
                <span className="text-xs tabular-nums text-fg-subtle">{g.lines.length} line{g.lines.length === 1 ? "" : "s"}</span>
                <span className="w-16 text-right text-xs tabular-nums text-fg-subtle">{g.seconds != null ? formatDuration(g.seconds * 1000) : ""}</span>
              </button>
              {expanded && (
                <div className="bg-surface-muted/50 pb-2 font-mono text-xs leading-5">
                  {g.error && g.status !== "succeeded" && <p className="mx-3 mb-1 rounded-md border border-red-200 bg-red-50 px-3 py-1.5 font-sans text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200 [overflow-wrap:anywhere]">{g.error}</p>}
                  {g.lines.length === 0 && <p className="px-10 py-1 font-sans text-fg-subtle">{g.status === "pending" ? "This step did not run." : "No log lines at this level."}</p>}
                  {g.lines.map((l, i) => {
                    const ctxKeys = Object.keys(l.context).filter((k) => k !== "trace_id");
                    const callId = l.event === "llm_call" && l.context.call_id != null ? Number(l.context.call_id) : null;
                    const agent = typeof l.context.agent === "string" ? l.context.agent : null;
                    return (
                      <Fragment key={l.id}>
                        <div id={`L${l.id}`} className={`group flex items-start gap-2 px-3 ${LEVEL_BG[l.level] ?? ""} ${target === l.id ? "bg-amber-100 dark:bg-amber-500/20" : "hover:bg-surface-sunken"}`}>
                          <a href={`#L${l.id}`} className="w-10 shrink-0 select-none text-right tabular-nums text-fg-subtle hover:text-fg hover:underline" aria-label={`Line ${i + 1}`}>{i + 1}</a>
                          {stamps && <span className="shrink-0 select-none tabular-nums text-fg-subtle">{time(l.at)}</span>}
                          <span className={`min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere] ${LEVEL_TONE[l.level] ?? ""}`}>
                            {(l.level === "error" || l.level === "warning") && <span className="mr-1 font-semibold uppercase">{l.level === "error" ? "Error:" : "Warning:"}</span>}
                            {agent && <span className="mr-1 rounded bg-accent-soft px-1 font-sans text-[0.6875rem] font-semibold text-accent-text">{agent}</span>}
                            {highlight(lineText(l), q)}
                            {badges(l).map((b) => <span key={b} className="ml-1.5 rounded border border-line px-1 font-sans text-[0.6875rem] text-fg-muted">{b}</span>)}
                          </span>
                          <span className="flex shrink-0 gap-1 font-sans opacity-70 group-hover:opacity-100">
                            {callId != null && (
                              <button type="button" onClick={() => setCalls((s) => flip(s, callId))} aria-expanded={calls.has(callId)} className="rounded border border-line px-1.5 text-[0.6875rem] text-fg-muted hover:bg-surface hover:text-fg">
                                {calls.has(callId) ? "Hide transcript" : "Transcript"}
                              </button>
                            )}
                            {ctxKeys.length > 0 && (
                              <button type="button" onClick={() => setDetails((s) => flip(s, l.id))} aria-expanded={details.has(l.id)} aria-label="Line details" className="rounded border border-line px-1.5 text-[0.6875rem] text-fg-muted hover:bg-surface hover:text-fg">
                                {"{…}"}
                              </button>
                            )}
                          </span>
                        </div>
                        {details.has(l.id) && (
                          <div className="mx-3 my-1 ml-[3.75rem] max-h-96 space-y-2 overflow-auto font-sans text-xs">
                            {typeof l.context.exc === "string" && <pre className="overflow-auto rounded-md border border-line bg-surface p-2 font-mono text-[0.6875rem] text-fg-muted">{l.context.exc}</pre>}
                            <Facts value={{ ...Object.fromEntries(Object.entries(l.context).filter(([k]) => k !== "exc")), logger: l.logger, event: l.event, time: l.at }} />
                          </div>
                        )}
                        {callId != null && calls.has(callId) && (
                          <div className="mx-3 ml-[3.75rem]">
                            <TranscriptPanel id={callId} />
                          </div>
                        )}
                      </Fragment>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        {more && !isLive && (
          <p className="border-t border-line p-3 text-center">
            <button type="button" onClick={() => void loadMore()} className="rounded-md border border-line px-3 py-1.5 text-sm hover:bg-surface-muted">Load more lines</button>
          </p>
        )}
      </div>
    </section>
  );
}
