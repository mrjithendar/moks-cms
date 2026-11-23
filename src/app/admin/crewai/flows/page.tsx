import Link from "next/link";
import { AdminHeader, Card, Table, td, th } from "@/components/admin/ui";
import { Ago } from "@/components/crewai/Ago";
import { ContentFlows } from "@/components/crewai/ContentFlows";
import { RunFlowButton } from "@/components/crewai/RunFlowButton";
import { RunStatusIcon } from "@/components/crewai/RunStatusIcon";
import { agentFlows } from "@/lib/crewai/catalogue";
import { FLOW_GROUPS, FLOWS, flowInfo, rerunBlocked } from "@/lib/crewai/flows";
import { overview } from "@/lib/crewai/runs";
import { describeCron, hasSchedules, listSchedules, type Schedule } from "@/lib/crewai/schedules";
import { buttonClass } from "@/components/ui/form";
import { listCustom, type CustomRow } from "@/lib/crewai/custom";

export const metadata = { title: "Flows" };

const KINDS = [
  { id: "all", label: "All flows" },
  { id: "content", label: "Content flows" },
  { id: "custom", label: "Custom flows" },
  { id: "builtin", label: "Built-in flows" },
] as const;
type Kind = (typeof KINDS)[number]["id"];

/**
 * AI & SEO → Flows: every flow in one list (Jenkins' job list). Since 2026-11-23 the admin has flows and crews only, no
 * jobs: the content flows (the crew jobs before, components/crewai/ContentFlows.tsx), the custom flows built from crews,
 * and the built-in flows with their schedules, last run and Run with parameters. ?kind=content|custom|builtin narrows it.
 */
export default async function CrewaiFlowsPage({ searchParams }: { searchParams?: Promise<Record<string, string | undefined>> } = {}) {
  const sp = (await searchParams) ?? {};
  const kind: Kind = KINDS.find((k) => k.id === sp.kind)?.id ?? "all";
  const [agent, o, schedulesReady, customFlows] = await Promise.all([agentFlows(), overview(), hasSchedules().catch(() => false), listCustom("flow").catch(() => [])]);
  const schedules = schedulesReady ? await listSchedules() : [];
  const byFlow = new Map<string, Schedule[]>();
  for (const s of schedules) byFlow.set(s.flow, [...(byFlow.get(s.flow) ?? []), s]);
  const byCustom = new Map<string, Schedule[]>();
  for (const s of byFlow.get("custom_flow") ?? []) {
    const key = typeof s.inputs.flow === "string" ? s.inputs.flow : "";
    byCustom.set(key, [...(byCustom.get(key) ?? []), s]);
  }
  const last = new Map(o.flows.map((f) => [f.flow, f.last]));
  const names = [...new Set([...FLOWS.map((f) => f.name), ...(agent ? [...agent.keys()] : [])])];
  // Awaited here, not <ContentFlows />, so the whole page renders in one pass (and in tests).
  const content = kind === "all" || kind === "content" ? await ContentFlows() : null;
  return (
    <>
      <AdminHeader
        title="Flows"
        description="Every flow the SEO agent runs: your content flows, the custom flows you built from crews, and the built-in ones. Open a flow for its settings, schedule and runs, or start it now."
        actions={
          <>
            <Link href="/admin/crewai/runs" className={buttonClass("ghost")}>Runs</Link>
            <Link href="/admin/crewai/schedules" className={buttonClass("ghost")}>Schedules</Link>
            <Link href="/admin/crewai/flows/content/new" className={buttonClass("primary")}>New content flow</Link>
          </>
        }
      />
      <nav aria-label="Kind of flow" className="mb-6 flex flex-wrap gap-2">
        {KINDS.map((k) => (
          <Link key={k.id} href={k.id === "all" ? "/admin/crewai/flows" : `/admin/crewai/flows?kind=${k.id}`} aria-current={kind === k.id ? "page" : undefined} className={`inline-flex min-h-9 items-center rounded-full border px-3 text-sm ${kind === k.id ? "border-accent bg-accent/10 font-medium text-fg" : "border-line text-fg-muted hover:text-fg"}`}>
            {k.label}
          </Link>
        ))}
      </nav>
      {content}
      {(kind === "all" || kind === "custom") && <CustomList kind="flows" rows={customFlows} schedules={byCustom} />}
      {(kind === "all" || kind === "builtin") && (
      <section aria-labelledby="builtin-flows">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="builtin-flows" className="text-base font-semibold text-fg">Built-in flows</h2>
          <p className="mt-1 max-w-3xl text-sm text-fg-muted">The flows that come with the SEO agent: drafting, insights, data syncs, promotion, the machinery behind the content flows and maintenance. Their times are on <Link href="/admin/crewai/schedules" className="underline">Schedules</Link>.</p>
        </div>
      </div>
      {!agent && <p role="status" className="mb-6 rounded-lg border border-line bg-surface-muted p-3 text-sm text-fg-muted">The SEO agent did not answer, so flows cannot be started and their parameters are not shown.</p>}
      <div className="space-y-8">
        {FLOW_GROUPS.map((group) => {
          const inGroup = names.filter((n) => flowInfo(n).group === group);
          if (inGroup.length === 0) return null;
          return (
            <section key={group} aria-labelledby={`g-${group}`}>
              <h3 id={`g-${group}`} className="mb-3 text-sm font-semibold text-fg">{group}</h3>
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
                        {name !== "crew_test_flow" && <RunFlowButton flow={name} label={info.label} schema={agent?.get(name)?.inputs_schema ?? null} blocked={rerunBlocked(name)} />}
                      </td>
                    </tr>
                  );
                })}
              </Table>
            </section>
          );
        })}
      </div>
      </section>
      )}
    </>
  );
}

