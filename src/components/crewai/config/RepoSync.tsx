"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, Button, Input } from "@/components/ui/form";
import type { ApplyResult, Plan } from "@/lib/crewai/bundle/import";
import type { SaveResult } from "@/lib/crewai/bundle/repo";
import { BASE, call } from "./api";
import { PlanView, type ApplyOptions } from "./PlanView";

type Compare = { commit: string; same: boolean; differs: string[]; onlyRepo: string[]; onlySite: string[]; issues: number };

/**
 * The two directions between the site and crewconfig/ in Git: write what runs here to the repository (a commit or a
 * pull request), or import the repository's head here (a plan first). And how they compare now.
 */
export function RepoSync({ configured, mode }: { configured: boolean; mode: "commit" | "pull_request" }) {
  const router = useRouter();
  const [cmp, setCmp] = useState<Compare | null>(null);
  const [plan, setPlan] = useState<(Plan & { commit?: string }) | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  if (!configured) return <p className="text-sm text-fg-muted">Set up the repository under Settings (this page) to compare, write and import crewconfig/ from here.</p>;

  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const compare = () => run("compare", async () => setCmp((await call<{ compare: Compare }>(`${BASE}/repo?compare=1`)).compare));
  const write = () =>
    run("write", async () => {
      const r = await call<SaveResult & { unchanged: boolean }>(`${BASE}/repo/export`, { method: "POST", body: message.trim() ? { message: message.trim() } : {} });
      setDone(r.unchanged ? "crewconfig/ already holds this configuration: nothing to write." : r.pullRequest ? `Pull request #${r.pullRequest.number} opened with ${r.files.length} files: ${r.pullRequest.url}` : `Committed ${r.commit.slice(0, 7)} (${r.files.length} files).`);
      router.refresh();
    });
  const planImport = (o: Partial<ApplyOptions> = {}) =>
    run("plan", async () => {
      const r = await call<{ plan: Plan; commit: string }>(`${BASE}/repo/import`, { method: "POST", body: { dryRun: true, ...(o.policy ? { policy: o.policy } : {}), ...(o.prune !== undefined ? { prune: o.prune } : {}) } });
      setPlan({ ...r.plan, commit: r.commit });
    });
  const apply = (o: ApplyOptions) =>
    run("apply", async () => {
      const r = await call<{ result: ApplyResult; commit: string }>(`${BASE}/repo/import`, { method: "POST", body: { dryRun: false, policy: o.policy, prune: o.prune, allowPartial: o.allowPartial, ...(o.only ? { only: o.only } : {}) } });
      setDone(r.result.status === "unchanged" ? `Nothing to change: the site already has ${r.commit.slice(0, 7)}.` : `Imported ${r.commit.slice(0, 7)} and verified: ${Object.entries(r.result.applied).map(([k, n]) => `${n} ${k}`).join(", ")}.`);
      setPlan(null);
      router.refresh();
    });

  return (
    <div className="space-y-4">
      {error && <Alert>{error}</Alert>}
      {done && <Alert tone="success">{done}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={compare} disabled={busy !== null}>{busy === "compare" ? "Comparing…" : "Compare with Git"}</Button>
        <Button type="button" variant="secondary" size="sm" onClick={() => planImport()} disabled={busy !== null}>{busy === "plan" ? "Planning…" : "Import from Git…"}</Button>
      </div>
      {cmp && (
        <p className="text-sm text-fg-muted">
          {cmp.same ? <>Git (<span className="font-mono">{cmp.commit.slice(0, 7)}</span>) holds exactly what runs here.</> : <>Git (<span className="font-mono">{cmp.commit.slice(0, 7)}</span>) differs: {cmp.differs.length} changed, {cmp.onlyRepo.length} only in Git, {cmp.onlySite.length} only here{cmp.issues ? `, ${cmp.issues} file problems` : ""}.</>}
          {!cmp.same && <span className="mt-1 block font-mono text-xs">{[...cmp.differs.map((x) => `~ ${x}`), ...cmp.onlyRepo.map((x) => `+ ${x}`), ...cmp.onlySite.map((x) => `- ${x}`)].slice(0, 30).join("  ")}</span>}
        </p>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-0 flex-1 text-sm">
          <span className="mb-1 block text-xs font-medium text-fg-subtle">Commit message (optional)</span>
          <Input value={message} onChange={(e) => setMessage(e.target.value)} placeholder="crewconfig: configuration as it runs" />
        </label>
        <Button type="button" size="sm" onClick={write} disabled={busy !== null}>{busy === "write" ? "Writing…" : mode === "commit" ? "Write to Git (commit)" : "Write to Git (pull request)"}</Button>
      </div>
      {plan && (
        <div>
          <p className="mb-2 text-sm text-fg-muted">Plan for crewconfig/ at <span className="font-mono">{plan.commit?.slice(0, 7)}</span>.</p>
          <PlanView plan={plan} busy={busy === "apply"} applyLabel="Import" onReplan={(o) => planImport(o)} onApply={apply} />
        </div>
      )}
    </div>
  );
}
