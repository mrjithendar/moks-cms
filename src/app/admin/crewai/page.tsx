import Link from "next/link";
import { AdminHeader, Card, Table, td, th } from "@/components/admin/ui";
import { Ago } from "@/components/crewai/Ago";
import { AutoRefresh } from "@/components/crewai/AutoRefresh";
import { RunStatusIcon } from "@/components/crewai/RunStatusIcon";
import { buttonClass } from "@/components/ui/form";
import { flowInfo, STATUS_LABELS } from "@/lib/crewai/flows";
import { formatDuration, formatTokens, formatUsd, percent, runDurationMs } from "@/lib/crewai/format";
import { overview, type FlowHealth, type Overview } from "@/lib/crewai/runs";

export const metadata = { title: "Overview" };

const runHref = (id: string) => `/admin/crewai/runs/${id}`;

function Health({ recent }: { recent: string[] }) {
  const done = recent.filter((s) => s === "succeeded" || s === "failed");
  const ok = done.filter((s) => s === "succeeded").length;
  const rate = done.length ? ok / done.length : null;
  const [label, dot] = rate == null ? ["No finished runs", "bg-slate-300 dark:bg-white/20"] : rate >= 0.8 ? ["Healthy", "bg-emerald-500"] : rate >= 0.4 ? ["Unstable", "bg-amber-500"] : ["Failing", "bg-red-500"];
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap" title={rate == null ? undefined : `${ok} of the last ${done.length} finished runs succeeded`}>
      <span className={`h-2.5 w-2.5 rounded-full ${dot}`} aria-hidden="true" />
      {label}
      {rate != null && <span className="text-fg-subtle">· {Math.round(rate * 100)}%</span>}
    </span>
  );
}

/** The last ten runs, oldest first (left), as small status squares. */
function Recent({ recent }: { recent: string[] }) {
  const tone: Record<string, string> = { succeeded: "bg-emerald-500", failed: "bg-red-500", running: "bg-amber-400", queued: "bg-slate-300 dark:bg-white/25", cancelled: "bg-slate-300 dark:bg-white/25", paused_budget: "bg-amber-600" };
  const list = [...recent].reverse();
  return (
    <span className="inline-flex gap-0.5" role="img" aria-label={`Last ${list.length} runs, oldest first: ${list.map((s) => STATUS_LABELS[s] ?? s).join(", ")}`}>
      {list.map((s, i) => <span key={i} className={`h-3.5 w-2 rounded-sm ${tone[s] ?? "bg-slate-300"}`} title={STATUS_LABELS[s] ?? s} />)}
    </span>
  );
}

function PerDay({ days }: { days: Overview["perDay"] }) {
  const max = Math.max(1, ...days.map((d) => d.succeeded + d.failed + d.other));
  const total = days.reduce((n, d) => n + d.succeeded + d.failed + d.other, 0);
  return (
    <Card>
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-fg">Runs per day</h2>
        <p className="text-xs text-fg-subtle">last 14 days (UTC) · {total} runs</p>
      </div>
      {days.length === 0 ? (
        <p className="text-sm text-fg-muted">No runs in the last 14 days.</p>
      ) : (
        <ol className="flex h-28 items-end gap-1" aria-label="Runs per day: succeeded, failed and other">
          {days.map((d) => {
            const h = (n: number) => `${(n / max) * 100}%`;
            return (
              <li key={d.day} className="flex h-full min-w-0 flex-1 flex-col justify-end" title={`${d.day}: ${d.succeeded} succeeded, ${d.failed} failed, ${d.other} other`}>
                <span className="sr-only">{`${d.day}: ${d.succeeded} succeeded, ${d.failed} failed, ${d.other} other`}</span>
                <span className="block rounded-t-sm bg-slate-300 dark:bg-white/20" style={{ height: h(d.other) }} aria-hidden="true" />
                <span className="block bg-red-500" style={{ height: h(d.failed) }} aria-hidden="true" />
                <span className="block rounded-b-sm bg-emerald-500" style={{ height: h(d.succeeded) }} aria-hidden="true" />
              </li>
            );
          })}
        </ol>
      )}
      <p className="mt-2 flex flex-wrap gap-3 text-xs text-fg-subtle">
        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-emerald-500" aria-hidden="true" />Succeeded</span>
        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-red-500" aria-hidden="true" />Failed</span>
        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-slate-300 dark:bg-white/20" aria-hidden="true" />Other</span>
      </p>
    </Card>
  );
}

