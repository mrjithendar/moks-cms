"use client";

import { LocalTime } from "@/components/LocalTime";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

type Log = { id: number; step: string | null; level: string; message: string; context: Record<string, unknown>; at: string };
const TONE: Record<string, string> = { error: "text-red-700 dark:text-red-300", warning: "text-amber-800 dark:text-amber-200", info: "text-fg-muted", debug: "text-fg-subtle" };

/**
 * Live run log: server-sent events from /api/admin/news/runs/{id}/logs while the run is going (the browser reconnects
 * with Last-Event-ID), then the full history. Level filter and search apply on the server and to what is shown.
 */
export function RunLogs({ runId, initial, live }: { runId: string; initial: Log[]; live: boolean }) {
  const router = useRouter();
  const [logs, setLogs] = useState<Log[]>(initial);
  const [level, setLevel] = useState("debug");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<string | null>(live ? "running" : null);
  const box = useRef<HTMLOListElement>(null);
  const lastId = useRef(initial.length ? initial[initial.length - 1]!.id : 0);

  useEffect(() => {
    if (!live) return;
    const es = new EventSource(`/api/admin/news/runs/${runId}/logs?after=${lastId.current}`);
    es.addEventListener("log", (e) => {
      const l = JSON.parse((e as MessageEvent).data) as Log;
      if (l.id <= lastId.current) return;
      lastId.current = l.id;
      setLogs((x) => [...x, l].slice(-2000));
    });
    es.addEventListener("status", (e) => setStatus((JSON.parse((e as MessageEvent).data) as { status: string }).status));
    es.addEventListener("end", () => {
      es.close();
      router.refresh();
    });
    return () => es.close();
  }, [live, runId, router]);

  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [logs.length]);

  const rank = { debug: 0, info: 1, warning: 2, error: 3 } as Record<string, number>;
  const shown = useMemo(() => logs.filter((l) => (rank[l.level] ?? 1) >= (rank[level] ?? 0) && (!q || l.message.toLowerCase().includes(q.toLowerCase()))), [logs, level, q]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section aria-labelledby="logs" className="rounded-xl border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-3 border-b border-line p-3">
        <h2 id="logs" className="text-sm font-semibold text-fg">Log {status && ["queued", "running"].includes(status) && <span className="ml-2 inline-flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-300"><span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" aria-hidden="true" />live</span>}</h2>
        <label className="ml-auto flex items-center gap-2 text-xs">Level
          <select value={level} onChange={(e) => setLevel(e.target.value)} className="min-h-9 rounded border border-line bg-surface px-2">
            <option value="debug">all</option>
            <option value="info">info+</option>
            <option value="warning">warnings+</option>
            <option value="error">errors</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-xs">Search
          <input value={q} onChange={(e) => setQ(e.target.value)} className="min-h-9 w-40 rounded border border-line bg-surface px-2" />
        </label>
      </div>
      <ol ref={box} className="max-h-[28rem] overflow-y-auto p-3 font-mono text-xs leading-5" aria-live="polite">
        {shown.length === 0 && <li className="text-fg-subtle">No log lines.</li>}
        {shown.map((l) => (
          <li key={l.id} className={TONE[l.level] ?? ""}>
            <span className="text-fg-subtle"><LocalTime iso={l.at} style="time" /></span> <span className="uppercase">{l.level.slice(0, 4)}</span> {l.step && <span className="text-fg-subtle">[{l.step}]</span>} {l.message}
          </li>
        ))}
      </ol>
    </section>
  );
}
