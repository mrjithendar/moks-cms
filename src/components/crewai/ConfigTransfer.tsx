"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, buttonClass } from "@/components/ui/form";

type Item = { key: string; action: "create" | "update" | "unchanged" | "error"; changes: string[]; error?: string };
type Plan = { schedules: Item[]; crews: Item[]; skills: Item[]; warnings: string[] };
type Result = { plan: Plan; applied: { schedules: number; crews: number; skills: number }; failed: { part: string; key: string; error: string }[] };
type ApiError = { error?: string; issues?: string[]; reference?: string };
const message = (d: ApiError) => [d.error ?? "Something went wrong.", ...(d.issues ?? [])].join(" ") + (d.reference ? ` (ref ${d.reference})` : "");

const ACTION: Record<Item["action"], { label: string; cls: string }> = {
  create: { label: "new", cls: "bg-emerald-100 text-emerald-900 dark:bg-emerald-500/15 dark:text-emerald-200" },
  update: { label: "changes", cls: "bg-amber-100 text-amber-900 dark:bg-amber-500/15 dark:text-amber-200" },
  unchanged: { label: "same", cls: "bg-surface-sunken text-fg-subtle" },
  error: { label: "refused", cls: "bg-red-100 text-red-900 dark:bg-red-500/15 dark:text-red-200" },
};

function PlanTable({ title, items }: { title: string; items: Item[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold text-fg">{title}</h3>
      <ul className="divide-y divide-line rounded-lg border border-line">
        {items.map((i) => (
          <li key={i.key} className="flex flex-wrap items-start gap-2 px-3 py-2 text-sm">
            <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${ACTION[i.action].cls}`}>{ACTION[i.action].label}</span>
            <span className="font-mono text-xs text-fg">{i.key}</span>
            <span className="min-w-0 flex-1 text-xs text-fg-muted [overflow-wrap:anywhere]">{i.error ?? i.changes.join(" · ")}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Export: tick what to include and download. Import: choose a file, see the plan, then apply it. */
export function ConfigTransfer({ disabled }: { disabled: boolean }) {
  const router = useRouter();
  const [parts, setParts] = useState({ schedules: true, crews: true, skills: true });
  const [bundle, setBundle] = useState<unknown>(null);
  const [fileName, setFileName] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [activate, setActivate] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Result | null>(null);
  const exportHref = `/api/admin/crewai/config?parts=${Object.entries(parts).filter(([, v]) => v).map(([k]) => k).join(",")}`;

  const send = async (apply: boolean) => {
    setBusy(apply ? "apply" : "plan");
    setError(null);
    try {
      const res = await fetch("/api/admin/crewai/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bundle, apply, activate }) });
      const data = (await res.json().catch(() => ({}))) as ApiError & Partial<Result> & { plan?: Plan };
      if (!res.ok) return setError(message(data));
      if (apply) {
        setDone(data as Result);
        setPlan(null);
        router.refresh();
      } else setPlan(data.plan ?? null);
    } catch {
      setError("Network error.");
    } finally {
      setBusy(null);
    }
  };

  const pick = async (f: File | undefined) => {
    setPlan(null);
    setDone(null);
    setError(null);
    if (!f) return;
    if (f.size > 190_000) return setError("The file is larger than 190 KB.");
    try {
      setBundle(JSON.parse(await f.text()));
      setFileName(f.name);
    } catch {
      setBundle(null);
      setError("That file is not JSON.");
    }
  };

  const pending = plan ? [...plan.schedules, ...plan.crews, ...plan.skills].filter((i) => i.action === "create" || i.action === "update").length : 0;
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <section aria-labelledby="export-h" className="space-y-3 rounded-xl border border-line bg-surface p-4">
        <h2 id="export-h" className="text-base font-semibold text-fg">Export</h2>
        <p className="text-sm text-fg-muted">One JSON file: schedules by name, each crew&apos;s active version, and the skills you added or changed. No secrets, IDs or run history.</p>
        <fieldset className="flex flex-wrap gap-x-5 gap-y-1">
          <legend className="sr-only">What to export</legend>
          {(["schedules", "crews", "skills"] as const).map((k) => (
            <label key={k} className="inline-flex min-h-11 items-center gap-2 text-sm text-fg">
              <input type="checkbox" className="h-4 w-4" checked={parts[k]} onChange={(e) => setParts({ ...parts, [k]: e.target.checked })} />
              {k === "schedules" ? "Schedules" : k === "crews" ? "Crew versions" : "Skills"}
            </label>
          ))}
        </fieldset>
        <a href={exportHref} download className={buttonClass("primary", "sm")} aria-disabled={disabled || !Object.values(parts).some(Boolean) || undefined}>Download configuration</a>
      </section>

      <section aria-labelledby="import-h" className="space-y-3 rounded-xl border border-line bg-surface p-4">
        <h2 id="import-h" className="text-base font-semibold text-fg">Import</h2>
        <p className="text-sm text-fg-muted">Choose a file exported here or on another site. You see what would change before anything does. Import only adds and changes: nothing missing from the file is deleted or paused.</p>
        <label htmlFor="import-file" className="block text-sm font-medium text-fg">Configuration file (JSON)</label>
        <input id="import-file" type="file" accept="application/json,.json" disabled={disabled} onChange={(e) => void pick(e.target.files?.[0])} className="block w-full text-sm text-fg-muted file:mr-3 file:min-h-11 file:rounded-[var(--radius-control)] file:border file:border-line-strong file:bg-surface file:px-4 file:text-sm file:font-semibold file:text-fg" />
        <label className="inline-flex min-h-11 items-center gap-2 text-sm text-fg">
          <input type="checkbox" className="h-4 w-4" checked={activate} onChange={(e) => setActivate(e.target.checked)} />
          Make imported crew versions active
        </label>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" size="sm" disabled={!bundle || disabled} loading={busy === "plan"} onClick={() => void send(false)}>Check {fileName || "file"}</Button>
          <Button type="button" size="sm" disabled={!plan || pending === 0} loading={busy === "apply"} onClick={() => void send(true)}>Import {pending ? `${pending} change${pending === 1 ? "" : "s"}` : ""}</Button>
        </div>
        {error && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>}
      </section>

      {plan && (
        <section aria-labelledby="plan-h" className="space-y-4 lg:col-span-2">
          <h2 id="plan-h" className="text-base font-semibold text-fg">What the import would do</h2>
          {plan.warnings.map((w) => <p key={w} role="status" className="text-sm text-amber-800 dark:text-amber-200">{w}</p>)}
          <PlanTable title="Schedules" items={plan.schedules} />
          <PlanTable title="Crews" items={plan.crews} />
          <PlanTable title="Skills" items={plan.skills} />
          {pending === 0 && <p className="text-sm text-fg-muted">Nothing to import: this site already has everything in the file.</p>}
        </section>
      )}
      {done && (
        <section aria-labelledby="done-h" className="space-y-2 lg:col-span-2" role="status">
          <h2 id="done-h" className="text-base font-semibold text-fg">Imported</h2>
          <p className="text-sm text-fg-muted">{done.applied.schedules} schedule(s), {done.applied.crews} crew version(s) and {done.applied.skills} skill(s) imported.</p>
          {done.failed.map((f) => <p key={`${f.part}:${f.key}`} className="text-sm text-red-700 dark:text-red-300">{f.part} {f.key}: {f.error}</p>)}
        </section>
      )}
    </div>
  );
}
