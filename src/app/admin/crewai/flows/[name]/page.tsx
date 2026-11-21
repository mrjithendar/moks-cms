import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminHeader, Card, Table, td, th } from "@/components/admin/ui";
import { Ago } from "@/components/crewai/Ago";
import { AutoRefresh } from "@/components/crewai/AutoRefresh";
import { RunFlowButton } from "@/components/crewai/RunFlowButton";
import { RunStatus, RunStatusIcon } from "@/components/crewai/RunStatusIcon";
import { buttonClass } from "@/components/ui/form";
import { agentFlows } from "@/lib/crewai/catalogue";
import { flowInfo, rerunBlocked, SCHEDULABLE_FLOWS, TRIGGER_LABELS } from "@/lib/crewai/flows";
import { formatDuration, formatUsd, runDurationMs } from "@/lib/crewai/format";
import { listRuns } from "@/lib/crewai/runs";
import { describeCron, hasSchedules, listSchedules } from "@/lib/crewai/schedules";
import type { JsonSchema } from "@/lib/seo-agent/client";

export const metadata = { title: "Flow" };

function typeOf(s: JsonSchema): string {
  const one = s.anyOf?.find((x) => x.type !== "null") ?? s;
  if (one.enum) return one.enum.map(String).join(" | ");
  if (one.type === "array") return `list of ${one.items?.enum ? one.items.enum.map(String).join(" | ") : (one.items?.type ?? "values")}`;
  return String(one.type ?? "value");
}

