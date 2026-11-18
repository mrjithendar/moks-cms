import { STATUS_LABELS } from "@/lib/crewai/flows";

/** Colour per run or step status (GitHub Actions style: green success, red failure, amber in progress). */
export const STATUS_TONE: Record<string, string> = {
  succeeded: "text-emerald-600 dark:text-emerald-400",
  failed: "text-red-600 dark:text-red-400",
  running: "text-amber-500 dark:text-amber-400",
  queued: "text-fg-subtle",
  cancelled: "text-fg-subtle",
  paused_budget: "text-amber-600 dark:text-amber-400",
  pending: "text-fg-subtle",
};

/**
 * A run's or step's status as an icon (server and client). `pending`: a step that has not run. The label is the
 * accessible name; pass `decorative` when the status is also written next to it.
 */
export function RunStatusIcon({ status, size = 16, className = "", decorative = false }: { status: string; size?: number; className?: string; decorative?: boolean }) {
  const label = STATUS_LABELS[status] ?? (status === "pending" ? "Not run" : status);
  const a11y = decorative ? { "aria-hidden": true as const } : { role: "img", "aria-label": label };
  const common = { width: size, height: size, viewBox: "0 0 16 16", className: `shrink-0 ${STATUS_TONE[status] ?? "text-fg-subtle"} ${className}`, ...a11y };
  switch (status) {
    case "succeeded":
      return (
        <svg {...common} fill="currentColor">
          <path d="M8 16A8 8 0 1 1 8 0a8 8 0 0 1 0 16Zm3.78-9.72a.75.75 0 0 0-1.06-1.06L6.75 9.19 5.28 7.72a.75.75 0 0 0-1.06 1.06l2 2a.75.75 0 0 0 1.06 0l4.5-4.5Z" />
        </svg>
      );
    case "failed":
      return (
        <svg {...common} fill="currentColor">
          <path d="M8 16A8 8 0 1 1 8 0a8 8 0 0 1 0 16ZM5.53 4.47a.75.75 0 0 0-1.06 1.06L6.94 8l-2.47 2.47a.75.75 0 1 0 1.06 1.06L8 9.06l2.47 2.47a.75.75 0 1 0 1.06-1.06L9.06 8l2.47-2.47a.75.75 0 0 0-1.06-1.06L8 6.94 5.53 4.47Z" />
        </svg>
      );
    case "running":
      return (
        <svg {...common} fill="none" className={`${common.className} motion-safe:animate-spin`}>
          <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
          <path d="M14.5 8A6.5 6.5 0 0 0 8 1.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case "queued":
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="8" cy="8" r="6.75" />
          <path d="M8 4.5V8l2.25 1.5" strokeLinecap="round" />
        </svg>
      );
    case "cancelled":
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="8" cy="8" r="6.75" />
          <path d="M3.5 12.5l9-9" strokeLinecap="round" />
        </svg>
      );
    case "paused_budget":
      return (
        <svg {...common} fill="currentColor">
          <path d="M8 16A8 8 0 1 1 8 0a8 8 0 0 1 0 16ZM6 5a.75.75 0 0 0-.75.75v4.5a.75.75 0 0 0 1.5 0v-4.5A.75.75 0 0 0 6 5Zm4 0a.75.75 0 0 0-.75.75v4.5a.75.75 0 0 0 1.5 0v-4.5A.75.75 0 0 0 10 5Z" />
        </svg>
      );
    default:
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.5 2.5">
          <circle cx="8" cy="8" r="6.75" />
        </svg>
      );
  }
}

/** Icon and word, for headers and tables. */
export function RunStatus({ status, className = "" }: { status: string; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-sm font-medium ${STATUS_TONE[status] ?? "text-fg-muted"} ${className}`}>
      <RunStatusIcon status={status} decorative />
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}
