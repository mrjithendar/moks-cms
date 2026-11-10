"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Dialog } from "@/components/admin/Dialog";
import { Alert, Button } from "@/components/ui/form";
import { PriorityBadge, StatusBadge } from "./badges";

export type QueueItem = {
  id: string;
  title: string;
  path: string;
  collection: string;
  status: string;
  categories: string[];
  changeCount: number;
  accepted: number;
  breakdown: string;
  priority: number;
  band: string;
  evidence: string[];
  generatedAt: string | null;
  createdAt: string;
  reviewMinutes: number;
  failureReason: string | null;
  errorFlags: number;
  inBatch: boolean;
  /** v3: "new_article" drafts come from the editorial crew. */
  kind?: string;
  /** News desk drafts: job, selection score, age (news gets stale). */
  news?: { job: string; score: number | null; mode: string; ageHours: number } | null;
  /** The latest CrewAI flow run for this draft (status + current step), from seo_flow_runs. */
  agent?: { status: string; node: string | null; outcome: string | null } | null;
};

const ago = (iso: string | null) => {
  if (!iso) return "—";
  const d = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 86_400_000));
  return d === 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
};

/**
 * The review queue. Cards on phones, dense rows from `md` up. Selecting drafts allows bulk *reject* only:
 * approving is always one article at a time, from its diff view.
 */
export function ReviewQueue({ items }: { items: QueueItem[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const selectable = items.filter((i) => ["ready_for_review", "generation_failed", "scheduled"].includes(i.status));
  const toggle = (id: string) => setSelected((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });

  async function bulkReject() {
    setBusy(true);
    const res = await fetch("/api/admin/seo/review/bulk-reject", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: [...selected], reason: reason || null }) }).catch(() => null);
    const data = (await res?.json().catch(() => ({}))) as { rejected?: number; error?: string };
    setBusy(false);
    setOpen(false);
    if (res?.ok) {
      setMsg({ ok: true, text: `Rejected ${data.rejected} draft${data.rejected === 1 ? "" : "s"}.` });
      setSelected(new Set());
      router.refresh();
    } else setMsg({ ok: false, text: data.error ?? "Could not reject." });
  }

  return (
    <div>
      {msg && <div className="mb-3"><Alert tone={msg.ok ? "success" : "error"}>{msg.text}</Alert></div>}
      {selectable.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
          <label className="flex min-h-11 items-center gap-2">
            <input type="checkbox" className="h-4 w-4" checked={selected.size > 0 && selected.size === selectable.length} onChange={(e) => setSelected(e.target.checked ? new Set(selectable.map((i) => i.id)) : new Set())} />
            Select all
          </label>
          <Button variant="secondary" size="sm" disabled={!selected.size} onClick={() => setOpen(true)}>Reject {selected.size || ""} selected</Button>
          <span className="text-xs text-fg-subtle">Approval is per article, from its review page.</span>
        </div>
      )}
      <ul className="grid gap-3 md:gap-0 md:divide-y md:divide-line md:overflow-hidden md:rounded-xl md:border md:border-line md:bg-surface">
        {items.map((i) => (
          <li key={i.id} className="relative rounded-xl border border-line bg-surface p-4 md:rounded-none md:border-0 md:px-4 md:py-3 md:hover:bg-surface-muted">
            <div className="flex items-start gap-3">
              {["ready_for_review", "generation_failed", "scheduled"].includes(i.status) && (
                <input type="checkbox" aria-label={`Select ${i.title}`} className="relative z-10 mt-1 h-5 w-5 shrink-0 md:h-4 md:w-4" checked={selected.has(i.id)} onChange={() => toggle(i.id)} />
              )}
              <div className="min-w-0 flex-1 md:grid md:grid-cols-[minmax(0,2.2fr)_minmax(0,1.2fr)_auto] md:items-center md:gap-4">
                <div className="min-w-0">
                  <Link href={`/admin/seo/review/${i.id}`} className="font-semibold text-fg after:absolute after:inset-0 hover:underline [overflow-wrap:anywhere]">{i.title}</Link>
                  <p className="mt-0.5 truncate text-xs text-fg-subtle">{i.path}</p>
                  {i.evidence[0] && <p className="mt-1 line-clamp-2 text-sm text-fg-muted">{i.evidence[0]}</p>}
                  {i.status === "generation_failed" && i.failureReason && <p className="mt-1 text-sm text-red-700 dark:text-red-300">{i.failureReason}</p>}
                  {i.news && (
                    <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-fg-subtle">
                      <span className="rounded-full bg-sky-100 px-2 py-0.5 font-semibold text-sky-900 dark:bg-sky-400/15 dark:text-sky-200">News</span>
                      <span>{i.news.job}{i.news.mode === "digest" ? " · digest" : ""}</span>
                      {i.news.score !== null && <span className="tabular-nums">· score {i.news.score.toFixed(2)}</span>}
                      <span className={i.news.ageHours >= 48 ? "font-medium text-amber-800 dark:text-amber-200" : ""}>· {i.news.ageHours < 1 ? "just now" : i.news.ageHours < 48 ? `${i.news.ageHours} h old` : `${Math.round(i.news.ageHours / 24)} days old: may be stale`}</span>
                    </p>
                  )}
                  {(i.kind === "new_article" || i.agent) && !i.news && (
                    <p className="mt-1 text-xs text-fg-subtle">
                      {i.kind === "new_article" ? "New article (editorial crew)" : "Optimization crew"}
                      {i.agent ? ` · ${i.agent.outcome === "draft_ready" ? "waiting for your review" : i.agent.status === "running" || i.agent.status === "queued" ? `working${i.agent.node ? ` (${i.agent.node.replace(/_/g, " ")})` : ""}` : (i.agent.outcome ?? i.agent.status).replace(/_/g, " ")}` : ""}
                    </p>
                  )}
                </div>
                <div className="mt-3 md:mt-0">
                  <p className="text-sm font-medium text-fg tabular-nums">{i.changeCount ? `${i.changeCount} change${i.changeCount === 1 ? "" : "s"}` : i.status === "generating" ? (i.inBatch ? "In this week's batch…" : "Generating…") : "—"}</p>
                  {i.breakdown && <p className="text-xs text-fg-subtle">{i.breakdown}</p>}
                  {i.errorFlags > 0 && <p className="text-xs font-medium text-red-700 dark:text-red-300">{i.errorFlags} change{i.errorFlags === 1 ? " needs" : "s need"} attention</p>}
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-fg-subtle md:mt-0 md:justify-end">
                  <StatusBadge status={i.status} />
                  <PriorityBadge band={i.band} />
                  <span className="whitespace-nowrap">{ago(i.generatedAt ?? i.createdAt)}</span>
                  {i.changeCount > 0 && <span className="whitespace-nowrap">~{i.reviewMinutes} min</span>}
                </div>
              </div>
            </div>
          </li>
        ))}
      </ul>
      <Dialog open={open} onClose={() => setOpen(false)} title={`Reject ${selected.size} draft${selected.size === 1 ? "" : "s"}?`} size="md" footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button variant="danger" loading={busy} onClick={bulkReject}>Reject</Button></div>}>
        <p className="text-sm text-fg-muted">Nothing is published. The recommendations stay open, so a future draft can address them differently.</p>
        <label className="mt-3 grid gap-1 text-sm text-fg">Reason (optional, used to improve future drafts)
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={2000} className="rounded-md border border-line-strong bg-surface p-2 text-sm" />
        </label>
      </Dialog>
    </div>
  );
}
