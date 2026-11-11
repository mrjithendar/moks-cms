import Link from "next/link";
import { Card } from "@/components/admin/ui";
import { ApiButton } from "@/components/seo/ApiButton";
import { ModelOverride } from "@/components/seo/ModelOverride";
import { fmtWhen } from "@/components/seo/ui";
import { listProposals, modelsView } from "@/lib/seo-intel/ml-admin";

const INPUTS = ["searchOpportunity", "rankingOpportunity", "relevance", "qualityGap", "trend", "effort"] as const;

export async function loadMlSettings() {
  const [view, proposals] = await Promise.all([modelsView(), listProposals(3)]);
  return { ...view, proposals };
}

/**
 * Settings → "ML models & retrieval" (v5): what each model-backed feature uses right now, with the override; the
 * retrieval mode of the last live evaluation; and the learned weight proposal, side by side with the current weights
 * and both rankings' held-out NDCG@10, to approve or dismiss (never applied automatically).
 */
export function MlSettingsCard({ data }: { data: Awaited<ReturnType<typeof loadMlSettings>> }) {
  const open = data.proposals.find((p) => p.status === "proposed");
  const rag = data.ragEval;
  return (
    <Card className="mb-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold text-fg">ML models &amp; retrieval</h2>
        <Link href="/admin/models" className="text-sm underline">Metrics, versions and labelling →</Link>
      </div>
      {!data.migrated && <p className="mt-2 text-sm text-fg-muted">Migration 0019 is not applied yet: every feature uses its rule.</p>}
      <ul className="mt-3 divide-y divide-line">
        {data.models.map((m) => (
          <li key={m.kind} className="grid gap-1 py-2 text-sm sm:grid-cols-[16rem_1fr_auto] sm:items-center sm:gap-3">
            <span className="font-medium text-fg">{m.title}</span>
            <span className="text-fg-muted">
              Uses <strong>{m.decision.label}</strong> · {m.decision.reason}
              {m.pendingLabels > 0 && <> · <Link className="underline" href={`/admin/models/labels?task=${m.kind === "intent" ? "intent_check" : "cluster"}`}>{m.pendingLabels} labels waiting</Link></>}
            </span>
            {m.kind === "priority" ? <span className="text-xs text-fg-subtle">proposals only</span> : <ModelOverride kind={m.kind} value={m.decision.override} />}
          </li>
        ))}
      </ul>
      <div className="mt-4 border-t border-line pt-3 text-sm text-fg-muted">
        <p>
          <strong className="text-fg">Retrieval</strong> (Ask the Blog, MCP search, crews): mode and diversification are seo-agent settings (<code>RAG_MODE</code>, <code>RAG_MAX_PER_ARTICLE</code>, <code>ASK_BLOG_MIN_SCORE</code> in the <code>seo-agent-config</code> ConfigMap; defaults vector, 3, 0.66 from the eval set).{" "}
          {rag ? <>Last live evaluation {fmtWhen(rag.at)}: mode {String(rag.metrics.mode ?? "?")}, Recall@3 {typeof rag.metrics["recall@3"] === "number" ? `${((rag.metrics["recall@3"] as number) * 100).toFixed(1)} %` : "—"}.</> : "No live evaluation yet."}
        </p>
      </div>
      <div className="mt-4 border-t border-line pt-3">
        <h3 className="text-sm font-semibold text-fg">Scoring weights proposal</h3>
        {open ? (
          <>
            <p className="mt-1 text-sm text-fg-muted">
              Learned from {open.nOutcomes} implemented recommendations ({open.modelVersion}, {fmtWhen(open.createdAt)}). Held-out NDCG@10: proposed {Number(open.metrics.ndcg10_proposed ?? 0).toFixed(3)} vs current {Number(open.metrics.ndcg10_current ?? 0).toFixed(3)}. Observational data, not a controlled experiment.
            </p>
            <table className="mt-2 w-full max-w-lg text-left text-sm tabular-nums">
              <thead><tr className="text-xs text-fg-subtle"><th className="py-1 font-medium">Input</th><th className="font-medium">Current</th><th className="font-medium">Proposed</th></tr></thead>
              <tbody>
                {INPUTS.map((k) => (
                  <tr key={k} className="border-t border-line">
                    <td className="py-1 text-fg-muted">{k}</td>
                    <td>{open.currentWeights[k] ?? "—"}</td>
                    <td className={open.weights[k] !== open.currentWeights[k] ? "font-semibold text-fg" : ""}>{open.weights[k] ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-3 flex gap-2">
              <ApiButton url={`/api/admin/seo/models/proposals/${open.id}`} body={{ decision: "approve" }} label="Approve: use these weights" variant="primary" confirm="Replace the scoring weights with the proposed ones? Recommendations are re-scored on the next analysis run; the change is audit-logged and can be edited back in Scoring weights." />
              <ApiButton url={`/api/admin/seo/models/proposals/${open.id}`} body={{ decision: "dismiss" }} label="Dismiss" />
            </div>
          </>
        ) : (
          <p className="mt-1 text-sm text-fg-muted">
            {(() => {
              const p = data.models.find((m) => m.kind === "priority")?.latest;
              return p?.status === "collecting_data" ? `Collecting data: ${p.nSamples}/50 implemented recommendations with a 28-day outcome.` : "No open proposal.";
            })()}
          </p>
        )}
      </div>
    </Card>
  );
}