/** The custom flows (built from your custom crews in the admin), with when each is scheduled. */
function CustomList({ kind, rows, schedules }: { kind: "flows"; rows: CustomRow[]; schedules: Map<string, Schedule[]> }) {
  return (
    <section aria-labelledby={`custom-${kind}`} className="mb-10">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id={`custom-${kind}`} className="text-base font-semibold text-fg">Custom flows</h2>
          <p className="mt-1 max-w-3xl text-sm text-fg-muted">Flows you build from your custom crews: conditions on their output and drafts for the review queue. They never publish; start one by hand or give it a time on <Link href="/admin/crewai/schedules?flow=custom_flow" className="underline">Schedules</Link>.</p>
        </div>
        <Link href={`/admin/crewai/${kind}/custom/new`} className={buttonClass("primary", "sm")}>New custom flow</Link>
      </div>
      {rows.length === 0 ? (
        <Card><p className="text-sm text-fg-muted">No custom flows yet. Build one from your <Link href="/admin/crewai/crews" className="underline">crews</Link>.</p></Card>
      ) : (
        <Table head={<tr><th className={th}>Flow</th><th className={th}>Version</th><th className={th}>Steps</th><th className={th}>Schedule</th><th className={th}>Changed</th></tr>}>
          {rows.map((r) => {
            const s = schedules.get(r.key) ?? [];
            return (
              <tr key={r.key} className={r.enabled ? "" : "opacity-70"}>
                <td className={td}>
                  <Link href={`/admin/crewai/${kind}/custom/${r.key}`} className="font-medium text-fg hover:underline">{r.label}</Link>
                  <p className="text-xs text-fg-subtle"><code>{r.key}</code>{r.enabled ? "" : " · switched off"}</p>
                </td>
                <td className={`${td} tabular-nums`}>v{r.version}</td>
                <td className={`${td} text-xs`}>{((r.spec.steps as { kind: string }[] | undefined) ?? []).map((x) => x.kind).join(" → ")}</td>
                <td className={`${td} text-xs`}>
                  {s.length === 0 ? <span className="text-fg-subtle">by hand</span> : s.map((x) => <p key={x.id} className={x.enabled ? "text-fg" : "text-fg-subtle line-through"}>{describeCron(x.cron)}{x.timezone !== "Etc/UTC" && x.timezone !== "UTC" ? ` (${x.timezone})` : " UTC"}</p>)}
                </td>
                <td className={`${td} text-xs`}><Ago iso={r.updated_at} />{r.updated_by ? ` by ${r.updated_by}` : ""}</td>
              </tr>
            );
          })}
        </Table>
      )}
    </section>
  );
}
