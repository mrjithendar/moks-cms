import Link from "next/link";
import { Suspense } from "react";
import { AdminHeader, Card } from "@/components/admin/ui";
import { Ago } from "@/components/crewai/Ago";
import { AutoRefresh } from "@/components/crewai/AutoRefresh";
import { RunFilters } from "@/components/crewai/RunFilters";
import { RunStatusIcon } from "@/components/crewai/RunStatusIcon";
import { FLOWS, flowInfo, RUN_STATUSES, STATUS_LABELS, TRIGGER_LABELS, TRIGGERS } from "@/lib/crewai/flows";
import { formatDuration, formatTokens, formatUsd, runDurationMs } from "@/lib/crewai/format";
import { flowsWithRuns, listRuns } from "@/lib/crewai/runs";
import { allItems, listCategories } from "@/lib/crewai/catalog";
import { contentOfRuns, getJob } from "@/lib/news/service";

export const metadata = { title: "Runs" };
const PAGE = 50;

/**
 * All runs, newest first (GitHub Actions' "All workflows"): filter by flow, status, trigger or text; 50 a page. Since
 * 2026-11-23 this is also where content flow runs are (the Job runs page before): ?content=<id> shows one content flow's
 * runs, and a content flow's run carries its name, what it drafted and its cost with cover images.
 */
