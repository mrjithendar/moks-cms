"use client";

import { useState } from "react";
import { Popover } from "./Popover";

/**
 * Sync history › Error: a compact chip (error code + first line) that opens the full error on hover, keyboard focus or
 * tap (the shared accessible Popover: tooltip on hover/focus, dialog with a copy button on click/tap).
 */
export function SyncErrorCell({ error, errorCode, correlationId, job }: { error: string | null; errorCode: string | null; correlationId: string; job: string }) {
  const [copied, setCopied] = useState(false);
  if (!error) return <span className="text-fg-subtle">—</span>;
  const first = error.split("\n")[0]!.trim();
  const short = first.length > 48 ? `${first.slice(0, 46)}…` : first;
  return (
    <Popover
      label={`${job} error${errorCode ? ` (${errorCode})` : ""}: full message`}
      trigger={
        <span className="inline-flex max-w-[16rem] items-center gap-1.5 text-left text-xs">
          {errorCode && <span className="shrink-0 rounded bg-red-50 px-1.5 py-0.5 font-mono text-[0.7rem] font-semibold text-red-700 dark:bg-red-500/10 dark:text-red-300">{errorCode}</span>}
          <span className="truncate text-fg-muted">{short}</span>
        </span>
      }
    >
      {(mode) => (
        <div className="space-y-2">
          <p className="flex items-center gap-2 text-xs font-semibold text-fg">
            {errorCode ? <span className="rounded bg-red-50 px-1.5 py-0.5 font-mono text-red-700 dark:bg-red-500/10 dark:text-red-300">{errorCode}</span> : null}
            <span>{job}</span>
          </p>
          <p className="max-h-60 overflow-auto whitespace-pre-wrap text-xs leading-relaxed text-fg [overflow-wrap:anywhere]">{error}</p>
          <p className="text-[0.7rem] text-fg-subtle">
            Correlation id <span className="font-mono">{correlationId}</span> (search it in the logs)
          </p>
          {mode === "click" && (
            <button
              type="button"
              className="rounded-md border border-line px-2 py-1 text-xs font-medium text-fg hover:bg-surface-sunken"
              onClick={() => {
                void navigator.clipboard?.writeText(`${errorCode ?? ""} ${error}\ncorrelation id: ${correlationId}`.trim()).then(() => setCopied(true), () => setCopied(false));
              }}
            >
              {copied ? "Copied" : "Copy error"}
            </button>
          )}
        </div>
      )}
    </Popover>
  );
}
