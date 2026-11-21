import Link from "next/link";
import { AdminHeader, Table, td, th } from "@/components/admin/ui";
import { Ago } from "@/components/crewai/Ago";
import { RunFlowButton } from "@/components/crewai/RunFlowButton";
import { RunStatusIcon } from "@/components/crewai/RunStatusIcon";
import { AGENT_IDS, AGENT_LABEL, agentOfFlow } from "@/lib/crewai/agent-of";
import { bothFlows } from "@/lib/crewai/agents";
import { FLOW_GROUPS, FLOWS, flowInfo, rerunBlocked } from "@/lib/crewai/flows";
import { overview } from "@/lib/crewai/runs";
import { describeCron, hasSchedules, listSchedules, type Schedule } from "@/lib/crewai/schedules";

export const metadata = { title: "Flows" };

/**
 * Every flow of both agents (Jenkins' job list): what it does, when it is scheduled, its last run, Run with parameters.
 * The seo-agent's and the news agent's flows are listed together; an agent that does not answer has its flows listed
 * with their start buttons disabled and a line saying which agent it is.
 */
export default async function CrewaiFlowsPage() {
  const [{ flows: catalogue, reachable }, o, schedulesReady] = await Promise.all([bothFlows(), overview(), hasSchedules().catch(() => false)]);
  const agent = reachable.seo || reachable.news ? catalogue : null;
  const down = AGENT_IDS.filter((a) => !reachable[a]);
  const schedules = schedulesReady ? await listSchedules() : [];
  const byFlow = new Map<string, Schedule[]>();
  for (const s of schedules) byFlow.set(s.flow, [...(byFlow.get(s.flow) ?? []), s]);
  const last = new Map(o.flows.map((f) => [f.flow, f.last]));
  const names = [...new Set([...FLOWS.map((f) => f.name), ...(agent ? [...agent.keys()] : [])])];
  return (
    <>
      <AdminHeader title="Flows" description="Every flow of the SEO agent and the news agent: what it does, when it runs, how its last run went. Open a flow for its parameters, schedules and run history, or start it with your own parameters." />
      {down.length > 0 && (
        <p role="status" className="mb-6 rounded-lg border border-line bg-surface-muted p-3 text-sm text-fg-muted">
          {down.map((a) => AGENT_LABEL[a]).join(" and ")} did not answer: {down.length === 2 ? "no flow" : "its flows"} can be started and {down.length === 2 ? "their" : "their"} parameters are not shown until it is back.
          {down.includes("news") && " The news agent is found as described in Newsroom → Settings → News agent."}
        </p>
      )}
      <div className="space-y-8">
        {FLOW_GROUPS.map((group) => {
          const inGroup = names.filter((n) => flowInfo(n).group === group);
          if (inGroup.length === 0) return null;
          return (
            <section key={group} aria-labelledby={`g-${group}`}>
              <h2 id={`g-${group}`} className="mb-3 text-base font-semibold text-fg">{group}</h2>
              <Table head={<tr><th className={th}>Flow</th><th className={th}>Schedule</th><th className={th}>Last run</th><th className={th}><span className="sr-only">Actions</span></th></tr>}>
                {inGroup.map((name) => {
                  const info = flowInfo(name);
                  const s = byFlow.get(name) ?? [];
                  const l = last.get(name);
                  const next = s.filter((x) => x.nextAt).map((x) => x.nextAt!).sort()[0];
                  return (
                    <tr key={name}>
                      <td className={td}>
                        <Link href={`/admin/crewai/flows/${name}`} className="font-medium text-fg hover:underline">{info.label}</Link>
                        <p className="max-w-xl text-xs text-fg-subtle">{info.description || <code>{name}</code>}</p>
                      </td>
                      <td className={`${td} text-xs`}>
                        {s.length === 0 ? <span className="text-fg-subtle">—</span> : (
                          <>
                            {s.map((x) => <p key={x.id} className={x.enabled ? "text-fg" : "text-fg-subtle line-through"}>{describeCron(x.cron)}{x.timezone !== "Etc/UTC" && x.timezone !== "UTC" ? ` (${x.timezone})` : " UTC"}</p>)}
                            {next && <p className="text-fg-subtle">next <Ago iso={next} /></p>}
                          </>
                        )}
                      </td>
                      <td className={td}>
                        {l ? (
                          <Link href={`/admin/crewai/runs/${l.runId}`} className="inline-flex items-center gap-1.5 hover:underline"><RunStatusIcon status={l.status} />#{l.number ?? "?"}</Link>
                        ) : <span className="text-xs text-fg-subtle">never run</span>}
                        {l && <p className="text-xs text-fg-subtle"><Ago iso={l.startedAt} /></p>}
                      </td>
                      <td className={`${td} text-right`}>
                        {name !== "crew_test_flow" && <RunFlowButton flow={name} label={info.label} schema={agent?.get(name)?.inputs_schema ?? null} blocked={rerunBlocked(name) ?? (reachable[agentOfFlow(name)] ? null : `${AGENT_LABEL[agentOfFlow(name)]} is not reachable.`)} />}
                      </td>
                    </tr>
                  );
                })}
              </Table>
            </section>
          );
        })}
      </div>
    </>
  );
}
