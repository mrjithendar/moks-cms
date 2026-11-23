import Link from "next/link";
import { AdminHeader, Card, Table, td, th } from "@/components/admin/ui";
import { Ago } from "@/components/crewai/Ago";
import { agentCrews } from "@/lib/crewai/catalogue";
import { crewSummaries } from "@/lib/crewai/crews";
import { flowInfo } from "@/lib/crewai/flows";
import { hasSchedules } from "@/lib/crewai/schedules";
import { CREWS } from "@/lib/seo-agent/skills";
import { buttonClass } from "@/components/ui/form";
import { listCustom, usedBy, type CustomRow } from "@/lib/crewai/custom";

export const metadata = { title: "Crews" };

/** The SEO agent's crews: which configuration each one runs (a saved version or the code's defaults). */
export default async function CrewaiCrewsPage() {
  const [crews, ready, customCrews, customFlows] = await Promise.all([agentCrews(), hasSchedules().catch(() => false), listCustom("crew").catch(() => []), listCustom("flow").catch(() => [])]);
  const users = new Map(customCrews.map((c) => [c.key, usedBy(c.key, customFlows).map((f) => f.label)]));
  const summaries = ready ? await crewSummaries() : new Map();
  const list = crews ?? Object.entries(CREWS).map(([crew, label]) => ({ crew, label, description: "", agents: [], tasks: [], replay_flows: [], default_hash: "", prompt_version: "" }));
  return (
    <>
      <AdminHeader title="Crews" description="The agents and prompts of each crew. Edit a crew's agents (role, goal, backstory, model, limits, tools) and task instructions, save them as versions, try them on an earlier run with Test run, and roll back to any version or to the code's defaults." />
      {!crews && <p role="status" className="mb-6 rounded-lg border border-line bg-surface-muted p-3 text-sm text-fg-muted">The SEO agent did not answer: the crews&apos; code defaults are not shown and they cannot be edited until it is back. Saved versions stay readable.</p>}
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
      <CustomList kind="crews" rows={customCrews} users={users} />
    </>
  );
}

function CustomList({ kind, rows, users }: { kind: "crews" | "flows"; rows: CustomRow[]; users?: Map<string, string[]> }) {
  const one = kind === "crews" ? "crew" : "flow";
  return (
    <section aria-labelledby={`custom-${kind}`} className="mt-10">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id={`custom-${kind}`} className="text-base font-semibold text-fg">Custom {kind}</h2>
          <p className="mt-1 max-w-3xl text-sm text-fg-muted">{kind === "crews" ? "Crews you make here: agents with tools from the allowlist and tasks in order. They run in your custom flows, with the same rules as the built-in crews." : "Flows you make here: your custom crews, conditions on their output and drafts for the review queue. They never publish; start one by hand or from a schedule."}</p>
        </div>
        <Link href={`/admin/crewai/${kind}/custom/new`} className={buttonClass("primary", "sm")}>New {one}</Link>
      </div>
      {rows.length === 0 ? (
        <Card><p className="text-sm text-fg-muted">No custom {kind} yet.</p></Card>
      ) : (
        <Table head={<tr><th className={th}>{kind === "crews" ? "Crew" : "Flow"}</th><th className={th}>Version</th><th className={th}>{kind === "crews" ? "Used by" : "Steps"}</th><th className={th}>Changed</th></tr>}>
          {rows.map((r) => (
            <tr key={r.key} className={r.enabled ? "" : "opacity-70"}>
              <td className={td}>
                <Link href={`/admin/crewai/${kind}/custom/${r.key}`} className="font-medium text-fg hover:underline">{r.label}</Link>
                <p className="text-xs text-fg-subtle"><code>{r.key}</code>{r.enabled ? "" : " · switched off"}</p>
              </td>
              <td className={`${td} tabular-nums`}>v{r.version}</td>
              <td className={`${td} text-xs`}>{kind === "crews" ? (users?.get(r.key) ?? []).join(", ") || "no flow yet" : ((r.spec.steps as { kind: string }[] | undefined) ?? []).map((s) => s.kind).join(" → ")}</td>
              <td className={`${td} text-xs`}><Ago iso={r.updated_at} />{r.updated_by ? ` by ${r.updated_by}` : ""}</td>
            </tr>
          ))}
        </Table>
      )}
    </section>
  );
}
