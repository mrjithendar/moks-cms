import Link from "next/link";
import { Card, Table, td, th } from "@/components/admin/ui";
import { Ago } from "@/components/crewai/Ago";
import { RunStatusIcon } from "@/components/crewai/RunStatusIcon";
import { NewScheduleButton, ScheduleRowActions, type FlowOption } from "@/components/crewai/ScheduleControls";
import { agentFlows } from "@/lib/crewai/catalogue";
import { flowInfo, SCHEDULABLE_FLOWS } from "@/lib/crewai/flows";
import { describeCron, hasSchedules, listSchedules, type Schedule } from "@/lib/crewai/schedules";

const LAST: Record<string, string> = { starting: "starting", started: "started", already_running: "previous run still going", failed: "not started" };

function Last({ s }: { s: Schedule }) {
  if (!s.last.firedAt) return <span className="whitespace-nowrap text-xs text-fg-subtle">not yet</span>;
  return (
    <div className="text-xs">
      <p className="flex items-center gap-1.5 whitespace-nowrap">
        {s.last.status === "failed" ? <RunStatusIcon status="failed" /> : s.last.status === "already_running" ? <RunStatusIcon status="running" /> : null}
        {s.last.runId ? <Link href={`/admin/crewai/runs/${s.last.runId}`} className="text-fg hover:underline">{LAST[s.last.status ?? ""] ?? s.last.status}</Link> : <span className="text-fg">{LAST[s.last.status ?? ""] ?? s.last.status}</span>}
      </p>
      <p className="text-fg-subtle"><Ago iso={s.last.firedAt} /></p>
      {s.last.error && <p className="max-w-xs text-red-700 [overflow-wrap:anywhere] dark:text-red-300">{s.last.error}</p>}
    </div>
  );
}

/**
 * The system jobs on AI & SEO → Jobs (until 2026-11-21 the CrewAI console's Schedules page, D-98): when each built-in
 * flow runs (syncs, audits, reports, ML, housekeeping), kept in the database and started by the one dispatcher (the
 * seo-agent's POST /schedules/dispatch, called every minute by a single CronJob), which starts the crew jobs too.
 */
export async function SystemJobs({ flow }: { flow?: string | null }) {
  const ready = await hasSchedules().catch(() => false);
  const [schedules, agent] = await Promise.all([ready ? listSchedules() : Promise.resolve([]), agentFlows()]);
  const flows: FlowOption[] = SCHEDULABLE_FLOWS.map((n) => ({ name: n, label: flowInfo(n).label, schema: agent?.get(n)?.inputs_schema ?? null }));
  const shown = flow ? schedules.filter((s) => s.flow === flow) : schedules;
  const paused = schedules.filter((s) => !s.enabled).length;
  const failing = schedules.filter((s) => s.last.status === "failed").length;
  return (
    <section aria-labelledby="system-jobs" className="mt-10">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="system-jobs" className="text-base font-semibold text-fg">System jobs</h2>
          <p className="mt-1 max-w-3xl text-sm text-fg-muted">The built-in flows on their schedules: Search Console and GA4 syncs, audits, reports, the ML models, crew job housekeeping. One dispatcher checks these and the crew jobs every minute and starts what is due. Times are a cron expression in a time zone.</p>
        </div>
        {ready && <NewScheduleButton flows={flows} />}
      </div>
      {!ready ? (
        <Card><p className="text-sm text-fg-muted">System jobs appear once database migration 0037 is applied (the web app applies it when it starts).</p></Card>
      ) : (
        <>
          <p className="mb-4 text-sm text-fg-muted">
            {schedules.length} system job{schedules.length === 1 ? "" : "s"}{paused ? `, ${paused} paused` : ""}{failing ? `, ${failing} whose last start failed` : ""}.
            {flow && <> Showing {flowInfo(flow).label} only · <Link href="/admin/crewai/jobs?kind=system" className="underline">show all</Link>.</>}
            {" "}Nothing runs unless the dispatcher CronJob is deployed (<code>seo-flow-dispatcher</code>, every minute).
          </p>
      {/* Only the Schedule column wraps; the others stay on one line so a row is as tall as its description. */}
      <Table head={<tr><th className={th}>Schedule</th><th className={th}>When</th><th className={th}>Next</th><th className={th}>Last</th><th className={th}><span className="sr-only">Actions</span></th></tr>}>
        {shown.map((s) => (
          <tr key={s.id} className={s.enabled ? "" : "opacity-70"}>
            <td className={`${td} min-w-56`}>
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-medium text-fg">{s.name}</span>
                {s.builtin && <span className="rounded bg-surface-sunken px-1.5 py-0.5 text-[11px] leading-none text-fg-subtle">built-in</span>}
                {!s.enabled && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] leading-none text-amber-900 dark:bg-amber-500/15 dark:text-amber-200">paused</span>}
              </p>
              <p className="mt-0.5 text-xs text-fg-subtle">
                Flow <Link href={`/admin/crewai/flows/${s.flow}`} className="font-medium text-fg-muted hover:text-fg hover:underline">{flowInfo(s.flow).label}</Link>
              </p>
              {s.description && <p className="mt-0.5 max-w-md text-xs text-fg-subtle">{s.description}</p>}
              {Object.keys(s.inputs).length > 0 && <p className="mt-0.5 font-mono text-xs text-fg-subtle [overflow-wrap:anywhere]">{JSON.stringify(s.inputs)}</p>}
            </td>
            <td className={`${td} whitespace-nowrap text-xs`}>
              <p className="text-sm text-fg first-letter:uppercase">{describeCron(s.cron)}</p>
              <p className="mt-0.5 font-mono text-fg-subtle">{s.cron} · {s.timezone}</p>
            </td>
            <td className={`${td} whitespace-nowrap`}>{s.nextAt ? <Ago iso={s.nextAt} /> : <span className="text-xs text-fg-subtle">{s.enabled ? "—" : "paused"}</span>}</td>
            <td className={td}><Last s={s} /></td>
            <td className={`${td} w-px text-right`}>
              <ScheduleRowActions schedule={{ id: s.id, name: s.name, flow: s.flow, description: s.description, cron: s.cron, timezone: s.timezone, inputs: s.inputs, enabled: s.enabled, builtin: s.builtin, defaults: s.defaults }} flows={flows} agentOn={Boolean(agent)} />
            </td>
          </tr>
        ))}
      </Table>
        </>
      )}
    </section>
  );
}
