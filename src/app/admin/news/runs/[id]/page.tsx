import { LocalTime } from "@/components/LocalTime";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminHeader, Card, Table, td, th } from "@/components/admin/ui";
import { RunLogs } from "@/components/news/RunLogs";
import { ApiButton } from "@/components/seo/ApiButton";
import { StatusBadge } from "@/components/seo/badges";
import { runDetail, runLogs } from "@/lib/news/service";

export const metadata = { title: "Run" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PIPELINE = ["fetch", "dedupe", "classify", "score", "select", "draft", "quality", "image", "save", "notify"];

type Breakdown = { model?: string; v1_score?: number; features?: Record<string, { value: number; weight: number; contribution: number }>; contributions?: Record<string, number> };

/** Run detail: step timeline, live log, candidates with score breakdowns and decisions, drafts, retry / rerun. */
export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const d = await runDetail(id);
  if (!d) notFound();
  const { run, steps, candidates, articles } = d;
  const logs = await runLogs(id, 0);
  const live = ["queued", "running"].includes(String(run.status));
  const counters = run.counters as Record<string, number>;
  const byStep = new Map<string, Record<string, unknown>[]>();
  for (const s of steps) byStep.set(String(s.step), [...(byStep.get(String(s.step)) ?? []), s]);
  const extra = [...byStep.keys()].filter((k) => !PIPELINE.includes(k));
  return (
    <>
      <AdminHeader
        title={String(run.job_name ?? run.kind)}
        description={<>Started <LocalTime iso={String(run.started_at)} /> · Trigger {String(run.trigger)}{run.dry_run ? " · dry run (nothing saved to the review queue)" : ""} · job version {String(run.job_version ?? "—")} · ${(Number(run.cost_usd) + Number(run.image_cost_usd)).toFixed(3)} ({Number(run.tokens).toLocaleString("en")} tokens){run.parent_run_id ? <> · retry of <Link className="underline" href={`/admin/news/runs/${String(run.parent_run_id)}`}>{String(run.parent_run_id).slice(0, 8)}</Link></> : null}</>}
        actions={
          run.job_id && !live ? (
            <>
              <ApiButton url={`/api/admin/news/runs/${id}`} body={{ mode: "failed" }} label="Retry failed drafts" />
              <ApiButton url={`/api/admin/news/runs/${id}`} body={{ mode: "rerun" }} label="Rerun job" variant="ghost" confirm="Rerun the whole job? Stories already drafted are skipped." />
            </>
          ) : undefined
        }
      />
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <StatusBadge status={String(run.status)} />
        {run.error_summary ? <p className="text-sm text-red-700 dark:text-red-300 [overflow-wrap:anywhere]">{String(run.error_summary)}</p> : null}
      </div>
      <section aria-labelledby="timeline" className="mb-8">
        <h2 id="timeline" className="mb-3 text-sm font-semibold text-fg">Timeline</h2>
        <ol className="flex flex-wrap gap-2">
          {[...PIPELINE, ...extra].map((name) => {
            const ss = byStep.get(name) ?? [];
            const failed = ss.some((s) => s.status === "failed");
            const done = ss.length > 0 && ss.every((s) => s.status === "succeeded" || s.status === "skipped");
            const running = ss.some((s) => s.status === "running");
            const secs = ss.reduce((n, s) => n + Number((s.detail as { seconds?: number })?.seconds ?? 0), 0);
            const out = ss.reduce((n, s) => n + Number(s.output_count ?? 0), 0);
            const tone = failed ? "border-red-300 bg-red-50 dark:border-red-500/40 dark:bg-red-500/10" : done ? "border-emerald-300 bg-emerald-50 dark:border-emerald-500/30 dark:bg-emerald-500/10" : running ? "border-sky-300 bg-sky-50 dark:bg-sky-500/10" : "border-line bg-surface-muted opacity-60";
            return (
              <li key={name} className={`min-w-[7rem] rounded-lg border p-2 text-xs ${tone}`}>
                <p className="font-semibold text-fg">{name}{ss.length > 1 ? ` ×${ss.length}` : ""}</p>
                <p className="text-fg-subtle">{ss.length ? `${failed ? "failed" : running ? "running" : "done"} · ${out} out · ${secs.toFixed(1)} s` : "not run"}</p>
                {failed && <p className="mt-1 text-red-700 dark:text-red-300 [overflow-wrap:anywhere]">{String(ss.find((s) => s.status === "failed")?.error ?? "")}</p>}
              </li>
            );
          })}
        </ol>
        <p className="mt-3 text-xs text-fg-subtle">{Object.entries(counters).map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`).join(" · ") || "No counters yet."}</p>
      </section>
      <div className="mb-8"><RunLogs runId={id} initial={logs} live={live} /></div>
      <section aria-labelledby="drafts" className="mb-8">
        <h2 id="drafts" className="mb-3 text-sm font-semibold text-fg">Articles from this run</h2>
        {articles.length === 0 ? (
          <Card><p className="text-sm text-fg-muted">None.</p></Card>
        ) : (
          <ul className="space-y-2">
            {articles.map((a) => {
              const q = a.quality as { failed?: string[] };
              return (
                <li key={String(a.id)} className="flex flex-wrap items-center gap-3 rounded-lg border border-line p-3 text-sm">
                  <StatusBadge status={String(a.status)} />
                  <span className="font-medium text-fg">{String(a.title ?? "(no title)")}</span>
                  <span className="text-xs text-fg-subtle">{String(a.mode)} · ${Number(a.cost_usd).toFixed(3)}</span>
                  {q?.failed?.length ? <span className="text-xs text-red-700 dark:text-red-300">failed: {q.failed.join(", ")}</span> : null}
                  {a.draft_id ? <Link className="ml-auto underline" href={`/admin/review/${String(a.draft_id)}`}>Review →</Link> : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <section aria-labelledby="cands">
        <h2 id="cands" className="mb-3 text-sm font-semibold text-fg">Candidates ({candidates.length})</h2>
        {candidates.length === 0 ? (
          <Card><p className="text-sm text-fg-muted">No candidates were scored in this run.</p></Card>
        ) : (
          <Table head={<tr><th className={th}>Story</th><th className={th}>Score</th><th className={th}>Why</th><th className={th}>Decision</th></tr>}>
            {candidates.map((c) => {
              const b = c.breakdown as Breakdown;
              const feats = b.features ?? {};
              return (
                <tr key={String(c.cluster_id)} className="border-t border-line">
                  <td className={`${td} max-w-sm`}><span className="font-medium text-fg [overflow-wrap:anywhere]">{String(c.title)}</span><p className="text-xs text-fg-subtle">{Number(c.source_count)} source{Number(c.source_count) === 1 ? "" : "s"} · {(c.topics as { slug: string }[]).map((t) => t.slug).join(", ") || "no topic"}</p></td>
                  <td className={`${td} tabular-nums`}>{Number(c.score).toFixed(3)}<p className="text-xs text-fg-subtle">{String(c.model_version)}{b.v1_score !== undefined ? ` (v1 ${b.v1_score.toFixed(3)})` : ""}</p></td>
                  <td className={td}>
                    <details>
                      <summary className="cursor-pointer text-xs">breakdown</summary>
                      <div className="overflow-x-auto"><table className="mt-2 text-xs">
                        <tbody>
                          {Object.entries(feats).sort((x, y) => y[1].contribution - x[1].contribution).map(([k, v]) => (
                            <tr key={k}><td className="pr-3">{k.replace(/_/g, " ")}</td><td className="pr-3 tabular-nums">{v.value.toFixed(2)} × {v.weight.toFixed(2)}</td><td className="tabular-nums">= {v.contribution.toFixed(3)}</td></tr>
                          ))}
                          {b.contributions && Object.entries(b.contributions).map(([k, v]) => <tr key={`m-${k}`}><td className="pr-3">model: {k}</td><td colSpan={2} className="tabular-nums">{v >= 0 ? "+" : ""}{v.toFixed(3)}</td></tr>)}
                        </tbody>
                      </table></div>
                    </details>
                  </td>
                  <td className={`${td} text-xs`}><span className={c.decision === "selected" ? "font-semibold text-emerald-700 dark:text-emerald-300" : ""}>{String(c.decision)}</span><p className="text-fg-subtle [overflow-wrap:anywhere]">{String(c.reason)}</p></td>
                </tr>
              );
            })}
          </Table>
        )}
      </section>
    </>
  );
}