function FlowTable({ flows }: { flows: FlowHealth[] }) {
  if (flows.length === 0) return <Card><p className="text-sm text-fg-muted">No flow has run yet. Runs appear here as soon as the SEO agent starts one (on its schedule, from the review queue, or from MCP).</p></Card>;
  return (
    <Table head={<tr><th className={th}>Flow</th><th className={th}>Health</th><th className={th}>Last 10</th><th className={th}>Last run</th><th className={th}>Median time</th><th className={th}>Runs (7 d)</th><th className={th}>Cost (7 d)</th></tr>}>
      {flows.map((f) => {
        const info = flowInfo(f.flow);
        return (
          <tr key={f.flow}>
            <td className={td}>
              <Link href={`/admin/crewai/runs?flow=${f.flow}`} className="font-medium text-fg hover:underline">{info.label}</Link>
              <p className="text-xs text-fg-subtle">{info.group} · <code>{f.flow}</code></p>
            </td>
            <td className={`${td} text-sm`}><Health recent={f.recent} /></td>
            <td className={td}><Recent recent={f.recent} /></td>
            <td className={td}>
              <Link href={runHref(f.last.runId)} className="inline-flex items-center gap-1.5 hover:underline">
                <RunStatusIcon status={f.last.status} />#{f.last.number ?? "?"}
              </Link>
              <p className="text-xs text-fg-subtle"><Ago iso={f.last.startedAt} /></p>
            </td>
            <td className={`${td} tabular-nums`}>{formatDuration(f.medianMs)}</td>
            <td className={`${td} tabular-nums`}>{f.runs7d}{f.failed7d ? <span className="ml-1 text-xs text-red-700 dark:text-red-300">({f.failed7d} failed)</span> : null}</td>
            <td className={`${td} tabular-nums`}>{formatUsd(f.cost7d)}</td>
          </tr>
        );
      })}
    </Table>
  );
}

/** Overview: what runs now, how the last day and week went, each flow's health, and recent failures. */
export default async function CrewaiOverviewPage() {
  const o = await overview();
  const finished7 = o.week.succeeded + o.week.failed;
  return (
    <>
      <AutoRefresh active={o.active.length > 0} seconds={10} />
      <AdminHeader
        title="CrewAI console"
        description="Every run of the SEO agent's flows and crews: what is running now, what failed and why, cost and health per flow. Open a run for its steps and full log."
        actions={<Link href="/admin/crewai/runs" className={buttonClass("primary", "sm")}>All runs</Link>}
      />
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Runs, last 24 hours" value={o.day.runs} hint={`${o.day.succeeded} succeeded · ${o.day.failed} failed · ${o.day.active} running`} />
        <Stat label="Success rate, 7 days" value={percent(o.week.succeeded, finished7)} hint={`of ${finished7} finished runs`} />
        <Stat label="Median run time, 7 days" value={formatDuration(o.week.p50Ms)} hint={`95th percentile ${formatDuration(o.week.p95Ms)}`} />
        <Stat label="Model cost, 7 days" value={formatUsd(o.week.costUsd)} hint={`${formatTokens(o.week.tokens)} tokens`} />
      </div>
      <div className="mb-8 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card>
          <div className="mb-3 flex items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold text-fg">Running now</h2>
            <Link href="/admin/crewai/runs?status=active" className="text-xs text-fg-muted hover:underline">See all</Link>
          </div>
          {o.active.length === 0 ? (
            <p className="text-sm text-fg-muted">Nothing is running.</p>
          ) : (
            <ul className="divide-y divide-line">
              {o.active.map((r) => (
                <li key={r.runId} className="flex items-center gap-3 py-2">
                  <RunStatusIcon status={r.status} />
                  <Link href={runHref(r.runId)} className="min-w-0 flex-1 truncate text-sm font-medium text-fg hover:underline">{flowInfo(r.flow).label} #{r.number ?? "?"}</Link>
                  <span className="truncate font-mono text-xs text-fg-subtle">{r.currentStep ?? r.status}</span>
                  <span className="text-xs tabular-nums text-fg-subtle">{formatDuration(runDurationMs(r.startedAt, null))}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <PerDay days={o.perDay} />
      </div>
      <section aria-labelledby="flows" className="mb-8">
        <h2 id="flows" className="mb-3 text-base font-semibold text-fg">Flows</h2>
        <FlowTable flows={o.flows} />
      </section>
      <section aria-labelledby="failures" className="mb-8">
        <h2 id="failures" className="mb-3 text-base font-semibold text-fg">Recent failures</h2>
        {o.failures.length === 0 ? (
          <Card><p className="text-sm text-fg-muted">No failed runs in the last 7 days.</p></Card>
        ) : (
          <ul className="space-y-2">
            {o.failures.map((r) => (
              <li key={r.runId}>
                <Link href={runHref(r.runId)} className="flex items-start gap-3 rounded-xl border border-line bg-surface p-3 hover:bg-surface-muted">
                  <RunStatusIcon status="failed" className="mt-0.5" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-fg">{flowInfo(r.flow).label} #{r.number ?? "?"} <span className="font-normal text-fg-subtle">· <Ago iso={r.startedAt} /></span></span>
                    <span className="mt-0.5 block truncate text-xs text-red-700 dark:text-red-300">{r.error ?? r.outcome ?? "Failed"}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function Stat({ label, value, hint }: { label: string; value: string | number; hint: string }) {
  return (
    <Card className="!p-4">
      <p className="text-xs font-medium text-fg-subtle">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight text-fg tabular-nums">{value}</p>
      <p className="mt-1 text-xs text-fg-subtle">{hint}</p>
    </Card>
  );
}
