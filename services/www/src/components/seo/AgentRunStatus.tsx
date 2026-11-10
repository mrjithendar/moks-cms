"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Badge, type Tone } from "./badges";

export type RunSummary = { status: string; outcome: string | null; currentNode: string | null; error: string | null; costUsd: number };

// Flow steps (seo-agent app/flows): optimize_article_flow, new_article_flow, publish_flow.
const NODE: Record<string, string> = {
  fetch_context: "reading the article and its Search Console / GA4 data",
  analyze: "choosing what to change",
  draft: "the crew is drafting (analyst → editor → technical reviewer)",
  validate_draft: "checking the changes",
  save_draft: "saving the draft for your review",
  load_brief: "reading the brief",
  apply_changes: "applying the changes you accepted",
  cms_publish: "publishing",
  verify_live: "verifying the live page",
  offer_rollback: "verification failed: offering rollback",
  submit_search: "notifying search engines",
  reindex: "updating the site search index",
  schedule_measure: "scheduling the +28/+56-day measurement",
};

const active = (s: string) => s === "running" || s === "queued";

function describe(r: RunSummary): { tone: Tone; label: string; detail: string } {
  if (active(r.status)) return { tone: "blue", label: "Agent working", detail: r.currentNode ? NODE[r.currentNode] ?? r.currentNode : "starting" };
  if (r.outcome === "draft_ready") return { tone: "amber", label: "Waiting for your review", detail: "The drafting run has finished. Nothing is published until you approve here." };
  if (r.status === "paused_budget") return { tone: "red", label: "Paused: budget", detail: "The monthly LLM budget would be exceeded; nothing was sent." };
  if (r.status === "failed") return { tone: "red", label: "Run failed", detail: r.error ?? "See the logs." };
  if (r.status === "cancelled") return { tone: "gray", label: "Run cancelled", detail: "" };
  return { tone: r.outcome === "published" ? "green" : r.outcome === "verify_failed" ? "red" : "gray", label: `Run ${(r.outcome ?? "completed").replace(/_/g, " ")}`, detail: r.outcome === "verify_failed" ? "The live page failed verification; nothing was submitted. Roll back below." : "" };
}

/**
 * The latest CrewAI flow run for this draft (drafting, or publish_flow after your approval): polls while it is active
 * and refreshes the page when it finishes, so the diff below always shows what the flow wrote.
 */
export function AgentRunStatus({ threadId, initial }: { threadId: string; initial: RunSummary }) {
  const router = useRouter();
  const [run, setRun] = useState(initial);
  useEffect(() => {
    if (!active(run.status)) return;
    const t = setTimeout(async () => {
      const res = await fetch(`/api/admin/seo/agent/runs/${encodeURIComponent(threadId)}`, { cache: "no-store" }).catch(() => null);
      if (!res?.ok) return setRun((r) => ({ ...r }));
      const j = (await res.json()) as { status: string; outcome: string | null; current_step: string | null; error: string | null; cost_usd: number };
      const next = { status: j.status, outcome: j.outcome, currentNode: j.current_step, error: j.error, costUsd: j.cost_usd };
      setRun(next);
      if (!active(next.status)) router.refresh();
    }, 4000);
    return () => clearTimeout(t);
  }, [run, threadId, router]);
  const d = describe(run);
  return (
    <div role="status" className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-line bg-surface px-4 py-3 text-sm">
      <Badge t={d.tone}>{d.label}</Badge>
      {d.detail && <span className="text-fg-muted">{d.detail}</span>}
      <span className="ml-auto text-xs tabular-nums text-fg-subtle" title="LLM cost of this run so far (counts against the monthly budget)">
        CrewAI flow · ${run.costUsd.toFixed(3)}
      </span>
    </div>
  );
}
