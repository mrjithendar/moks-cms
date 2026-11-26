import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminHeader, Card, Table, td, th } from "@/components/admin/ui";
import { Ago } from "@/components/crewai/Ago";
import { AutoRefresh } from "@/components/crewai/AutoRefresh";
import { CatalogDetails } from "@/components/crewai/CatalogDetails";
import { CustomFlowEditor, type FlowSpec } from "@/components/crewai/CustomFlowEditor";
import { ItemHeader, SpecVersionList } from "@/components/crewai/ItemHeader";
import { RestoreVersionButton } from "@/components/crewai/RestoreVersionButton";
import { RunFlowButton } from "@/components/crewai/RunFlowButton";
import { RunHistory } from "@/components/crewai/RunHistory";
import { RunStatus, RunStatusIcon } from "@/components/crewai/RunStatusIcon";
import { JobsSwitch } from "@/components/news/JobsSwitch";
import { ApiButton } from "@/components/seo/ApiButton";
import { buttonClass } from "@/components/ui/form";
import { builderOptions } from "@/lib/crewai/builder-options";
import { getItem, listCategories, specVersions, syncFromAgent, type CatalogItem } from "@/lib/crewai/catalog";
import { START_LABELS } from "@/lib/crewai/catalog-shared";
import { agentCrews, agentFlows } from "@/lib/crewai/catalogue";
import { flowInfo, rerunBlocked, SCHEDULABLE_FLOWS, TRIGGER_LABELS } from "@/lib/crewai/flows";
import { formatDuration, formatUsd, runDurationMs } from "@/lib/crewai/format";
import { listRuns } from "@/lib/crewai/runs";
import { describeCron, hasSchedules, listSchedules } from "@/lib/crewai/schedules";
import { newsDeskState, newsDeskStateText } from "@/lib/news/schema";
import { getNewsSettings } from "@/lib/news/service";
import type { AgentFlow, JsonSchema } from "@/lib/seo-agent/client";

export const metadata = { title: "Flow" };

function typeOf(s: JsonSchema): string {
  const one = s.anyOf?.find((x) => x.type !== "null") ?? s;
  if (one.enum) return one.enum.map(String).join(" | ");
  if (one.type === "array") return `list of ${one.items?.enum ? one.items.enum.map(String).join(" | ") : (one.items?.type ?? "values")}`;
  return String(one.type ?? "value");
}

/**
 * One flow, whatever defines it (D-100): the same header (state, categories, tags, switch, duplicate, delete), details
 * and run history for all. Its body: a flow defined by steps has the builder (steps, Check, Test run, Run now) and its
 * versions; a flow defined in code has its parameters, schedules and Run with parameters; a content flow links to its
 * settings. A runner flow of the agent that the catalogue does not list (custom_flow, news_job_flow) keeps its page.
 */
export default async function CrewaiFlowPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  if (!/^[a-z][a-z0-9_]{1,39}$/.test(name)) notFound();
  const agent = await agentFlows();
  let item = await getItem("flow", name);
  if (!item && agent?.has(name)) {
    await syncFromAgent([...agent.values()], null);
    item = await getItem("flow", name);
  }
  if (!item) {
    if (!agent?.has(name) && flowInfo(name).group === "Other") notFound();
    return await CodeFlowBody({ name, agent, item: null }); // awaited: the page renders in one pass (and in tests)
  }
  const categories = await listCategories();
  const details = { label: item.label, description: item.description, objective: "", categories: item.categories, tags: item.tags };
  const deleted = Boolean(item.deletedAt);
  const body = item.definition === "spec" ? await SpecFlowBody({ item, agent, deleted }) : item.definition === "content" ? await ContentFlowBody({ item }) : await CodeFlowBody({ name: item.flowName ?? name, agent, item });
  return (
    <>
      <ItemHeader item={item} categories={categories} facts={item.crews.length ? <>runs {item.crews.map((c, i) => <span key={c}>{i ? ", " : ""}<Link className="hover:underline" href={`/admin/crewai/crews/${c}`}>{c}</Link></span>)}</> : undefined} />
      <div className="mb-10"><CatalogDetails kind="flow" itemKey={item.key} initial={details} categories={categories} readOnly={deleted} /></div>
      {body}
    </>
  );
}

/** A flow defined by steps: the builder and its versions. */
async function SpecFlowBody({ item, agent, deleted }: { item: CatalogItem; agent: Map<string, AgentFlow> | null; deleted: boolean }) {
  const [options, versions, runs] = await Promise.all([builderOptions(await agentCrews(), agent), specVersions("flow", item.key), listRuns({ item: item.key, limit: 20 })]);
  return (
    <>
      <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-w-0">
          {deleted ? <Card><p className="text-sm text-fg-muted">Restore this flow to edit or run it.</p></Card> : <CustomFlowEditor key={item.version} initial={(item.spec ?? {}) as unknown as FlowSpec} isNew={false} enabled={item.enabled} crews={options.crews} flows={options.flows} />}
        </div>
        <aside aria-labelledby="versions-h" className="xl:sticky xl:top-4 xl:self-start">
          <h2 id="versions-h" className="mb-2 text-base font-semibold text-fg">Versions</h2>
          <SpecVersionList versions={versions} current={item.version} restore={(v) => (deleted ? null : <RestoreVersionButton kind="flow" itemKey={item.key} version={v} />)} />
        </aside>
      </div>
      <RunHistory runs={runs} allHref={`/admin/crewai/runs?item=${item.key}`} />
    </>
  );
}

