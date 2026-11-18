"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, Button } from "@/components/ui/form";

type Result = { queued?: number; skipped?: { articleId: string; reason: string }[]; requested?: number; error?: string; issues?: string[] };

async function rescan(body: unknown): Promise<{ ok: boolean; text: string }> {
  const res = await fetch("/api/admin/seo/review/rescan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  const data = ((await res?.json().catch(() => ({}))) ?? {}) as Result;
  if (!res?.ok) return { ok: false, text: [data.error ?? "Could not start the rescan.", ...(data.issues ?? [])].join(" ") };
  const skipped = data.skipped?.length ?? 0;
  return { ok: true, text: `Queued ${data.queued} of ${data.requested} article${data.requested === 1 ? "" : "s"} for re-review.${skipped ? ` ${skipped} skipped (${data.skipped![0]!.reason}${skipped > 1 ? ", …" : ""}).` : ""} Drafts appear under Articles as they finish.` };
}

/** "Rescan": the next N articles on the Not reviewed list get a fresh review draft (each is a model run). */
export function RescanControl({ waiting }: { waiting: number }) {
  const router = useRouter();
  const [n, setN] = useState(Math.min(10, Math.max(1, waiting)));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <label className="grid gap-1 text-xs font-medium text-fg-muted">
          Articles to rescan
          <select value={n} onChange={(e) => setN(Number(e.target.value))} className="min-h-9 rounded-md border border-line-strong bg-surface px-2 text-sm text-fg">
            {[5, 10, 25].map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
        <Button
          size="sm"
          loading={busy}
          disabled={waiting === 0}
          onClick={async () => {
            const count = Math.min(n, waiting);
            if (!window.confirm(`Rescan ${count} article${count === 1 ? "" : "s"}? Each one is a review by the AI model, which has a cost. The drafts wait here for your approval.`)) return;
            setBusy(true);
            setMsg(await rescan({ all: true, limit: n }));
            setBusy(false);
            router.refresh();
          }}
        >
          Rescan for re-review
        </Button>
      </div>
      <p className="text-xs text-fg-subtle">{waiting === 0 ? "Every article has been reviewed recently." : `${waiting} article${waiting === 1 ? " is" : "s are"} not reviewed: never, or not in the last 90 days. The oldest go first.`}</p>
      {msg && <Alert tone={msg.ok ? "success" : "error"}>{msg.text}</Alert>}
    </div>
  );
}

export type UnreviewedItem = { articleId: string; title: string; path: string; lastReviewedAt: string | null; lastOutcome: string | null; openRecommendations: number; publishedAt: string | null };

const since = (iso: string | null) => {
  if (!iso) return "never";
  const d = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 86_400_000));
  return d === 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
};

/** Published articles nobody reviewed recently, with "Review selected" (at most 25 at a time) and "Review now". */
export function UnreviewedList({ items }: { items: UnreviewedItem[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const send = async (ids: string[], key: string) => {
    setBusy(key);
    setMsg(await rescan({ articleIds: ids }));
    setBusy(null);
    setSelected(new Set());
    router.refresh();
  };
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else if (n.size < 25) n.add(id);
      return n;
    });
  return (
    <div>
      {msg && <div className="mb-3"><Alert tone={msg.ok ? "success" : "error"}>{msg.text}</Alert></div>}
      <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
        <label className="flex min-h-11 items-center gap-2">
          <input type="checkbox" className="h-4 w-4" checked={selected.size > 0 && selected.size === Math.min(25, items.length)} onChange={(e) => setSelected(e.target.checked ? new Set(items.slice(0, 25).map((i) => i.articleId)) : new Set())} />
          Select {items.length > 25 ? "first 25" : "all"}
        </label>
        <Button size="sm" disabled={!selected.size} loading={busy === "bulk"} onClick={() => window.confirm(`Send ${selected.size} article${selected.size === 1 ? "" : "s"} for an AI review? Each one has a model cost.`) && void send([...selected], "bulk")}>
          Review {selected.size || ""} selected
        </Button>
        <span className="text-xs text-fg-subtle">At most 25 at a time.</span>
      </div>
      <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
        {items.map((i) => (
          <li key={i.articleId} className="flex items-start gap-3 px-4 py-3 hover:bg-surface-muted">
            <input type="checkbox" aria-label={`Select ${i.title}`} className="mt-1 h-4 w-4 shrink-0" checked={selected.has(i.articleId)} onChange={() => toggle(i.articleId)} />
            <div className="min-w-0 flex-1">
              <Link href={i.path} target="_blank" rel="noopener" className="font-semibold text-fg hover:underline [overflow-wrap:anywhere]">{i.title}</Link>
              <p className="mt-0.5 text-xs text-fg-subtle">
                {i.path} · last reviewed {since(i.lastReviewedAt)}{i.lastOutcome ? ` (${i.lastOutcome.replace(/_/g, " ")})` : ""}
                {i.openRecommendations > 0 && <> · {i.openRecommendations} open recommendation{i.openRecommendations === 1 ? "" : "s"}</>}
              </p>
            </div>
            <Button size="sm" variant="secondary" loading={busy === i.articleId} onClick={() => void send([i.articleId], i.articleId)}>Review now</Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
