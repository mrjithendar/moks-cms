"use client";

import { useMemo, useState } from "react";
import { Alert, Button } from "@/components/ui/form";
import type { Action, Plan, PlanItem, Policy } from "@/lib/crewai/bundle/import";
import { KINDS, type Kind } from "@/lib/crewai/bundle/model";

/**
 * An import plan: what would be added, changed, left as it is, is in conflict, removed or refused, per kind, with the
 * import's options. "Apply" sends the same bundle again with the options and the chosen items; the server plans again
 * before applying, so the result never depends on what the browser kept.
 */

export const ACTION: Record<Action, { label: string; cls: string; hint: string }> = {
  create: { label: "new", cls: "bg-emerald-100 text-emerald-900 dark:bg-emerald-500/15 dark:text-emerald-200", hint: "Not on this site yet: it is added." },
  update: { label: "changes", cls: "bg-sky-100 text-sky-900 dark:bg-sky-500/15 dark:text-sky-200", hint: "Unchanged here since the last sync: the bundle's version is applied." },
  conflict: { label: "differs here", cls: "bg-amber-100 text-amber-900 dark:bg-amber-500/15 dark:text-amber-200", hint: "Changed here since the last sync (or there was none): applied only when conflicts are overwritten." },
  unchanged: { label: "same", cls: "bg-surface-sunken text-fg-subtle", hint: "The same here and in the bundle." },
  remove: { label: "removed", cls: "bg-red-100 text-red-900 dark:bg-red-500/15 dark:text-red-200", hint: "On this site, not in the bundle, and removal is on." },
  keep: { label: "kept", cls: "bg-surface-sunken text-fg-muted", hint: "On this site, not in the bundle: kept." },
  error: { label: "refused", cls: "bg-red-100 text-red-900 dark:bg-red-500/15 dark:text-red-200", hint: "A check refused it: see why." },
};

export type ApplyOptions = { policy: Policy; prune: boolean; allowPartial: boolean; only: string[] | null };