export default async function CrewaiRunsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const content = sp.content && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sp.content) ? sp.content.toLowerCase() : null;
  // ?item=<catalogue key> (a flow of AI & SEO → Flows), or ?item=flow:<agent flow> for runs of a flow not listed there.
  const agentFlow = sp.item?.startsWith("flow:") ? sp.item.slice(5) : null;
  const filter = { flow: sp.flow ?? agentFlow, content, status: sp.status ?? null, trigger: sp.trigger ?? null, q: sp.q ?? null, item: agentFlow ? null : (sp.item ?? null), category: sp.category ?? null, crew: sp.crew ?? null, from: sp.from ?? null, to: sp.to ?? null };
  const [runs, seen, contentFlow, catalogFlows, catalogCrews, cats] = await Promise.all([
    listRuns({ ...filter, before: sp.before ?? null, limit: PAGE }),
    flowsWithRuns(),
    content ? getJob(content).catch(() => null) : Promise.resolve(null),
    allItems("flow").catch(() => []),
    allItems("crew").catch(() => []),
    listCategories().catch(() => []),
  ]);
  const item = filter.item ? (catalogFlows.find((f) => f.key === filter.item) ?? null) : null;
  const ofRun = await contentOfRuns(runs.filter((r) => r.flow.startsWith("news_")).map((r) => r.runId)).catch(() => new Map<string, never>());
  const names = [...new Set([...FLOWS.map((f) => f.name), ...seen])];
  // Every flow of the catalogue by its name (no kinds of flow); agent flows not in it (runners, a newer agent) after them.
  const listed = new Set(catalogFlows.filter((f) => f.definition === "code").map((f) => f.flowName));
  const flows = [
    { group: "Flows", options: catalogFlows.map((f) => ({ value: f.key, label: f.label })) },
    { group: "Other runs", options: names.filter((n) => !listed.has(n)).map((n) => ({ value: `flow:${n}`, label: flowInfo(n).label })) },
  ].filter((g) => g.options.length);
  const categories = cats.map((c) => ({ value: c.slug, label: c.label }));
  const crews = catalogCrews.map((c) => ({ value: c.key, label: c.label }));
  const statuses = [{ value: "active", label: "Queued or in progress" }, ...RUN_STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s] ?? s }))];
  const triggers = TRIGGERS.map((t) => ({ value: t, label: TRIGGER_LABELS[t] ?? t }));
  const older = () => {
    const p = new URLSearchParams(Object.entries(filter).filter((e): e is [string, string] => Boolean(e[1])));
    p.set("before", runs[runs.length - 1]!.startedAt);
    return `/admin/crewai/runs?${p}`;
  };
  const live = runs.some((r) => r.status === "queued" || r.status === "running");
  const title = contentFlow ? `${contentFlow.name} runs` : item ? `${item.label} runs` : filter.flow ? `${flowInfo(filter.flow).label} runs` : "All runs";
  return (
    <>
      <AutoRefresh active={live} />
      <AdminHeader
        title={title}
        description={contentFlow ? <>Runs of this content flow, and the cover image, training and other runs it started. <Link className="underline" href={`/admin/crewai/flows/content/${contentFlow.id}`}>Edit the flow</Link> · <Link className="underline" href="/admin/crewai/runs">all runs</Link></> : filter.flow ? (flowInfo(filter.flow).description || <code>{filter.flow}</code>) : "Every run of every flow, content flows included, newest first. Open one for its steps, log, inputs, outputs and cost."}
      />
      <Suspense>
        <RunFilters flows={flows} statuses={statuses} triggers={triggers} categories={categories} crews={crews} flowParam="item" />
      </Suspense>
      {runs.length === 0 ? (
        <Card>
          <p className="text-sm text-fg-muted">{Object.values(filter).some(Boolean) || sp.before ? "No runs match these filters." : "No runs yet. Runs appear as soon as the SEO agent starts a flow."}</p>
        </Card>
      ) : (
        <div className="overflow-hidden rounded-xl border border-line bg-surface">
          <p className="border-b border-line bg-surface-muted px-4 py-2 text-xs font-semibold text-fg-subtle">{runs.length === PAGE ? `${PAGE}+ runs` : `${runs.length} run${runs.length === 1 ? "" : "s"}`}{sp.before ? " (older page)" : ""}</p>
          <ul className="divide-y divide-line">
            {runs.map((r) => {
              const info = flowInfo(r.flow);
              const c = ofRun.get(r.runId);
              const drafted = c ? Number(c.counters.drafted ?? 0) : 0;
              const ms = runDurationMs(r.startedAt, r.finishedAt);
              const active = r.status === "queued" || r.status === "running";
              return (
                <li key={r.runId} className="relative flex flex-col gap-2 px-4 py-3 hover:bg-surface-muted sm:flex-row sm:items-center sm:gap-4">
                  <div className="flex min-w-0 flex-1 items-start gap-3">
                    <RunStatusIcon status={r.status} size={18} className="mt-0.5" />
                    <div className="min-w-0">
                      <Link href={`/admin/crewai/runs/${r.runId}`} className="font-semibold text-fg after:absolute after:inset-0 hover:underline">
                        {c?.name && r.flow === "news_job_flow" ? c.name : info.label} <span className="font-normal text-fg-subtle">#{r.number ?? "?"}</span>
                      </Link>
                      <p className="mt-0.5 truncate text-xs text-fg-subtle">
                        {c?.name && r.flow === "news_job_flow" ? `${info.label} · ` : c?.name ? `${c.name} · ` : ""}
                        {TRIGGER_LABELS[r.triggeredBy] ?? r.triggeredBy}
                        {r.actor ? ` by ${r.actor}` : ""}
                        {c?.dryRun ? " · dry run" : ""}
                        {c && r.flow === "news_job_flow" && !active ? ` · ${drafted} drafted` : ""}
                        {r.targetId && r.targetId !== "site" && !r.targetId.startsWith("job:") ? <> · <span className="font-mono">{r.targetId.length > 20 ? `${r.targetId.slice(0, 8)}…` : r.targetId}</span></> : null}
                        {active && r.currentStep ? <> · step <span className="font-mono">{r.currentStep}</span></> : null}
                        {r.outcome && !active ? ` · ${r.outcome.replace(/_/g, " ")}` : ""}
                      </p>
                      {r.status === "failed" && r.error && <p className="mt-1 line-clamp-1 text-xs text-red-700 dark:text-red-300 [overflow-wrap:anywhere]">{r.error}</p>}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-4 pl-8 text-xs text-fg-subtle sm:pl-0">
                    <span className="hidden rounded-full border border-line px-2 py-0.5 md:inline">{info.group}</span>
                    <span className="w-24 tabular-nums" title="Tokens · model cost">{r.tokens || r.costUsd ? `${formatTokens(r.tokens)} · ${formatUsd(Math.max(r.costUsd, c?.costUsd ?? 0))}` : c?.costUsd ? formatUsd(c.costUsd) : "no model calls"}</span>
                    <span className="w-28 text-right">
                      <Ago iso={r.startedAt} />
                      <span className="block tabular-nums">{active ? `${formatDuration(ms)} so far` : formatDuration(ms)}</span>
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {runs.length === PAGE && (
        <p className="mt-4 text-sm">
          <Link className="font-medium text-fg underline" href={older()}>Older runs →</Link>
        </p>
      )}
    </>
  );
}
