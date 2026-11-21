import Link from "next/link";
import { AdminHeader, Card, StatusPill } from "@/components/admin/ui";
import { ApiButton } from "@/components/seo/ApiButton";
import { ModelOverride } from "@/components/seo/ModelOverride";
import { fmtWhen, Section } from "@/components/seo/ui";
import type { MlKind } from "@/lib/seo-intel/ml";
import { listProposals, modelsView, type ModelRow } from "@/lib/seo-intel/ml-admin";

export const metadata = { title: "ML models" };
export const dynamic = "force-dynamic";

const pct = (v: unknown) => (typeof v === "number" ? `${(v * 100).toFixed(1)} %` : "—");
const num = (v: unknown, d = 3) => (typeof v === "number" ? v.toFixed(d) : "—");

/** One comparison table per model: the held-out numbers that decide activation, model next to rule. */
function Comparison({ m }: { m: ModelRow }) {
  const x = m.latest?.metrics ?? {};
  const r = m.latest?.ruleMetrics ?? {};
  const get = (o: Record<string, unknown>, ...path: string[]) => path.reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined), o);
  const rows: Record<MlKind, [string, string, string][]> = {
    decay: [
      ["False alarms on noise (held-out synthetic: stable weeks + holiday dips)", pct(get(x, "benchmark", "false_alarm_rate")), pct(get(r, "benchmark", "false_alarm_rate"))],
      ["Sustained drops caught (held-out synthetic)", pct(get(x, "benchmark", "drop_recall")), pct(get(r, "benchmark", "drop_recall"))],
      ["Alert rate in the real back-test (page × 2-week windows)", pct(get(x, "backtest", "model_alert_rate")), pct(get(x, "backtest", "rule_alert_rate"))],
      ["Agreement with the rule (Jaccard of flagged page-windows)", num(get(x, "backtest", "agreement_jaccard")), "—"],
    ],
    query_clusters: [
      ["Adjusted Rand index (owner-labelled sample)", num(x.ari), num(r.ari)],
      ["Purity", num(x.purity), num(r.purity)],
      ["Inverse purity (groups kept whole)", num(x.inverse_purity), num(r.inverse_purity)],
      ["Labelled queries scored", String(x.labelled ?? 0), ""],
    ],
    intent: [
      ["Macro-F1 vs held-out Haiku labels", num(x.macro_f1), num(r.macro_f1)],
      ["Answered without Claude (confidence ≥ threshold)", pct(x.share_confident), "—"],
      ["Accuracy when confident", pct(x.accuracy_when_confident), "—"],
      ["Spot-checked disagreements", `${x.spot_checked ?? 0} / ${Math.min(50, Number(x.disagreements ?? 0))}`, ""],
    ],
    priority: [
      ["NDCG@10 on held-out outcomes (proposed weights vs current)", num(x.ndcg10_proposed), num(x.ndcg10_current)],
      ["LightGBM's own ranking (reference)", num(x.ndcg10_lightgbm), ""],
      ["Implemented recommendations with a 28-day outcome", `${x.n ?? 0} / 50`, ""],
    ],
    related: [
      ["A/B: related_click rate (even ids = model, odd = rule)", "experiment running", ""],
      ["Reader co-visitation data (GA4 page pairs)", x.with_covisit ? "yes" : "no", ""],
      ["Days into the experiment (needs ≥ 28)", String(x.experiment_days ?? 0), ""],
    ],
  };
  return (
    <div className="overflow-x-auto"><table className="mt-3 w-full text-left text-sm tabular-nums">
      <thead>
        <tr className="text-xs text-fg-subtle">
          <th className="py-1 pr-3 font-medium">Held-out metric</th>
          <th className="pr-3 font-medium">Model {m.latest?.version ?? ""}</th>
          <th className="font-medium">Rule</th>
        </tr>
      </thead>
      <tbody>
        {rows[m.kind].map(([label, a, b]) => (
          <tr key={label} className="border-t border-line">
            <td className="py-1.5 pr-3 text-fg-muted">{label}</td>
            <td className="pr-3">{a}</td>
            <td>{b}</td>
          </tr>
        ))}
      </tbody>
    </table></div>
  );
}

