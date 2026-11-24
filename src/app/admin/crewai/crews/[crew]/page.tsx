import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, Table, td, th } from "@/components/admin/ui";
import { Ago } from "@/components/crewai/Ago";
import { CatalogDetails } from "@/components/crewai/CatalogDetails";
import { CrewEditor, VersionActions, type SourceRun } from "@/components/crewai/CrewEditor";
import { CustomCrewEditor, type CrewSpec } from "@/components/crewai/CustomCrewEditor";
import { ItemHeader, SpecVersionList } from "@/components/crewai/ItemHeader";
import { RestoreVersionButton } from "@/components/crewai/RestoreVersionButton";
import { RunHistory } from "@/components/crewai/RunHistory";
import { flowsUsing, getItem, listCategories, specVersions, syncFromAgent } from "@/lib/crewai/catalog";
import { agentCrews } from "@/lib/crewai/catalogue";
import { CREW_ID, listVersions } from "@/lib/crewai/crews";
import { flowInfo } from "@/lib/crewai/flows";
import { listRuns } from "@/lib/crewai/runs";
import { hasSchedules } from "@/lib/crewai/schedules";

export const metadata = { title: "Crew" };

const changed = (config: Record<string, unknown>) => {
  const out: string[] = [];
  for (const part of ["agents", "tasks"] as const) for (const [k, v] of Object.entries((config[part] as Record<string, Record<string, unknown>>) ?? {})) out.push(...Object.keys(v).map((f) => `${k}.${f}`));
  return out;
};

/**
 * One crew, whatever defined it (D-100): the same header (state, categories, tags, switch, duplicate, delete), details,
 * the flows that run it and its run history. Its agents and tasks: a crew defined by a spec has the spec editor (inputs,
 * agents, tasks, output, model, Check, Test run, versions); a crew defined in code has its version editor (prompts,
 * models, tools and limits over the code's defaults, Test run on an earlier run, ?version=N, ?source=<run>).
 */
