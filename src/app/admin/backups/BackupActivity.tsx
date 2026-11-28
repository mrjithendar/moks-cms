"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { formatLocal } from "@/components/LocalTime";

export type OperationView = {
  id: string;
  operation: "backup" | "verify" | "restore";
  label: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  progress: { phase?: string; message?: string; done?: number; total?: number; bytes?: number; at?: string };
  filename: string | null;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  cancelRequested: boolean;
};

const PHASES: Record<string, string> = {
  preparing: "Preparing",
  database: "Database",
  uploads: "Files",
  application: "Configuration",
  finalizing: "Checksums and manifest",
  verifying: "Verifying",
  safety: "Safety backup",
};

const active = (s: string) => s === "pending" || s === "running";

/**
 * The operation that is waiting or running (a backup, a verification, a restore), with its progress, asked for every 3
 * seconds until it ends; then the page reloads its lists. Rendered only while there is one.
 */
export function BackupActivity({ initial, cancel }: { initial: OperationView; cancel: (form: FormData) => Promise<void> }) {
  const [op, setOp] = useState(initial);
  const router = useRouter();
  useEffect(() => {
    if (!active(op.status)) return;
    let stopped = false;
    const t = setInterval(async () => {
      try {
        const r = await fetch(`/api/admin/backup/status?id=${encodeURIComponent(op.id)}`, { cache: "no-store" });
        if (!r.ok || stopped) return;
        const { operation } = (await r.json()) as { operation: OperationView | null };
        if (!operation) return;
        setOp(operation);
        if (!active(operation.status)) {
          clearInterval(t);
          router.refresh();
        }
      } catch {
        /* the next tick tries again */
      }
    }, 3000);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [op.id, op.status, router]);

  const p = op.progress ?? {};
  const percent = p.total ? Math.min(100, Math.round(((p.done ?? 0) / p.total) * 100)) : null;
  const tone = op.status === "failed" ? "border-red-300 dark:border-red-500/40" : op.status === "completed" ? "border-emerald-300 dark:border-emerald-500/40" : "border-sky-300 dark:border-sky-500/40";
  return (
    <section aria-live="polite" aria-labelledby="backup-activity-title" className={`rounded-xl border bg-surface p-5 shadow-sm sm:p-6 ${tone}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="backup-activity-title" className="font-semibold text-fg [overflow-wrap:anywhere]">
            {op.status === "pending" ? "Waiting to start: " : op.status === "running" ? "Running: " : ""}
            {op.label}
          </h2>
          <p className="mt-1 text-sm text-fg-muted">
            {op.status === "pending"
              ? "Queued in the background: it starts within 15 seconds on one of the site's servers. You can leave this page."
              : op.status === "running"
                ? `${PHASES[p.phase ?? ""] ?? "Working"}${p.message ? ` · ${p.message}` : ""}`
                : op.status === "completed"
                  ? "Finished."
                  : op.error ?? op.status}
          </p>
          {op.filename && <p className="mt-1 font-mono text-xs text-fg-subtle [overflow-wrap:anywhere]">{op.filename}</p>}
        </div>
        {active(op.status) && (
          <form action={cancel}>
            <input type="hidden" name="id" value={op.id} />
            <button type="submit" disabled={op.cancelRequested} className="text-sm font-semibold text-red-700 underline disabled:text-fg-subtle disabled:no-underline dark:text-red-400">
              {op.cancelRequested ? "Stopping…" : "Cancel"}
            </button>
          </form>
        )}
      </div>
      {active(op.status) && (
        <div className="mt-4">
          <div className="h-2 w-full overflow-hidden rounded-full bg-surface-sunken" role="progressbar" aria-label="Progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}>
            <div className={`h-full rounded-full bg-accent ${percent === null ? "w-1/3 animate-pulse" : ""}`} style={percent === null ? undefined : { width: `${Math.max(2, percent)}%` }} />
          </div>
          <p className="mt-2 text-xs text-fg-subtle">
            Started {formatLocal(op.startedAt)}
            {percent !== null ? ` · ${percent}%` : ""}
            {p.bytes ? ` · ${(p.bytes / 1024 / 1024).toFixed(1)} MB` : ""}
          </p>
        </div>
      )}
    </section>
  );
}
