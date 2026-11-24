"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, buttonClass } from "@/components/ui/form";
import type { ApplyResult, Plan } from "@/lib/crewai/bundle/import";
import { BASE, call } from "./api";
import { PlanView, type ApplyOptions } from "./PlanView";

type Result = { plan: Plan; result: ApplyResult | null };

/** Download the bundle (zip of crewconfig/, or JSON); import one (zip, JSON bundle, or a moks-crewai-config file). */
export function BundleTransfer({ disabled }: { disabled: boolean }) {
  const router = useRouter();
  const [bundle, setBundle] = useState<unknown>(null);
  const [name, setName] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [done, setDone] = useState<ApplyResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async (b: unknown, o: Partial<ApplyOptions> & { dryRun: boolean }) => {
    setBusy(true);
    setError(null);
    try {
      const r = await call<Result>(BASE, { method: "POST", body: { bundle: b, dryRun: o.dryRun, ...(o.policy ? { policy: o.policy } : {}), ...(o.prune !== undefined ? { prune: o.prune } : {}), ...(o.allowPartial ? { allowPartial: true } : {}), ...(o.only ? { only: o.only } : {}) } });
      if (o.dryRun) setPlan(r.plan);
      else {
        setDone(r.result);
        setPlan(null);
        router.refresh();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const pick = async (f: File | undefined) => {
    setPlan(null);
    setDone(null);
    setError(null);
    if (!f) return;
    if (f.size > 12 * 1024 * 1024) return setError("The file is larger than 12 MB.");
    try {
      let b: unknown;
      if (/\.zip$/i.test(f.name)) {
        const { unzipFiles } = await import("@/lib/crewai/bundle/zip");
        b = { files: await unzipFiles(new Uint8Array(await f.arrayBuffer())) };
      } else {
        const j = JSON.parse(await f.text()) as Record<string, unknown>;
        b = j.files ? { files: j.files } : j;
      }
      setBundle(b);
      setName(f.name);
      await send(b, { dryRun: true });
    } catch (e) {
      setBundle(null);
      setError(`Cannot read ${f.name}: ${(e as Error).message}`);
    }
  };

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-line bg-surface p-5">
        <h2 className="text-base font-semibold text-fg">Export</h2>
        <p className="mt-1 text-sm text-fg-muted">Every crew with its agents and tasks, flow, skill, schedule, content source and category, and, read-only, the tools, prompt guardrails and model providers. No secrets: a provider says where its key is, never the key.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <a href={`${BASE}?format=zip`} className={buttonClass("primary", "sm")} aria-disabled={disabled || undefined}>Download crewconfig.zip</a>
          <a href={`${BASE}?format=json&download=1`} className={buttonClass("secondary", "sm")} aria-disabled={disabled || undefined}>Download as JSON</a>
        </div>
      </section>
      <section className="rounded-xl border border-line bg-surface p-5">
        <h2 className="text-base font-semibold text-fg">Import</h2>
        <p className="mt-1 text-sm text-fg-muted">A crewconfig zip, its JSON, or a file from the earlier Import / export (moks-crewai-config). You see the plan first; nothing changes until you apply it, and nothing is removed unless you ask.</p>
        <label className="mt-3 inline-flex">
          <span className="sr-only">Bundle file</span>
          <input type="file" accept=".zip,.json,application/zip,application/json" disabled={disabled || busy} onChange={(e) => pick(e.target.files?.[0])} className="text-sm" />
        </label>
        {error && <div className="mt-3"><Alert>{error}</Alert></div>}
        {done && (
          <div className="mt-3">
            <Alert tone="success">
              {done.status === "unchanged" ? "Nothing to change: this site already has that configuration." : `Applied and verified: ${Object.entries(done.applied).map(([k, n]) => `${n} ${k}`).join(", ")}.`} Recorded under History.
            </Alert>
          </div>
        )}
        {plan && (
          <div className="mt-4">
            <p className="mb-3 text-sm text-fg-muted">
              Plan for <span className="font-mono">{name}</span> (format {plan.format}){plan.baseline ? `, compared with the last sync (${new Date(plan.baseline.at).toLocaleString()})` : ", with no earlier sync: every difference counts as differing here"}.
            </p>
            <PlanView plan={plan} busy={busy} onReplan={(o) => send(bundle, { ...o, dryRun: true })} onApply={(o) => send(bundle, { ...o, dryRun: false })} />
          </div>
        )}
      </section>
    </div>
  );
}