export function PlanView({ plan, busy, onApply, onReplan, applyLabel = "Apply" }: { plan: Plan; busy: boolean; onApply: (o: ApplyOptions) => void; onReplan?: (o: Omit<ApplyOptions, "only">) => void; applyLabel?: string }) {
  const [filter, setFilter] = useState<Action | "changed" | "all">("changed");
  const [kind, setKind] = useState<Kind | "all">("all");
  const [policy, setPolicy] = useState<Policy>(plan.policy);
  const [prune, setPrune] = useState(plan.prune);
  const [allowPartial, setAllowPartial] = useState(false);
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const changed = (i: PlanItem) => i.action !== "unchanged";
  const shown = useMemo(() => plan.items.filter((i) => (kind === "all" || i.kind === kind) && (filter === "all" ? true : filter === "changed" ? changed(i) : i.action === filter)), [plan.items, filter, kind]);
  const errors = plan.issues.filter((i) => i.severity === "error" && !i.ref);
  const warnings = plan.issues.filter((i) => i.severity === "warning");
  const conflicts = plan.counts.conflict;
  const refused = plan.counts.error;
  const optionsChanged = policy !== plan.policy || prune !== plan.prune;
  const pickable = (i: PlanItem) => ["create", "update", "conflict", "remove"].includes(i.action);
  const toggle = (r: string) => {
    const next = new Set(picked ?? plan.items.filter(pickable).map((i) => i.ref));
    if (next.has(r)) next.delete(r);
    else next.add(r);
    setPicked(next);
  };
  const willApply = plan.items.filter((i) => pickable(i) && (picked ? picked.has(i.ref) : true) && (i.action !== "conflict" || policy === "overwrite")).length;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 text-xs">
        {(["create", "update", "conflict", "remove", "error", "keep", "unchanged"] as Action[]).map((a) => (
          <button key={a} type="button" onClick={() => setFilter(filter === a ? "changed" : a)} title={ACTION[a].hint} className={`rounded-full px-2.5 py-1 font-medium ${ACTION[a].cls} ${filter === a ? "ring-2 ring-accent" : ""}`}>
            {plan.counts[a]} {ACTION[a].label}
          </button>
        ))}
        <select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value as Kind | "all")} className="rounded-full border border-line bg-surface px-2 py-1">
          <option value="all">All kinds</option>
          {KINDS.filter((k) => k.importable).map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
        </select>
        <button type="button" onClick={() => setFilter(filter === "all" ? "changed" : "all")} className="rounded-full border border-line px-2.5 py-1 text-fg-muted">{filter === "all" ? "Only what changes" : "Everything"}</button>
      </div>
      {errors.length > 0 && (
        <Alert>
          <p className="font-medium">The bundle cannot be imported:</p>
          <ul className="mt-1 list-disc pl-5">{errors.slice(0, 30).map((e, i) => <li key={i}><code>{e.path}</code>: {e.message}</li>)}</ul>
        </Alert>
      )}
      {(plan.warnings.length > 0 || warnings.length > 0) && (
        <Alert tone="info">
          <ul className="list-disc pl-5">{[...plan.warnings, ...warnings.map((w) => `${w.path}: ${w.message}`)].slice(0, 20).map((w, i) => <li key={i}>{w}</li>)}</ul>
        </Alert>
      )}
      <ul className="max-h-[28rem] divide-y divide-line overflow-auto rounded-lg border border-line">
        {shown.length === 0 && <li className="px-3 py-3 text-sm text-fg-muted">Nothing here.</li>}
        {shown.map((i) => (
          <li key={i.ref} className="flex flex-wrap items-start gap-2 px-3 py-2 text-sm">
            {pickable(i) ? <input type="checkbox" aria-label={`Include ${i.ref}`} checked={picked ? picked.has(i.ref) : true} onChange={() => toggle(i.ref)} className="mt-1" /> : <span className="w-[13px]" />}
            <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${ACTION[i.action].cls}`} title={ACTION[i.action].hint}>{ACTION[i.action].label}</span>
            <span className="text-xs text-fg-subtle">{KINDS.find((k) => k.kind === i.kind)?.one}</span>
            <span className="font-mono text-xs text-fg">{i.id}</span>
            <span className="min-w-0 flex-1 text-xs text-fg-muted [overflow-wrap:anywhere]">{i.error ?? i.changes.join(" · ")}</span>
            {i.path && <code className="text-[11px] text-fg-subtle">{i.path}</code>}
          </li>
        ))}
      </ul>
      <fieldset className="grid gap-3 rounded-lg border border-line p-3 text-sm sm:grid-cols-2">
        <legend className="px-1 text-xs font-semibold text-fg-subtle">Options</legend>
        <div>
          <p className="mb-1 font-medium text-fg">Items that differ here ({conflicts})</p>
          <label className="flex items-center gap-2"><input type="radio" name="policy" checked={policy === "skip"} onChange={() => setPolicy("skip")} /> Keep this site&apos;s version</label>
          <label className="flex items-center gap-2"><input type="radio" name="policy" checked={policy === "overwrite"} onChange={() => setPolicy("overwrite")} /> Apply the bundle&apos;s version</label>
          <label className="flex items-center gap-2"><input type="radio" name="policy" checked={policy === "fail"} onChange={() => setPolicy("fail")} /> Refuse the import if any differ</label>
        </div>
        <div className="space-y-1">
          <label className="flex items-start gap-2"><input type="checkbox" checked={prune} onChange={(e) => setPrune(e.target.checked)} className="mt-1" /> <span>Remove what the bundle does not have <span className="block text-xs text-fg-subtle">Never crews and flows defined in code, shipped skills or built-in schedules.</span></span></label>
          <label className="flex items-start gap-2"><input type="checkbox" checked={allowPartial} onChange={(e) => setAllowPartial(e.target.checked)} className="mt-1" /> <span>Leave out refused items and apply the rest ({refused} refused)</span></label>
        </div>
      </fieldset>
      <div className="flex flex-wrap items-center gap-2">
        {optionsChanged && onReplan ? (
          <Button type="button" variant="secondary" disabled={busy} onClick={() => onReplan({ policy, prune, allowPartial })}>Plan again with these options</Button>
        ) : (
          <Button type="button" disabled={busy || errors.length > 0 || willApply === 0 || (refused > 0 && !allowPartial)} onClick={() => onApply({ policy, prune, allowPartial, only: picked ? [...picked] : null })}>
            {busy ? "Working…" : `${applyLabel} (${willApply})`}
          </Button>
        )}
        <p className="text-xs text-fg-subtle">Applied in one transaction and verified; a failure changes nothing. Recorded under History, where it can be rolled back.</p>
      </div>
    </div>
  );
}