export default async function CrewaiCrewPage({ params, searchParams }: { params: Promise<{ crew: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { crew: id } = await params;
  const sp = await searchParams;
  if (!CREW_ID.test(id)) notFound();
  const crews = await agentCrews();
  let item = await getItem("crew", id);
  if (!item && crews?.some((c) => c.crew === id)) {
    await syncFromAgent(null, crews);
    item = await getItem("crew", id);
  }
  if (!item) notFound();
  const [categories, users, runs] = await Promise.all([listCategories(), flowsUsing(id), listRuns({ crew: id, limit: 15 }).catch(() => [])]);
  const label = new Map(users.map((u) => [u.flowName ?? "", u.label]));
  const details = { label: item.label, description: item.description, objective: item.objective, categories: item.categories, tags: item.tags };
  const deleted = Boolean(item.deletedAt);
  const code = item.definition === "code" && !deleted ? await CodeCrewEditor({ id, crews, sp }) : null; // awaited: one render pass
  const versions = item.definition === "spec" ? await specVersions("crew", id) : [];

  return (
    <>
      <ItemHeader item={item} categories={categories} facts={item.definition === "code" ? "agents and tasks defined in code, edited as versions" : "defined by its spec"} />
      <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-10">
          <CatalogDetails kind="crew" itemKey={item.key} initial={details} categories={categories} readOnly={deleted} />
          {item.objective && <p className="-mt-6 text-sm text-fg-muted"><span className="font-medium text-fg">Objective:</span> {item.objective}</p>}
          {deleted ? (
            <Card><p className="text-sm text-fg-muted">Restore this crew to edit or test it.</p></Card>
          ) : item.definition === "spec" ? (
            <section aria-labelledby="spec-h" className="space-y-4">
              <h2 id="spec-h" className="text-base font-semibold text-fg">Inputs, agents, tasks and output</h2>
              <CustomCrewEditor key={item.version} initial={(item.spec ?? {}) as unknown as CrewSpec} isNew={false} />
            </section>
          ) : (
            code
          )}
        </div>
        <aside className="space-y-8 xl:sticky xl:top-4 xl:self-start">
          <section aria-labelledby="used-h">
            <h2 id="used-h" className="mb-2 text-base font-semibold text-fg">Run by</h2>
            {users.length === 0 ? <p className="text-sm text-fg-muted">No flow runs this crew yet: add it to a flow as a crew step.</p> : (
              <ul className="space-y-1 text-sm">{users.map((f) => <li key={f.key}><Link className="text-accent-text hover:underline" href={`/admin/crewai/flows/${f.key}`}>{f.label}</Link>{!f.enabled && <span className="ml-1 text-xs text-fg-subtle">(off)</span>}</li>)}</ul>
            )}
          </section>
          {item.definition === "spec" && (
            <section aria-labelledby="versions-h">
              <h2 id="versions-h" className="mb-2 text-base font-semibold text-fg">Versions</h2>
              <SpecVersionList versions={versions} current={item.version} restore={(v) => (deleted ? null : <RestoreVersionButton kind="crew" itemKey={id} version={v} />)} />
            </section>
          )}
        </aside>
      </div>
      <RunHistory runs={runs} allHref={`/admin/crewai/runs?crew=${id}`} labelOf={(f) => label.get(f) ?? flowInfo(f).label} />
    </>
  );
}

/** The version editor of a crew defined in code (as before migration 0041). */
async function CodeCrewEditor({ id, crews, sp }: { id: string; crews: Awaited<ReturnType<typeof agentCrews>>; sp: Record<string, string | undefined> }) {
  const crew = crews?.find((c) => c.crew === id) ?? null;
  const ready = await hasSchedules().catch(() => false);
  const versions = ready ? await listVersions(id) : [];
  const active = versions.find((v) => v.active) ?? null;
  const want = sp.version ? versions.find((v) => v.version === Number(sp.version)) : null;
  const loaded = sp.version === "0" ? null : (want ?? active);
  const runs = crew ? (await Promise.all(crew.replay_flows.map((f) => listRuns({ flow: f, limit: 15 })))).flat() : [];
  const sources: SourceRun[] = runs
    .filter((r) => !["queued", "running"].includes(r.status))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, 30)
    .map((r) => ({ runId: r.runId, flow: r.flow, label: flowInfo(r.flow).label, number: r.number, status: r.status, startedAt: r.startedAt }));
  const preselect = sp.source && sources.some((s) => s.runId === sp.source) ? sp.source : null;
  return (
    <section aria-labelledby="code-h" className="space-y-4">
      <div>
        <h2 id="code-h" className="text-base font-semibold text-fg">Agents and tasks</h2>
        <p className="text-sm text-fg-muted">Runs <strong>{active ? `v${active.version}` : "the code's defaults"}</strong>{crew ? <> · <code className="text-xs">{crew.prompt_version}</code></> : null}. Edit prompts, models, tools and limits and save them as versions; to change its structure (add or remove agents and tasks), duplicate it.</p>
      </div>
      {sp.saved && loaded && <p role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200">Saved as v{loaded.version}{loaded.active ? ": the crew runs it from its next run" : ". Activate it below when it is ready"}.</p>}
      {sp.source && !preselect && <p role="status" className="rounded-lg border border-line bg-surface-muted p-3 text-sm text-fg-muted">That run cannot be replayed by this crew (only finished runs of {crew?.replay_flows.join(", ")} can).</p>}
      {crew ? (
        <CrewEditor
          key={`${loaded?.version ?? "code"}`}
          crew={crew}
          overlay={loaded?.config ?? {}}
          loaded={{ version: loaded?.version ?? null, label: loaded ? `v${loaded.version}${loaded.note ? ` (${loaded.note})` : ""}` : "the code's defaults", baseHash: loaded?.baseHash ?? null }}
          activeVersion={active?.version ?? null}
          sources={sources}
          preselect={preselect}
        />
      ) : (
        <Card><p className="text-sm text-fg-muted">The SEO agent did not answer. The editor needs the crew&apos;s code defaults from it; the versions are listed below meanwhile.</p></Card>
      )}
      <h3 className="pt-4 text-sm font-semibold text-fg">Versions</h3>
      <Table head={<tr><th className={th}>Version</th><th className={th}><span className="sr-only">Actions</span></th></tr>}>
        <tr className={loaded == null ? "bg-surface-muted" : ""}>
          <td className={td}>
            <span className="font-medium text-fg">Code defaults</span>
            <p className="text-xs text-fg-subtle">what the agent ships with</p>
            <Link href={`/admin/crewai/crews/${id}?version=0`} className="text-xs text-accent-text hover:underline">Open in the editor</Link>
          </td>
          <td className={`${td} text-right`}><VersionActions crew={id} version={null} active={!active} /></td>
        </tr>
        {versions.map((v) => (
          <tr key={v.id} className={loaded?.version === v.version ? "bg-surface-muted" : ""}>
            <td className={td}>
              <span className="font-medium text-fg">v{v.version}</span>
              <span className="ml-2 text-xs text-fg-subtle">{v.source === "import" ? "imported" : v.source === "test" ? "from a test run" : ""}</span>
              {v.note && <p className="text-xs text-fg [overflow-wrap:anywhere]">{v.note}</p>}
              <p className="text-xs text-fg-subtle">{v.createdBy ?? "?"} · <Ago iso={v.createdAt} /></p>
              <p className="text-xs text-fg-subtle [overflow-wrap:anywhere]">{changed(v.config).join(", ") || "no changes from the defaults"}</p>
              {crew && v.baseHash && v.baseHash !== crew.default_hash && <p className="text-xs text-amber-700 dark:text-amber-300">written for older code defaults</p>}
              <Link href={`/admin/crewai/crews/${id}?version=${v.version}`} className="text-xs text-accent-text hover:underline">Open in the editor</Link>
            </td>
            <td className={`${td} text-right`}><VersionActions crew={id} version={v.version} active={v.active} /></td>
          </tr>
        ))}
      </Table>
      {!ready && <p className="text-xs text-fg-subtle">Versions are kept from migration 0037 on.</p>}
    </section>
  );
}