/** A content flow: its settings are its own page (sources, topics, schedule, models, quality); runs and switch here. */
async function ContentFlowBody({ item }: { item: CatalogItem }) {
  const [runs, s] = await Promise.all([listRuns({ item: item.key, limit: 20 }), getNewsSettings().catch(() => null)]);
  const desk = s ? newsDeskState(s) : null;
  return (
    <>
      <section aria-labelledby="content-h" className="space-y-4">
        <h2 id="content-h" className="text-base font-semibold text-fg">Content settings</h2>
        <p className="max-w-3xl text-sm text-fg-muted">This flow finds stories or ideas in its content sources, ranks them and drafts them for your review, on its own schedule. Its sources, topics, schedule, models and quality gates are on its settings page.</p>
        <div className="flex flex-wrap gap-2">
          {item.contentJobId && !item.deletedAt && <Link href={`/admin/crewai/flows/content/${item.contentJobId}`} className={buttonClass("primary")}>Open content settings</Link>}
          {item.contentJobId && !item.deletedAt && item.enabled && <ApiButton url={`/api/admin/news/jobs/${item.contentJobId}/actions`} body={{ action: "run" }} label="Run now" confirm="Run this content flow now? It drafts up to its per-run cap and spends from its budget." />}
          {item.contentJobId && !item.deletedAt && <ApiButton url={`/api/admin/news/jobs/${item.contentJobId}/actions`} body={{ action: "dry_run", llm: true }} label="Test run (dry run)" variant="ghost" />}
        </div>
        {desk && <JobsSwitch desk={{ on: desk.on, by: desk.by, text: newsDeskStateText(desk) }} />}
      </section>
      <RunHistory runs={runs} allHref={`/admin/crewai/runs?item=${item.key}`} />
    </>
  );
}

/** A flow defined in code (Jenkins' job page): its parameters, its schedules, the crews it runs and its last runs. */
async function CodeFlowBody({ name, agent, item }: { name: string; agent: Map<string, AgentFlow> | null; item: CatalogItem | null }) {
  const info = flowInfo(name);
  const spec = agent?.get(name) ?? null;
  const [runs, schedules] = await Promise.all([listRuns(item ? { item: item.key, limit: 20 } : { flow: name, limit: 20 }), (await hasSchedules().catch(() => false)) ? listSchedules() : Promise.resolve([])]);
  const mine = schedules.filter((s) => s.flow === name);
  const props = Object.entries(spec?.inputs_schema.properties ?? {});
  const required = new Set(spec?.inputs_schema.required ?? []);
  const blocked = item?.deletedAt
    ? "Restore this flow to start it."
    : item && !item.enabled
      ? "Switch this flow on to start it."
      : name === "crew_test_flow"
        ? "Start a crew test run from Crews → Test run."
        : item?.start === "manual"
          ? null // the agent's own rule (GET /flows), so a flow the console's list predates still starts
          : item?.start
            ? `This flow starts ${START_LABELS[item.start] ?? item.start}.`
            : rerunBlocked(name);
  const live = runs.some((r) => r.status === "queued" || r.status === "running");
  return (
    <>
      <AutoRefresh active={live} seconds={10} />
      {!item && (
        <AdminHeader title={info.label} description={<>{info.description} <code className="text-xs">{name}</code> · this flow runs other flows&apos; work and is not listed under Flows itself.</>} />
      )}
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <RunFlowButton flow={name} label={item?.label ?? info.label} schema={spec?.inputs_schema ?? null} blocked={blocked} size="md" variant="primary" />
        {blocked && <p className="text-sm text-fg-muted">{blocked}</p>}
        {item && <p className="text-xs text-fg-subtle">Steps defined in code (<code>{name}</code>). To build your own steps around it, duplicate it.</p>}
      </div>
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
            {SCHEDULABLE_FLOWS.includes(name) && <Link href={`/admin/crewai/schedules?flow=${name}`} className={buttonClass("ghost", "sm")}>Manage schedules</Link>}
          </div>
          {mine.length === 0 ? (
            <Card><p className="text-sm text-fg-muted">{name === "news_job_flow" ? <>Each content flow runs on its own time, set in that flow: <Link className="underline" href="/admin/crewai/flows?kind=content">Flows → Content flows</Link>.</> : SCHEDULABLE_FLOWS.includes(name) ? "Not scheduled: it runs only when started." : "This flow is not started by a schedule."}</p></Card>
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
          <Link href={item ? `/admin/crewai/runs?item=${item.key}` : `/admin/crewai/runs?flow=${name}`} className="text-sm text-fg-muted hover:underline">All runs of this flow</Link>
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
