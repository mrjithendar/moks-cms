import Link from "next/link";
import { AdminHeader, Card, Table, td, th } from "@/components/admin/ui";
import { Ago } from "@/components/crewai/Ago";
import { RunStatusIcon } from "@/components/crewai/RunStatusIcon";
import { NewScheduleButton, ScheduleRowActions, type FlowOption } from "@/components/crewai/ScheduleControls";
import { agentFlows } from "@/lib/crewai/catalogue";
import { flowInfo, SCHEDULABLE_FLOWS } from "@/lib/crewai/flows";
import { describeCron, hasSchedules, listSchedules, type Schedule } from "@/lib/crewai/schedules";

export const metadata = { title: "Schedules" };

const LAST: Record<string, string> = { starting: "starting", started: "started", already_running: "previous run still going", failed: "not started" };

function Last({ s }: { s: Schedule }) {
  if (!s.last.firedAt) return <span className="text-xs text-fg-subtle">not yet</span>;
  return (
    <div className="text-xs">
      <p className="flex items-center gap-1.5">
        {s.last.status === "failed" ? <RunStatusIcon status="failed" /> : s.last.status === "already_running" ? <RunStatusIcon status="running" /> : null}
        {s.last.runId ? <Link href={`/admin/crewai/runs/${s.last.runId}`} className="text-fg hover:underline">{LAST[s.last.status ?? ""] ?? s.last.status}</Link> : <span className="text-fg">{LAST[s.last.status ?? ""] ?? s.last.status}</span>}
      </p>
      <p className="text-fg-subtle"><Ago iso={s.last.firedAt} /></p>
      {s.last.error && <p className="max-w-xs text-red-700 [overflow-wrap:anywhere] dark:text-red-300">{s.last.error}</p>}
    </div>
  );
}

/**
 * Schedules (D-98): when each flow runs, kept in the database and started by one dispatcher (the seo-agent's
 * POST /schedules/dispatch, called every minute by a single CronJob) instead of a CronJob per flow.
 */
export default async function CrewaiSchedulesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const ready = await hasSchedules().catch(() => false);
  const [schedules, agent] = await Promise.all([ready ? listSchedules() : Promise.resolve([]), agentFlows()]);
  const flows: FlowOption[] = SCHEDULABLE_FLOWS.map((n) => ({ name: n, label: flowInfo(n).label, schema: agent?.get(n)?.inputs_schema ?? null }));
  const shown = sp.flow ? schedules.filter((s) => s.flow === sp.flow) : schedules;
  const paused = schedules.filter((s) => !s.enabled).length;
  const failing = schedules.filter((s) => s.last.status === "failed").length;
  return (
    <>
      <AdminHeader
        title="Schedules"
        description="When each SEO agent flow runs. One dispatcher checks these every minute and starts what is due; each run says which schedule started it. Times are a cron expression in a time zone."
        actions={ready ? <NewScheduleButton flows={flows} /> : undefined}
      />
      {!ready ? (
        <Card><p className="text-sm text-fg-muted">Schedules appear once database migration 0037 is applied (the web app applies it when it starts).</p></Card>
      ) : (
        <>
          <p className="mb-4 text-sm text-fg-muted">
            {schedules.length} schedule{schedules.length === 1 ? "" : "s"}{paused ? `, ${paused} paused` : ""}{failing ? `, ${failing} whose last start failed` : ""}.
            {sp.flow && <> Showing {flowInfo(sp.flow).label} only · <Link href="/admin/crewai/schedules" className="underline">show all</Link>.</>}
            {" "}Nothing runs unless the dispatcher CronJob is deployed (<code>seo-flow-dispatcher</code>, every minute).
          </p>
          <Table head={<tr><th className={th}>Schedule</th><th className={th}>Flow</th><th className={th}>When</th><th className={th}>Next</th><th className={th}>Last</th><th className={th}><span className="sr-only">Actions</span></th></tr>}>
            {shown.map((s) => (
              <tr key={s.id} className={s.enabled ? "" : "opacity-70"}>
                <td className={td}>
                  <span className="font-medium text-fg">{s.name}</span>
                  {s.builtin && <span className="ml-2 rounded bg-surface-sunken px-1.5 py-0.5 text-[11px] text-fg-subtle">built-in</span>}
                  {!s.enabled && <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-900 dark:bg-amber-500/15 dark:text-amber-200">paused</span>}
                  {s.description && <p className="max-w-sm text-xs text-fg-subtle">{s.description}</p>}
                  {Object.keys(s.inputs).length > 0 && <p className="font-mono text-xs text-fg-subtle [overflow-wrap:anywhere]">{JSON.stringify(s.inputs)}</p>}
                </td>
                <td className={td}><Link href={`/admin/crewai/flows/${s.flow}`} className="text-fg hover:underline">{flowInfo(s.flow).label}</Link></td>
                <td className={`${td} text-xs`}>
                  <p className="text-fg">{describeCron(s.cron)}</p>
                  <p className="font-mono text-fg-subtle">{s.cron} · {s.timezone}</p>
                </td>
                <td className={`${td} text-xs`}>{s.nextAt ? <Ago iso={s.nextAt} /> : "—"}</td>
                <td className={td}><Last s={s} /></td>
                <td className={`${td} text-right`}>
                  <ScheduleRowActions schedule={{ id: s.id, name: s.name, flow: s.flow, description: s.description, cron: s.cron, timezone: s.timezone, inputs: s.inputs, enabled: s.enabled, builtin: s.builtin, defaults: s.defaults }} flows={flows} agentOn={Boolean(agent)} />
                </td>
              </tr>
            ))}
          </Table>
        </>
      )}
    </>
  );
}
