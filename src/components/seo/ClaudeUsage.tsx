import Link from "next/link";
import { getDb } from "@/db";
import { Card } from "@/components/admin/ui";
import { budgetState, flowCostBreakdown } from "@/lib/seo-intel/claude";
import { claudeConfig, getSeoSettings } from "@/lib/seo-intel/settings";
import { loadLlmBudget } from "@/lib/llm-budget-view";
import type { AgentLlmBudgetView } from "@/lib/seo-agent/client";

const usd = (n: number) => `$${n.toFixed(n < 10 ? 2 : 0)}`;

export type ClaudeUsageData = { cfg: Omit<ReturnType<typeof claudeConfig>, "apiKey"> & { keySet: boolean }; b: Awaited<ReturnType<typeof budgetState>>; flows?: Awaited<ReturnType<typeof flowCostBreakdown>> };

export async function loadClaudeUsage(): Promise<ClaudeUsageData> {
  const { apiKey, ...cfg } = claudeConfig(await getSeoSettings());
  const db = await getDb();
  const b = await budgetState(db);
  return { cfg: { ...cfg, keySet: Boolean(apiKey) }, b, flows: await flowCostBreakdown(db, b.spentUsd) };
}

/** AI & SEO settings → LLM providers & budget → LLM usage (called "Claude usage" before): this site's own month-to-date spend per model, with cache reads. A usage figure: the limit is the one LLM budget. */
export function ClaudeUsageCard({ data }: { data: ClaudeUsageData }) {
  const { cfg, b, flows } = data;
  return (
    <Card className="mb-6">
      <h2 className="font-semibold text-fg">LLM usage this month</h2>
      <p className="mt-1 text-sm text-fg-muted">
        Key: {cfg.keySet ? "configured (ANTHROPIC_API_KEY)" : <strong className="text-amber-800 dark:text-amber-300">not configured — drafting needs ANTHROPIC_API_KEY</strong>}. Draft model <code>{cfg.draftModel}</code>, classification model <code>{cfg.classifyModel}</code>.
      </p>
      <div className="mt-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
          <span className="text-2xl font-semibold tabular-nums text-fg">{usd(b.spentUsd)}</span>
          <span className="text-fg-subtle">since {b.monthStart} · the limit is the LLM budget above</span>
        </div>
        {b.reservedUsd > 0 && <p className="mt-1 text-xs text-fg-subtle">{usd(b.reservedUsd)} reserved for batches in progress.</p>}
      </div>
      {b.byModel.length > 0 && (
        <div className="overflow-x-auto"><table className="mt-4 w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-fg-subtle"><th className="py-1 font-medium">Model</th><th className="font-medium">Calls</th><th className="font-medium">Cache hit</th><th className="text-right font-medium">Cost</th></tr>
          </thead>
          <tbody>
            {b.byModel.map((m) => (
              <tr key={m.model} className="border-t border-line">
                <td className="py-1.5"><code>{m.model}</code></td>
                <td className="tabular-nums">{m.calls}</td>
                <td className="tabular-nums">{m.inputTokens + m.cacheReadTokens ? `${Math.round((m.cacheReadTokens / (m.inputTokens + m.cacheReadTokens)) * 100)}%` : "—"}</td>
                <td className="text-right tabular-nums">{usd(m.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
      {flows && (flows.flows.length > 0 || flows.outsideFlowsUsd > 0) && (
        <div className="mt-5">
          <h3 className="text-sm font-semibold text-fg">By flow</h3>
          <p className="mt-0.5 text-xs text-fg-subtle">Measured cost of each agent flow&apos;s runs this month (seo_flow_runs). News and Ask the Blog have their own caps and are not included.</p>
          <div className="overflow-x-auto"><table className="mt-2 w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-fg-subtle"><th className="py-1 font-medium">Flow</th><th className="font-medium">Runs</th><th className="font-medium">Share</th><th className="text-right font-medium">Cost</th></tr>
            </thead>
            <tbody>
              {flows.flows.map((f) => (
                <tr key={f.flow} className="border-t border-line">
                  <td className="py-1.5"><code>{f.flow}</code></td>
                  <td className="tabular-nums">{f.runs}</td>
                  <td className="tabular-nums">
                    <span className="inline-flex items-center gap-2">
                      <span className="inline-block h-1.5 w-16 overflow-hidden rounded-full bg-surface-sunken" aria-hidden="true"><span className="block h-full bg-accent" style={{ width: `${Math.round(f.share * 100)}%` }} /></span>
                      {Math.round(f.share * 100)}%
                    </span>
                  </td>
                  <td className="text-right tabular-nums">{usd(f.costUsd)}</td>
                </tr>
              ))}
              {flows.outsideFlowsUsd > 0 && (
                <tr className="border-t border-line text-fg-muted">
                  <td className="py-1.5">Outside flows (v2 path, keyword intents, explanations)</td>
                  <td>—</td>
                  <td className="tabular-nums">{flows.totalUsd ? Math.round((flows.outsideFlowsUsd / flows.totalUsd) * 100) : 0}%</td>
                  <td className="text-right tabular-nums">{usd(flows.outsideFlowsUsd)}</td>
                </tr>
              )}
            </tbody>
          </table></div>
        </div>
      )}
    </Card>
  );
}

/** What the banner says when a limit of the one LLM budget is used up, or null. Pure, so it can be tested. */
export function budgetStop(view: Pick<AgentLlmBudgetView, "scope" | "limit_usd" | "spent_usd" | "other"> | null): { period: "day" | "month"; spentUsd: number; limitUsd: number } | null {
  if (!view) return null;
  for (const p of [{ period: view.scope, spent: view.spent_usd, limit: view.limit_usd }, { period: view.other?.scope, spent: view.other?.spent_usd, limit: view.other?.limit_usd }]) {
    if ((p.period === "day" || p.period === "month") && typeof p.limit === "number" && typeof p.spent === "number" && p.spent >= p.limit) return { period: p.period, spentUsd: p.spent, limitUsd: p.limit };
  }
  return null;
}

/** Banner on every search/analytics admin page while the one LLM budget is used up. Never slows or breaks the page. */
export async function BudgetBanner() {
  let stop: ReturnType<typeof budgetStop> = null;
  try {
    const view = await Promise.race([loadLlmBudget("month").then((l) => l.view), new Promise<null>((r) => setTimeout(() => r(null), 1500))]);
    stop = budgetStop(view);
  } catch {
    stop = null;
  }
  if (!stop) return null;
  return (
    <div role="status" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200">
      <p className="font-medium">LLM calls paused: the {stop.period === "day" ? "daily" : "monthly"} LLM budget is used up</p>
      <p className="mt-0.5">
        ${stop.spentUsd.toFixed(2)} of ${stop.limitUsd.toFixed(2)} spent this {stop.period === "day" ? "day (UTC)" : "month"}. Existing drafts can still be reviewed and approved. Change the limit under{" "}
        <Link className="underline" href="/admin/automation?section=llm#llm-budget">AI &amp; SEO → Settings → LLM providers &amp; budget</Link>, or wait for it to reset.
      </p>
    </div>
  );
}
