import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { Card, Table, td, th } from "@/components/admin/ui";
import { Ago } from "@/components/crewai/Ago";
import { AutoRefresh } from "@/components/crewai/AutoRefresh";
import { LogViewer, type StepView } from "@/components/crewai/LogViewer";
import { RunActions } from "@/components/crewai/RunActions";
import { RunStatus, RunStatusIcon } from "@/components/crewai/RunStatusIcon";
import { LocalTime } from "@/components/LocalTime";
import { flowInfo, rerunBlocked, TRIGGER_LABELS } from "@/lib/crewai/flows";
import { formatDuration, formatTokens, formatUsd, runDurationMs } from "@/lib/crewai/format";
import { runDetail, runLogs, type RunDetail, type RunStep } from "@/lib/crewai/runs";

export const metadata = { title: "Run" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FIRST_PAGE = 5000;

/** Steps by name, in first-run order: a step that ran more than once (a validator retry) shows its last result. */
function stepViews(steps: RunStep[]): StepView[] {
  const out = new Map<string, StepView>();
  for (const s of steps) {
    const prev = out.get(s.step);
    out.set(s.step, { step: s.step, status: s.status, error: s.error ?? (s.status === "succeeded" ? null : (prev?.error ?? null)), seconds: s.seconds == null && prev?.seconds == null ? null : (prev?.seconds ?? 0) + (s.seconds ?? 0), count: (prev?.count ?? 0) + 1 });
  }
  return [...out.values()];
}

function Json({ value }: { value: Record<string, unknown> }) {
  const empty = Object.keys(value).length === 0;
  return <pre className="max-h-96 overflow-auto rounded-lg border border-line bg-surface-muted p-3 font-mono text-xs leading-5 text-fg [overflow-wrap:anywhere] whitespace-pre-wrap">{empty ? "{}" : JSON.stringify(value, null, 2)}</pre>;
}

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-fg-subtle">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium text-fg [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

/** Links to what the run produced (outputs written by the flow). */
function artifacts(run: RunDetail): { label: string; href: string }[] {
  const o = run.outputs;
  const out: { label: string; href: string }[] = [];
  const draft = (typeof o.draft_id === "string" && o.draft_id) || run.draftId;
  if (draft && UUID.test(draft)) out.push({ label: "Draft in the review queue", href: `/admin/review/${draft}` });
  if (typeof o.article_id === "string" && UUID.test(o.article_id)) out.push({ label: "Article", href: `/admin/posts/${o.article_id}` });
  if (typeof o.report_id === "string" && UUID.test(o.report_id)) out.push({ label: "Report", href: `/admin/reports/${o.report_id}` });
  return out;
}

/** One run: GitHub Actions' run page (steps, annotations, summary, log) plus the crew's cost per agent and model. */
export default async function CrewaiRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const run = await runDetail(id);
  if (!run) notFound();
  const info = flowInfo(run.flow);
  const logs = await runLogs(id, 0, { limit: FIRST_PAGE });
  const live = run.status === "queued" || run.status === "running";
  const ms = runDurationMs(run.startedAt, run.finishedAt);
  const steps = stepViews(run.steps);
  const errors = Array.isArray(run.outputs.errors) ? (run.outputs.errors as unknown[]).map(String).filter((e) => e && e !== run.error) : [];
  const links = artifacts(run);
  const cost = run.usage.reduce((n, u) => n + u.costUsd, 0);
  return (
    <>
      <AutoRefresh active={live} seconds={5} />
      <nav aria-label="Breadcrumb" className="mb-3 text-sm text-fg-muted">
        <Link href="/admin/crewai/runs" className="hover:underline">Runs</Link>
        <span className="mx-1.5 text-fg-subtle">/</span>
        <Link href={`/admin/crewai/runs?flow=${run.flow}`} className="hover:underline">{info.label}</Link>
      </nav>
      <header className="mb-6 flex flex-col gap-4 border-b border-line pb-6 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <h1 className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xl font-semibold tracking-tight text-fg">
            <RunStatusIcon status={run.status} size={24} />
            <span>{info.label} <span className="font-normal text-fg-subtle">#{run.number ?? "?"}</span></span>
          </h1>
          <p className="mt-1.5 text-sm text-fg-muted">
            <RunStatus status={run.status} /> · {TRIGGER_LABELS[run.triggeredBy] ?? run.triggeredBy}{run.actor ? ` by ${run.actor}` : ""} · started <Ago iso={run.startedAt} />
            {run.outcome ? <> · outcome <span className="font-mono">{run.outcome}</span></> : null}
          </p>
          <p className="mt-1 text-xs text-fg-subtle">
            <code>{run.flow}</code> · run <code>{run.runId}</code>
            {run.previous && <> · <Link className="hover:underline" href={`/admin/crewai/runs/${run.previous.runId}`}>← #{run.previous.number}</Link></>}
            {run.next && <> · <Link className="hover:underline" href={`/admin/crewai/runs/${run.next.runId}`}>#{run.next.number} →</Link></>}
          </p>
        </div>
        <RunActions runId={run.runId} live={live} inputs={run.inputs} blocked={rerunBlocked(run.flow)} />
      </header>

      {(run.status === "failed" || run.status === "paused_budget" || errors.length > 0) && (
        <section aria-labelledby="annotations" className="mb-6 rounded-xl border border-red-200 bg-red-50 p-4 dark:border-red-500/30 dark:bg-red-500/10">
          <h2 id="annotations" className="mb-1 flex items-center gap-2 text-sm font-semibold text-red-800 dark:text-red-200">
            <RunStatusIcon status={run.status === "paused_budget" ? "paused_budget" : "failed"} decorative />
            {run.status === "paused_budget" ? "Paused: the model budget was reached" : `${errors.length + (run.error ? 1 : 0) || 1} error${errors.length + (run.error ? 1 : 0) > 1 ? "s" : ""}`}
          </h2>
          <ul className="space-y-1 text-sm text-red-900 dark:text-red-100 [overflow-wrap:anywhere]">
            {run.error && <li>{run.error}</li>}
            {errors.map((e, i) => <li key={i}>{e}</li>)}
            {!run.error && errors.length === 0 && <li>{run.outcome ? `Outcome: ${run.outcome.replace(/_/g, " ")}.` : "The run did not finish."}</li>}
          </ul>
        </section>
      )}

      <div className="grid gap-6 lg:grid-cols-[15rem_minmax(0,1fr)]">
        <aside className="lg:sticky lg:top-4 lg:self-start">
          <nav aria-label="Run" className="space-y-5 text-sm">
            <div>
              <a href="#summary" className="block rounded-md px-2 py-1.5 font-medium text-fg hover:bg-surface-sunken">Summary</a>
            </div>
            <div>
              <p className="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-fg-subtle">Steps</p>
              {steps.length === 0 ? (
                <p className="px-2 text-xs text-fg-subtle">{run.history ? (live ? "Waiting for the first step…" : "No steps were recorded.") : "Steps are recorded from migration 0036 on."}</p>
              ) : (
                <ol>
                  {steps.map((s) => (
                    <li key={s.step}>
                      <a href="#run-log" className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-surface-sunken">
                        <RunStatusIcon status={s.status} />
                        <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg">{s.step}{s.count > 1 ? ` ×${s.count}` : ""}</span>
                        <span className="text-xs tabular-nums text-fg-subtle">{s.seconds != null ? formatDuration(s.seconds * 1000) : ""}</span>
                      </a>
                    </li>
                  ))}
                </ol>
              )}
            </div>
            <div>
              <p className="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-fg-subtle">Run details</p>
              <a href="#cost" className="block rounded-md px-2 py-1.5 text-fg-muted hover:bg-surface-sunken hover:text-fg">Cost by agent</a>
              <a href="#io" className="block rounded-md px-2 py-1.5 text-fg-muted hover:bg-surface-sunken hover:text-fg">Inputs and outputs</a>
              {run.children.length > 0 && <a href="#children" className="block rounded-md px-2 py-1.5 text-fg-muted hover:bg-surface-sunken hover:text-fg">Runs it started ({run.children.length})</a>}
            </div>
          </nav>
        </aside>

        <div className="min-w-0 space-y-6">
          <section id="summary" aria-label="Summary">
            <Card className="!p-4">
              <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-6">
                <Meta label="Status"><RunStatus status={run.status} /></Meta>
                <Meta label={live ? "Running for" : "Total duration"}>{formatDuration(ms)}</Meta>
                <Meta label="Started"><LocalTime iso={run.startedAt} /></Meta>
                <Meta label="Tokens">{formatTokens(run.tokens)}</Meta>
                <Meta label="Model cost">{formatUsd(run.costUsd || cost)}</Meta>
                <Meta label="Target"><span className="block truncate font-mono text-xs" title={run.targetId}>{run.targetId}</span></Meta>
              </dl>
              {(links.length > 0 || run.parent || run.transcripts > 0) && (
                <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 border-t border-line pt-3 text-sm">
                  {links.map((l) => <Link key={l.href} href={l.href} className="font-medium text-accent-text hover:underline">{l.label} →</Link>)}
                  {run.parent && (
                    <span className="text-fg-muted">
                      Started by <Link href={`/admin/crewai/runs/${run.parent.runId}`} className="font-medium text-fg hover:underline">{flowInfo(run.parent.flow).label} #{run.parent.number ?? "?"}</Link>
                    </span>
                  )}
                  {run.transcripts > 0 && <span className="text-fg-muted">{run.transcripts} model call transcript{run.transcripts === 1 ? "" : "s"} kept: open them from the log.</span>}
                </div>
              )}
            </Card>
          </section>

          <LogViewer runId={run.runId} initial={logs} live={live} steps={steps} runStatus={run.status} hasMore={logs.length === FIRST_PAGE} />

          {run.children.length > 0 && (
            <section id="children" aria-labelledby="children-h">
              <h2 id="children-h" className="mb-3 text-base font-semibold text-fg">Runs it started</h2>
              <Table head={<tr><th className={th}>Run</th><th className={th}>Status</th><th className={th}>Target</th><th className={th}>Duration</th><th className={th}>Cost</th></tr>}>
                {run.children.map((c) => (
                  <tr key={c.runId}>
                    <td className={td}><Link href={`/admin/crewai/runs/${c.runId}`} className="font-medium text-fg hover:underline">{flowInfo(c.flow).label} #{c.number ?? "?"}</Link></td>
                    <td className={td}><RunStatus status={c.status} /></td>
                    <td className={`${td} font-mono text-xs`}>{c.targetId}</td>
                    <td className={`${td} tabular-nums`}>{formatDuration(runDurationMs(c.startedAt, c.finishedAt))}</td>
                    <td className={`${td} tabular-nums`}>{formatUsd(c.costUsd)}</td>
                  </tr>
                ))}
              </Table>
            </section>
          )}

          <section id="cost" aria-labelledby="cost-h">
            <h2 id="cost-h" className="mb-3 text-base font-semibold text-fg">Cost by agent and model</h2>
            {run.usage.length === 0 ? (
              <Card><p className="text-sm text-fg-muted">This run made no model calls{live ? " yet" : ""}.</p></Card>
            ) : (
              <Table head={<tr><th className={th}>Agent</th><th className={th}>Model</th><th className={th}>Calls</th><th className={th}>Tokens in / out</th><th className={th}>Model time</th><th className={th}>Cost</th></tr>}>
                {run.usage.map((u) => (
                  <tr key={`${u.agent}:${u.model}`}>
                    <td className={`${td} font-medium text-fg`}>{u.agent ?? "—"}</td>
                    <td className={`${td} font-mono text-xs`}>{u.model}</td>
                    <td className={`${td} tabular-nums`}>{u.calls}{u.failed ? <span className="ml-1 text-xs text-red-700 dark:text-red-300">({u.failed} failed)</span> : null}</td>
                    <td className={`${td} tabular-nums`}>{u.inputTokens.toLocaleString("en")} / {u.outputTokens.toLocaleString("en")}</td>
                    <td className={`${td} tabular-nums`}>{formatDuration(u.latencyMs)}</td>
                    <td className={`${td} tabular-nums`}>{formatUsd(u.costUsd)}</td>
                  </tr>
                ))}
              </Table>
            )}
          </section>

          <section id="io" aria-labelledby="io-h" className="grid gap-4 xl:grid-cols-2">
            <h2 id="io-h" className="sr-only">Inputs and outputs</h2>
            <div>
              <h3 className="mb-2 text-sm font-semibold text-fg">Inputs</h3>
              <Json value={run.inputs} />
            </div>
            <div>
              <h3 className="mb-2 text-sm font-semibold text-fg">Outputs</h3>
              <Json value={run.outputs} />
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
