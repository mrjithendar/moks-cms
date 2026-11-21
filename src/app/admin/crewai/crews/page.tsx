import Link from "next/link";
import { AdminHeader, Card, Table, td, th } from "@/components/admin/ui";
import { Ago } from "@/components/crewai/Ago";
import { AGENT_LABEL, agentOfCrew } from "@/lib/crewai/agent-of";
import { bothCrews } from "@/lib/crewai/agents";
import { crewSummaries } from "@/lib/crewai/crews";
import { flowInfo } from "@/lib/crewai/flows";
import { hasSchedules } from "@/lib/crewai/schedules";
import { CREWS } from "@/lib/seo-agent/skills";

export const metadata = { title: "Crews" };

/**
 * The crews of both agents (the news crew is the news agent's): which configuration each one runs (a saved version or
 * the code's defaults). A crew whose agent does not answer is still listed, from the skills catalogue, with a note.
 */
export default async function CrewaiCrewsPage() {
  const [{ crews: answered, reachable }, ready] = await Promise.all([bothCrews(), hasSchedules().catch(() => false)]);
  const summaries = ready ? await crewSummaries() : new Map();
  const crews = reachable.seo || reachable.news ? answered : null;
  const missing = Object.entries(CREWS)
    .filter(([crew]) => !answered.some((c) => c.crew === crew))
    .map(([crew, label]) => ({ crew, label, description: `${AGENT_LABEL[agentOfCrew(crew)]} did not answer: the code's defaults are not shown and the crew cannot be edited until it is back.`, agents: [], tasks: [], replay_flows: [], default_hash: "", prompt_version: "" }));
  const list = [...answered, ...missing];
  return (
    <>
      <AdminHeader title="Crews" description="The agents and prompts of each crew. Edit a crew's agents (role, goal, backstory, model, limits, tools) and task instructions, save them as versions, try them on an earlier run with Test run, and roll back to any version or to the code's defaults." />
      {!crews && <p role="status" className="mb-6 rounded-lg border border-line bg-surface-muted p-3 text-sm text-fg-muted">Neither agent answered: the crews&apos; code defaults are not shown and they cannot be edited until one is back. Saved versions stay readable.</p>}
      {!ready && <Card><p className="text-sm text-fg-muted">Versions are kept from database migration 0037 on (the web app applies it when it starts).</p></Card>}
      <Table head={<tr><th className={th}>Crew</th><th className={th}>Runs</th><th className={th}>Used by</th><th className={th}>Versions</th></tr>}>
        {list.map((c) => {
          const s = summaries.get(c.crew);
          const upstream = s?.active?.baseHash && c.default_hash && s.active.baseHash !== c.default_hash;
          return (
            <tr key={c.crew}>
              <td className={td}>
                <Link href={`/admin/crewai/crews/${c.crew}`} className="font-medium text-fg hover:underline">{c.label}</Link>
                {c.description && <p className="max-w-lg text-xs text-fg-subtle">{c.description}</p>}
                {c.agents.length > 0 && <p className="text-xs text-fg-subtle">{c.agents.length} agent{c.agents.length === 1 ? "" : "s"} · {c.tasks.length} task{c.tasks.length === 1 ? "" : "s"} · <code>{c.prompt_version}</code></p>}
              </td>
              <td className={`${td} text-sm`}>
                {s?.active ? (
                  <>
                    <span className="font-medium text-fg">v{s.active.version}</span>
                    {s.active.activatedAt && <span className="block text-xs text-fg-subtle">active since <Ago iso={s.active.activatedAt} /></span>}
                    {upstream && <span className="block text-xs text-amber-700 dark:text-amber-300">code defaults changed since</span>}
                  </>
                ) : "the code's defaults"}
              </td>
              <td className={`${td} text-xs`}>{c.replay_flows.map((f) => <Link key={f} href={`/admin/crewai/flows/${f}`} className="block hover:underline">{flowInfo(f).label}</Link>)}</td>
              <td className={`${td} tabular-nums`}>{s?.versions ?? 0}</td>
            </tr>
          );
        })}
      </Table>
    </>
  );
}
