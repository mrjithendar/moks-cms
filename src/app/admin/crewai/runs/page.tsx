import Link from "next/link";
import { Suspense } from "react";
import { AdminHeader, Card } from "@/components/admin/ui";
import { Ago } from "@/components/crewai/Ago";
import { AutoRefresh } from "@/components/crewai/AutoRefresh";
import { RunFilters } from "@/components/crewai/RunFilters";
import { RunStatusIcon } from "@/components/crewai/RunStatusIcon";
import { AGENT_IDS, AGENT_LABEL } from "@/lib/crewai/agent-of";
import { FLOW_GROUPS, FLOWS, flowInfo, RUN_STATUSES, STATUS_LABELS, TRIGGER_LABELS, TRIGGERS } from "@/lib/crewai/flows";
import { formatDuration, formatTokens, formatUsd, runDurationMs } from "@/lib/crewai/format";
import { flowsWithRuns, listRuns } from "@/lib/crewai/runs";

export const metadata = { title: "Runs" };
const PAGE = 50;

/** All runs of both agents, newest first (GitHub Actions' "All workflows"): filter by flow, agent, status, trigger or
 * text; 50 a page. Each row says which agent ran it. */
export default async function CrewaiRunsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const filter = { flow: sp.flow ?? null, agent: sp.agent === "seo" || sp.agent === "news" ? sp.agent : null, status: sp.status ?? null, trigger: sp.trigger ?? null, q: sp.q ?? null };
  const [runs, seen] = await Promise.all([listRuns({ ...filter, before: sp.before ?? null, limit: PAGE }), flowsWithRuns()]);
  const names = [...new Set([...FLOWS.map((f) => f.name), ...seen])];
  const flows = FLOW_GROUPS.map((group) => ({ group, options: names.filter((n) => flowInfo(n).group === group).map((n) => ({ value: n, label: flowInfo(n).label })) })).filter((g) => g.options.length);
  const statuses = [{ value: "active", label: "Queued or in progress" }, ...RUN_STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s] ?? s }))];
  const triggers = TRIGGERS.map((t) => ({ value: t, label: TRIGGER_LABELS[t] ?? t }));
  const agents = AGENT_IDS.map((a) => ({ value: a, label: AGENT_LABEL[a] }));
  const older = () => {
    const p = new URLSearchParams(Object.entries(filter).filter((e): e is [string, string] => Boolean(e[1])));
    p.set("before", runs[runs.length - 1]!.startedAt);
    return `/admin/crewai/runs?${p}`;
  };
  const live = runs.some((r) => r.status === "queued" || r.status === "running");
  const title = filter.flow ? `${flowInfo(filter.flow).label} runs` : "All runs";
  return (
    <>
      <AutoRefresh active={live} />
      <AdminHeader
        title={title}
        description={filter.flow ? (flowInfo(filter.flow).description || <code>{filter.flow}</code>) : "Every run of every flow of both agents (the SEO agent and the news agent), newest first. Open one for its steps, log, inputs, outputs and cost."}
      />
      <Suspense>
        <RunFilters flows={flows} statuses={statuses} triggers={triggers} agents={agents} />
      </Suspense>
      {runs.length === 0 ? (
        <Card>
          <p className="text-sm text-fg-muted">{Object.values(filter).some(Boolean) || sp.before ? "No runs match these filters." : "No runs yet. Runs appear as soon as an agent starts a flow."}</p>
        </Card>
      ) : (
        <div className="overflow-hidden rounded-xl border border-line bg-surface">
          <p className="border-b border-line bg-surface-muted px-4 py-2 text-xs font-semibold text-fg-subtle">{runs.length === PAGE ? `${PAGE}+ runs` : `${runs.length} run${runs.length === 1 ? "" : "s"}`}{sp.before ? " (older page)" : ""}</p>
          <ul className="divide-y divide-line">
            {runs.map((r) => {
              const info = flowInfo(r.flow);
              const ms = runDurationMs(r.startedAt, r.finishedAt);
              const active = r.status === "queued" || r.status === "running";
              return (
                <li key={r.runId} className="relative flex flex-col gap-2 px-4 py-3 hover:bg-surface-muted sm:flex-row sm:items-center sm:gap-4">
                  <div className="flex min-w-0 flex-1 items-start gap-3">
                    <RunStatusIcon status={r.status} size={18} className="mt-0.5" />
                    <div className="min-w-0">
                      <Link href={`/admin/crewai/runs/${r.runId}`} className="font-semibold text-fg after:absolute after:inset-0 hover:underline">
                        {info.label} <span className="font-normal text-fg-subtle">#{r.number ?? "?"}</span>
                      </Link>
                      <p className="mt-0.5 truncate text-xs text-fg-subtle">
                        {TRIGGER_LABELS[r.triggeredBy] ?? r.triggeredBy}
                        {r.actor ? ` by ${r.actor}` : ""}
                        {r.targetId && r.targetId !== "site" ? <> · <span className="font-mono">{r.targetId.length > 20 ? `${r.targetId.slice(0, 8)}…` : r.targetId}</span></> : null}
                        {active && r.currentStep ? <> · step <span className="font-mono">{r.currentStep}</span></> : null}
                        {r.outcome && !active ? ` · ${r.outcome.replace(/_/g, " ")}` : ""}
                      </p>
                      {r.status === "failed" && r.error && <p className="mt-1 line-clamp-1 text-xs text-red-700 dark:text-red-300 [overflow-wrap:anywhere]">{r.error}</p>}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-4 pl-8 text-xs text-fg-subtle sm:pl-0">
                    <span className="hidden rounded-full border border-line px-2 py-0.5 md:inline">{info.group}</span>
                    <span className="rounded-full border border-line px-2 py-0.5" title="The agent that ran it">{AGENT_LABEL[r.agent]}</span>
                    <span className="w-24 tabular-nums" title="Tokens · model cost">{r.tokens || r.costUsd ? `${formatTokens(r.tokens)} · ${formatUsd(r.costUsd)}` : "no model calls"}</span>
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
