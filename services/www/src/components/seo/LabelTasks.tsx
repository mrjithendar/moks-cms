"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/form";
import type { LabelRow } from "@/lib/seo-intel/ml-admin";

const INTENTS = ["informational", "navigational", "commercial", "troubleshooting", "comparison"] as const;

/**
 * Owner labelling (docs/seo/ML.md): confirm Claude's suggested group for a query or type another; for intent
 * disagreements pick the right intent (the Haiku label, the model's, or another). Each answer saves at once.
 */
export function LabelTasks({ task, rows, groups }: { task: "cluster" | "intent_check"; rows: LabelRow[]; groups: string[] }) {
  const router = useRouter();
  const [state, setState] = useState<Record<number, { status: string; label?: Record<string, unknown> | null; err?: string }>>({});
  const [edit, setEdit] = useState<Record<number, string>>({});
  async function save(id: number, status: string, label?: Record<string, string>) {
    const res = await fetch("/api/admin/seo/models/labels", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, status, ...(label ? { label } : {}) }) }).catch(() => null);
    const data = (await res?.json().catch(() => ({}))) as { status?: string; label?: Record<string, unknown> | null; error?: string };
    setState((s) => ({ ...s, [id]: res?.ok ? { status: data.status ?? status, label: data.label } : { status: "error", err: data.error ?? "Could not save." } }));
  }
  if (!rows.length) return <p className="text-sm text-fg-muted">No tasks here.</p>;
  return (
    <>
      <datalist id="label-groups">{groups.map((g) => <option key={g} value={g} />)}</datalist>
      <ul className="divide-y divide-line">
        {rows.map((r) => {
          const st = state[r.id]?.status ?? r.status;
          const lab = state[r.id]?.label ?? r.label;
          const done = st !== "pending" && st !== "error";
          return (
            <li key={r.id} className={`grid gap-2 py-3 text-sm sm:grid-cols-[1fr_auto] sm:items-center ${done ? "opacity-70" : ""}`}>
              <div>
                <p className="font-medium text-fg [overflow-wrap:anywhere]">{r.item}</p>
                {task === "cluster" ? (
                  <p className="text-xs text-fg-subtle">Suggested group: <strong className="text-fg-muted">{String(r.suggestion.group ?? "—")}</strong>{done && lab ? ` · saved: ${String((lab as { group?: string }).group ?? "")}` : ""}</p>
                ) : (
                  <p className="text-xs text-fg-subtle">Haiku: <strong className="text-fg-muted">{String(r.suggestion.haiku)}</strong> · model: <strong className="text-fg-muted">{String(r.suggestion.model)}</strong> ({Number(r.suggestion.confidence ?? 0).toFixed(2)}){done && lab ? ` · saved: ${String((lab as { intent?: string }).intent ?? "")}` : ""}</p>
                )}
                {state[r.id]?.err && <p className="text-xs text-red-700 dark:text-red-300">{state[r.id]!.err}</p>}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {task === "cluster" ? (
                  <>
                    <Button type="button" size="sm" variant={st === "confirmed" ? "primary" : "secondary"} onClick={() => save(r.id, "confirmed")}>Confirm</Button>
                    <input list="label-groups" aria-label={`Other group for ${r.item}`} placeholder="other group…" className="min-h-8 w-44 rounded-md border border-line-strong bg-surface px-2 text-sm text-fg" value={edit[r.id] ?? ""} onChange={(e) => setEdit((s) => ({ ...s, [r.id]: e.target.value }))} />
                    <Button type="button" size="sm" variant="secondary" disabled={!edit[r.id]?.trim()} onClick={() => save(r.id, "changed", { group: edit[r.id]!.trim() })}>Save group</Button>
                  </>
                ) : (
                  INTENTS.map((i) => (
                    <Button key={i} type="button" size="sm" variant={(lab as { intent?: string } | null)?.intent === i ? "primary" : "secondary"} onClick={() => save(r.id, i === r.suggestion.haiku ? "confirmed" : "changed", i === r.suggestion.haiku ? undefined : { intent: i })}>{i}</Button>
                  ))
                )}
                <Button type="button" size="sm" variant="ghost" onClick={() => save(r.id, "skipped")}>Skip</Button>
              </div>
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-xs text-fg-subtle">
        Saved answers count at the next model run. <button type="button" className="underline" onClick={() => router.refresh()}>Refresh the list</button>
      </p>
    </>
  );
}