export default async function ModelsPage() {
  const [{ models, ragEval, migrated }, proposals] = await Promise.all([modelsView(), listProposals(3)]);
  return (
    <>
      <AdminHeader
        title="ML models"
        description="Models trained weekly by the SEO agent (seo_ml_flow). A model is used only when it beats its rule on held-out data (and, where noted, after your review); otherwise, or when its output is older than 14 days, the site uses the rule. Every number on the site says which one made it."
        actions={<ApiButton url="/api/admin/seo/models/run" label="Run now" confirm="Start seo_ml_flow now? It trains every model (a few minutes, no Claude calls unless you asked for label suggestions)." />}
      />
      {!migrated && <Card className="mb-6"><p className="text-sm text-fg-muted">Migration 0019 is not applied yet: every feature uses its rule.</p></Card>}
      <Section title="Labelling tasks for you" description="Your labels are the ground truth the clustering and intent models are judged against.">
        <Card>
          <ul className="space-y-1 text-sm">
            <li>
              <Link className="underline" href="/admin/models/labels?task=cluster">Query groupings</Link>: {models.find((m) => m.kind === "query_clusters")?.pendingLabels ?? 0} waiting. Claude suggests groups for a 200-query sample; you confirm or change them.{" "}
              <ApiButton url="/api/admin/seo/models/run" body={{ models: ["query_clusters"], suggestLabels: true }} label="Ask Claude for suggestions" confirm="One Claude Haiku call (well under $0.01) suggests groupings for 200 queries. Continue?" />
            </li>
            <li>
              <Link className="underline" href="/admin/models/labels?task=intent_check">Intent disagreements</Link>: {models.find((m) => m.kind === "intent")?.pendingLabels ?? 0} waiting. The classifier is used only after you have checked 50.
            </li>
          </ul>
        </Card>
      </Section>
      <div className="space-y-6">
        {models.map((m) => (
          <Card key={m.kind}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="flex flex-wrap items-center gap-2 font-semibold text-fg">
                  {m.title}
                  <StatusPill status={m.decision.mode === "model" ? "ok" : m.latest?.beatsRule ? "degraded" : "not configured"} />
                  <span className="text-sm font-normal text-fg-muted">The site uses: <strong>{m.decision.label}</strong></span>
                </h2>
                <p className="mt-1 text-sm text-fg-muted">{m.decision.reason}.</p>
              </div>
              <ModelOverride kind={m.kind} value={m.decision.override} />
            </div>
            {m.latest ? (
              <>
                <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,1fr)]">
                  <dt className="text-fg-subtle">Version</dt><dd>{m.latest.version}{m.latest.active ? " (active)" : ""}</dd>
                  <dt className="text-fg-subtle">Trained</dt><dd>{fmtWhen(m.latest.trainedAt)}</dd>
                  <dt className="text-fg-subtle">Data size</dt><dd>{m.latest.nSamples}</dd>
                  <dt className="text-fg-subtle">Status</dt><dd>{m.latest.status.replace(/_/g, " ")}{m.latest.beatsRule ? " · beats the rule" : ""}</dd>
                  <dt className="text-fg-subtle">Output</dt><dd>{m.outputAt ? <>{fmtWhen(m.outputAt)}{m.stale ? " (stale)" : ""}</> : m.kind === "priority" ? "proposals only" : "none"}</dd>
                  <dt className="text-fg-subtle">Reviewed</dt><dd>{m.latest.reviewedBy ? <>{m.latest.reviewedBy}, {fmtWhen(m.latest.reviewedAt)}</> : "—"}</dd>
                </dl>
                {m.latest.notes && <p className="mt-2 text-sm text-fg-muted">{m.latest.notes}</p>}
                <Comparison m={m} />
                {m.kind === "decay" && m.latest.status === "needs_review" && (
                  <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
                    <span className="text-fg-muted">It beat the rule on held-out series. Review the real back-test above, then:</span>
                    <ApiButton url="/api/admin/seo/models/decay" method="PUT" body={{ approveReview: true }} label="Reviewed: use the model" variant="primary" />
                  </div>
                )}
                {m.kind === "priority" && proposals[0]?.status === "proposed" && <p className="mt-3 text-sm">A weights proposal is waiting: <Link className="underline" href="/admin/automation?section=scoring">Settings → Scoring &amp; rules</Link>.</p>}
                {m.history.length > 1 && (
                  <details className="mt-3 text-sm">
                    <summary className="cursor-pointer text-fg-muted">Earlier versions ({m.history.length - 1})</summary>
                    <ul className="mt-1 space-y-0.5 text-xs text-fg-subtle">
                      {m.history.slice(1).map((h) => <li key={h.version}>{h.version} · {fmtWhen(h.trainedAt)} · {h.status.replace(/_/g, " ")}{h.beatsRule ? " · beat the rule" : ""}{h.active ? " · active" : ""}</li>)}
                    </ul>
                  </details>
                )}
              </>
            ) : (
              <p className="mt-3 text-sm text-fg-muted">Not trained yet. The weekly CronJob (seo-flow-ml) or “Run now” trains it.</p>
            )}
          </Card>
        ))}
      </div>
      <Section title="Retrieval evaluation (live index)" description="The 55-question eval set run weekly against the live Ask-the-Blog retriever (docs/seo/RAG.md).">
        <Card>
          {ragEval ? (
            <p className="text-sm text-fg-muted">
              {fmtWhen(ragEval.at)} · mode {String(ragEval.metrics.mode ?? "?")} · Recall@3 {pct(ragEval.metrics["recall@3"])} · MRR {num(ragEval.metrics.mrr)} · anchor hits {pct(ragEval.metrics.anchor_hit_rate)} · calibrated floor {String(ragEval.metrics.calibrated_floor ?? "—")}
            </p>
          ) : (
            <p className="text-sm text-fg-muted">No run against the live index yet.</p>
          )}
        </Card>
      </Section>
    </>
  );
}
