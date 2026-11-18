import { getDb } from "@/db";
import { Card } from "@/components/admin/ui";
import { budgetState, flowCostBreakdown } from "@/lib/seo-intel/claude";
import { claudeConfig, getSeoSettings } from "@/lib/seo-intel/settings";

const usd = (n: number) => `$${n.toFixed(n < 10 ? 2 : 0)}`;

export type ClaudeUsageData = { cfg: Omit<ReturnType<typeof claudeConfig>, "apiKey"> & { keySet: boolean }; b: Awaited<ReturnType<typeof budgetState>>; flows?: Awaited<ReturnType<typeof flowCostBreakdown>> };

export async function loadClaudeUsage(): Promise<ClaudeUsageData> {
  const { apiKey, ...cfg } = claudeConfig(await getSeoSettings());
  const db = await getDb();
  const b = await budgetState(db, cfg);
  return { cfg: { ...cfg, keySet: Boolean(apiKey) }, b, flows: await flowCostBreakdown(db, b.spentUsd) };
}

/** Settings → Claude usage: month-to-date spend against the hard cap, per model, with cache reads. */
export function ClaudeUsageCard({ data }: { data: ClaudeUsageData }) {
  const { cfg, b, flows } = data;
  const pct = b.budgetUsd ? Math.min(100, ((b.spentUsd + b.reservedUsd) / b.budgetUsd) * 100) : 100;
  return (
    <Card className="mb-6">
      <h2 className="font-semibold text-fg">Claude usage this month</h2>
      <p className="mt-1 text-sm text-fg-muted">
        Key: {cfg.keySet ? "configured (ANTHROPIC_API_KEY)" : <strong className="text-amber-800 dark:text-amber-300">not configured — drafting needs ANTHROPIC_API_KEY</strong>}. Draft model <code>{cfg.draftModel}</code>, classification model <code>{cfg.classifyModel}</code>.
      </p>
      <div className="mt-3" role="meter" aria-valuemin={0} aria-valuemax={b.budgetUsd} aria-valuenow={Number((b.spentUsd + b.reservedUsd).toFixed(2))} aria-label="Month-to-date spend against the monthly budget">
        <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
          <span className="text-2xl font-semibold tabular-nums text-fg">{usd(b.spentUsd)}</span>
          <span className="text-fg-subtle">of {usd(b.budgetUsd)} ({cfg.budgetSource === "env" ? "SEO_LLM_MONTHLY_BUDGET_USD" : cfg.budgetSource === "settings" ? "settings" : "default"}) · since {b.monthStart}</span>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-sunken">
          <div className={`h-full ${b.paused ? "bg-red-600" : pct > 80 ? "bg-amber-500" : "bg-accent"}`} style={{ width: `${pct}%` }} />
        </div>
        {b.reservedUsd > 0 && <p className="mt-1 text-xs text-fg-subtle">{usd(b.reservedUsd)} reserved for batches in progress.</p>}
        {b.paused && <p className="mt-2 text-sm font-medium text-red-700 dark:text-red-300">Budget reached: drafting is paused until next month or until the budget is raised.</p>}
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

/** Banner on every search/analytics admin page while the monthly cap is reached. */
export async function BudgetBanner() {
  let b: Awaited<ReturnType<typeof budgetState>> | null = null;
  try {
    const cfg = claudeConfig(await getSeoSettings());
    if (cfg.apiKey) b = await budgetState(await getDb(), cfg);
  } catch {
    b = null; // never break the page over the banner
  }
  if (!b?.paused) return null;
  return (
    <div role="status" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200">
      <p className="font-medium">Claude drafting paused: monthly budget reached</p>
      <p className="mt-0.5">${b.spentUsd.toFixed(2)} of ${b.budgetUsd.toFixed(2)} spent this month. Existing drafts can still be reviewed and approved. Raise SEO_LLM_MONTHLY_BUDGET_USD or wait until next month.</p>
    </div>
  );
}
