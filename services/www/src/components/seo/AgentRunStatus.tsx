"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Badge, type Tone } from "./badges";

export type RunSummary = { status: string; outcome: string | null; currentNode: string | null; error: string | null; costUsd: number };

const NODE: Record<string, string> = {
  fetch_context: "reading the article and its Search Console / GA4 data",
  analyze: "choosing what to change",
  draft_changes: "drafting changes with Claude",
  validate: "checking the changes",
  regenerate: "drafting again with your feedback",
  publish: "publishing",
  verify_live: "verifying the live page",
  submit_search: "notifying search engines",
  schedule_measure: "scheduling the +28/+56-day measurement",
  load_brief: "reading the brief",
  draft_new_article: "the editorial crew is writing",
};

function describe(r: RunSummary): { tone: Tone; label: string; detail: string } {
  if (r.status === "running") return { tone: "blue", label: "Agent working", detail: r.currentNode ? NODE[r.currentNode] ?? r.currentNode : "starting" };
  if (r.status === "interrupted") return { tone: "amber", label: "Waiting for your review", detail: "The run is paused at review. It continues only when you approve, reject or ask for changes." };
  if (r.status === "paused_budget") return { tone: "red", label: "Paused: budget", detail: "The monthly LLM budget would be exceeded; nothing was sent." };
  if (r.status === "failed") return { tone: "red", label: "Run failed", detail: r.error ?? "See the logs." };
  if (r.status === "cancelled") return { tone: "gray", label: "Run cancelled", detail: "" };
  return { tone: r.outcome === "published" ? "green" : r.outcome === "verify_failed" ? "red" : "gray", label: `Run ${(r.outcome ?? "completed").replace(/_/g, " ")}`, detail: r.outcome === "verify_failed" ? "The live page failed verification; nothing was submitted. Roll back below." : "" };
}

/**
 * Graph state for a draft owned by a LangGraph run (thread id = draft id): polls while the run is active, refreshes
 * the page when it reaches review or finishes, so the diff below always shows what the graph wrote.
 */
export function AgentRunStatus({ threadId, initial }: { threadId: string; initial: RunSummary }) {
  const router = useRouter();
  const [run, setRun] = useState(initial);
  useEffect(() => {
    if (run.status !== "running") return;
    const t = setTimeout(async () => {
      const res = await fetch(`/api/admin/seo/agent/runs/${encodeURIComponent(threadId)}`, { cache: "no-store" }).catch(() => null);
      if (!res?.ok) return setRun((r) => ({ ...r }));
      const j = (await res.json()) as { status: string; outcome: string | null; current_node: string | null; error: string | null; cost_usd: number };
      const next = { status: j.status, outcome: j.outcome, currentNode: j.current_node, error: j.error, costUsd: j.cost_usd };
      setRun(next);
      if (next.status !== "running") router.refresh();
    }, 4000);
    return () => clearTimeout(t);
  }, [run, threadId, router]);
  const d = describe(run);
  return (
    <div role="status" className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-line bg-surface px-4 py-3 text-sm">
      <Badge t={d.tone}>{d.label}</Badge>
      {d.detail && <span className="text-fg-muted">{d.detail}</span>}
      <span className="ml-auto text-xs tabular-nums text-fg-subtle" title="LLM cost of this run so far (counts against the monthly budget)">
        LangGraph run · ${run.costUsd.toFixed(3)}
      </span>
    </div>
  );
}