/** One flow (Jenkins' job page): what it does, its parameters, its schedules, the crews it runs and its last runs. */
export default async function CrewaiFlowPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const info = flowInfo(name);
  const agent = await agentFlows();
  const spec = agent?.get(name) ?? null;
  if (info.group === "Other" && !spec) notFound();
  const [runs, schedules] = await Promise.all([listRuns({ flow: name, limit: 20 }), (await hasSchedules().catch(() => false)) ? listSchedules() : Promise.resolve([])]);
  const mine = schedules.filter((s) => s.flow === name);
  const props = Object.entries(spec?.inputs_schema.properties ?? {});
  const required = new Set(spec?.inputs_schema.required ?? []);
  const blocked = name === "crew_test_flow" ? "Start a crew test run from Crews → Test run." : rerunBlocked(name);
  const live = runs.some((r) => r.status === "queued" || r.status === "running");
  return (
    <>
      <AutoRefresh active={live} seconds={10} />
      <nav aria-label="Breadcrumb" className="mb-3 text-sm text-fg-muted">
        <Link href="/admin/crewai/flows" className="hover:underline">Flows</Link>
        <span className="mx-1.5 text-fg-subtle">/</span>
        <span>{info.group}</span>
      </nav>
      <AdminHeader
        title={info.label}
        description={<>{info.description} <code className="text-xs">{name}</code></>}
        actions={<RunFlowButton flow={name} label={info.label} schema={spec?.inputs_schema ?? null} blocked={blocked} size="md" variant="primary" />}
      />
      {blocked && <p className="-mt-3 mb-6 text-sm text-fg-muted">{blocked}</p>}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <section aria-labelledby="params-h">
          <h2 id="params-h" className="mb-3 text-base font-semibold text-fg">Parameters</h2>
          {!spec ? (
            <Card><p className="text-sm text-fg-muted">The SEO agent did not answer: parameters come from its code.</p></Card>
          ) : props.length === 0 ? (
            <Card><p className="text-sm text-fg-muted">This flow takes no parameters.</p></Card>
          ) : (
            <Table head={<tr><th className={th}>Name</th><th className={th}>Type</th><th className={th}>Default</th></tr>}>
              {props.map(([k, s]) => (
                <tr key={k}>
                  <td className={`${td} font-mono text-xs text-fg`}>{k}{required.has(k) ? <span className="ml-1 text-red-700 dark:text-red-300" title="required">*</span> : null}</td>
                  <td className={`${td} min-w-32 text-xs [overflow-wrap:anywhere]`}>{typeOf(s)}</td>
                  <td className={`${td} font-mono text-xs`}>{s.default === undefined ? "—" : JSON.stringify(s.default)}</td>
                </tr>
              ))}
            </Table>
          )}
          {spec && spec.crews.length > 0 && (
            <p className="mt-3 text-sm text-fg-muted">
              Runs the {spec.crews.map((c, i) => <span key={c}>{i ? ", " : ""}<Link className="font-medium text-accent-text hover:underline" href={`/admin/crewai/crews/${c}`}>{c} crew</Link></span>)}: edit its prompts and replay a run below with them.
            </p>
          )}
        </section>
        <section aria-labelledby="sched-h">
          <div className="mb-3 flex items-baseline justify-between gap-2">
            <h2 id="sched-h" className="text-base font-semibold text-fg">Schedules</h2>
            {SCHEDULABLE_FLOWS.includes(name) && <Link href={`/admin/crewai/jobs?kind=system&flow=${name}`} className={buttonClass("ghost", "sm")}>Manage schedules</Link>}
          </div>
          {mine.length === 0 ? (
            <Card><p className="text-sm text-fg-muted">{SCHEDULABLE_FLOWS.includes(name) ? "Not scheduled: it runs only when started." : "This flow is not started by a schedule."}</p></Card>
          ) : (
            <Table head={<tr><th className={th}>Schedule</th><th className={th}>When</th><th className={th}>Next</th></tr>}>
              {mine.map((s) => (
                <tr key={s.id}>
                  <td className={td}><span className="font-medium text-fg">{s.name}</span>{!s.enabled && <span className="ml-2 text-xs text-amber-700 dark:text-amber-300">paused</span>}{Object.keys(s.inputs).length > 0 && <p className="font-mono text-xs text-fg-subtle">{JSON.stringify(s.inputs)}</p>}</td>
                  <td className={`${td} text-xs`}>{describeCron(s.cron)} <span className="text-fg-subtle">({s.timezone})</span></td>
                  <td className={`${td} text-xs`}>{s.nextAt ? <Ago iso={s.nextAt} /> : "—"}</td>
                </tr>
              ))}
            </Table>
          )}
        </section>
      </div>
      <section aria-labelledby="history-h" className="mt-8">
        <div className="mb-3 flex items-baseline justify-between gap-2">
          <h2 id="history-h" className="text-base font-semibold text-fg">Run history</h2>
          <Link href={`/admin/crewai/runs?flow=${name}`} className="text-sm text-fg-muted hover:underline">All runs of this flow</Link>
        </div>
        {runs.length === 0 ? (
          <Card><p className="text-sm text-fg-muted">No runs yet.</p></Card>
        ) : (
          <Table head={<tr><th className={th}>Run</th><th className={th}>Status</th><th className={th}>Trigger</th><th className={th}>Started</th><th className={th}>Duration</th><th className={th}>Cost</th></tr>}>
            {runs.map((r) => (
              <tr key={r.runId}>
                <td className={td}><Link href={`/admin/crewai/runs/${r.runId}`} className="inline-flex items-center gap-1.5 font-medium text-fg hover:underline"><RunStatusIcon status={r.status} />#{r.number ?? "?"}</Link></td>
                <td className={td}><RunStatus status={r.status} /></td>
                <td className={`${td} text-xs`}>{TRIGGER_LABELS[r.triggeredBy] ?? r.triggeredBy}{r.actor ? <span className="block text-fg-subtle">{r.actor}</span> : null}</td>
                <td className={`${td} text-xs`}><Ago iso={r.startedAt} /></td>
                <td className={`${td} tabular-nums`}>{formatDuration(runDurationMs(r.startedAt, r.finishedAt))}</td>
                <td className={`${td} tabular-nums`}>{formatUsd(r.costUsd)}</td>
              </tr>
            ))}
          </Table>
        )}
      </section>
    </>
  );
}
