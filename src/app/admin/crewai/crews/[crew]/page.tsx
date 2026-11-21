import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminHeader, Card, Table, td, th } from "@/components/admin/ui";
import { Ago } from "@/components/crewai/Ago";
import { CrewEditor, VersionActions, type SourceRun } from "@/components/crewai/CrewEditor";
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
 * One crew: the editor (loaded with ?version=N, else the active version, else the code's defaults), Test run on an
 * earlier run (?source=<run id> preselects one, as "Replay with edited prompts" on a run page links here) and the
 * version history with Activate / Use the code's defaults.
 */
export default async function CrewaiCrewPage({ params, searchParams }: { params: Promise<{ crew: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { crew: id } = await params;
  const sp = await searchParams;
  if (!CREW_ID.test(id)) notFound();
  const [crews, ready] = await Promise.all([agentCrews(), hasSchedules().catch(() => false)]);
  const crew = crews?.find((c) => c.crew === id) ?? null;
  if (crews && !crew) notFound();
  const versions = ready ? await listVersions(id) : [];
  const active = versions.find((v) => v.active) ?? null;
  const want = sp.version ? versions.find((v) => v.version === Number(sp.version)) : null;
  const loaded = sp.version === "0" ? null : (want ?? active); // ?version=0: the code's defaults
  const runs = crew ? (await Promise.all(crew.replay_flows.map((f) => listRuns({ flow: f, limit: 15 })))).flat() : [];
  const sources: SourceRun[] = runs
    .filter((r) => !["queued", "running"].includes(r.status))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, 30)
    .map((r) => ({ runId: r.runId, flow: r.flow, label: flowInfo(r.flow).label, number: r.number, status: r.status, startedAt: r.startedAt }));
  const preselect = sp.source && sources.some((s) => s.runId === sp.source) ? sp.source : null;
  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-3 text-sm text-fg-muted">
        <Link href="/admin/crewai/crews" className="hover:underline">Crews</Link>
      </nav>
      <AdminHeader
        title={crew?.label ?? id}
        description={<>{crew?.description} {crew && <>Runs <strong>{active ? `v${active.version}` : "the code's defaults"}</strong> · <code className="text-xs">{crew.prompt_version}</code></>}</>}
      />
      {sp.saved && loaded && <p role="status" className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200">Saved as v{loaded.version}{loaded.active ? ": the crew runs it from its next run" : ". Activate it below when it is ready"}.</p>}
      {sp.source && !preselect && <p role="status" className="mb-4 rounded-lg border border-line bg-surface-muted p-3 text-sm text-fg-muted">That run cannot be replayed by this crew (only finished runs of {crew?.replay_flows.join(", ")} can).</p>}
      <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0">
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
            <Card><p className="text-sm text-fg-muted">The SEO agent did not answer. The editor needs the crew&apos;s code defaults from it; the versions are listed here meanwhile.</p></Card>
          )}
        </div>
        <aside aria-labelledby="versions-h" className="xl:sticky xl:top-4 xl:self-start">
          <h2 id="versions-h" className="mb-3 text-base font-semibold text-fg">Versions</h2>
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
          {!ready && <p className="mt-2 text-xs text-fg-subtle">Versions are kept from migration 0037 on.</p>}
        </aside>
      </div>
    </>
  );
}
