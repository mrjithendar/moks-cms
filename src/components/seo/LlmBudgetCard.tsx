"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useUnsavedChanges } from "@/components/admin/SettingsSections";
import { Card } from "@/components/admin/ui";
import { Alert, Button, Field, Input } from "@/components/ui/form";
import type { LlmBudgetLoad } from "@/lib/llm-budget-view";
import type { AgentLlmBudget, AgentLlmBudgetView, AgentLlmScope } from "@/lib/seo-agent/client";

const NEAR = 0.8;
const usd = (n: number) => `$${n.toFixed(2)}`;
const WORD: Record<AgentLlmScope, { name: string; adjective: string; period: string }> = {
  day: { name: "Daily", adjective: "daily", period: "today" },
  month: { name: "Monthly", adjective: "monthly", period: "this month" },
};

/** "$1.20 of $50.00" against a limit, or "$1.20 · no limit" without one. */
export function spentOf(spent: number, limit: number | null | undefined): string {
  return limit === null || limit === undefined ? `${usd(spent)} · no limit` : `${usd(spent)} of ${usd(limit)}`;
}

/** How full the bar is, 0 to 100; no limit draws no bar (null). Calls in flight count as spent. */
export function percentUsed(spent: number, pending: number, limit: number | null | undefined): number | null {
  if (limit === null || limit === undefined) return null;
  if (limit <= 0) return 100;
  return Math.min(100, Math.max(0, ((spent + pending) / limit) * 100));
}

export function barTone(percent: number | null): "none" | "ok" | "near" | "reached" {
  if (percent === null) return "none";
  return percent >= 100 ? "reached" : percent >= NEAR * 100 ? "near" : "ok";
}

/**
 * The body of a save: the edited period's field (empty is no limit) and the other period's limit as it is, because
 * the agent takes both. `issue` instead when the field is not an amount.
 */
export function budgetBody(scope: AgentLlmScope, field: string, current: AgentLlmBudget): { body: AgentLlmBudget } | { issue: string } {
  const text = field.trim().replace(/^\$/, "");
  const value = text === "" ? null : Number(text);
  if (value !== null && (!Number.isFinite(value) || value < 0)) return { issue: "Enter an amount in US dollars, such as 25 or 12.50, or leave it empty for no limit." };
  return { body: scope === "day" ? { daily_usd: value, monthly_usd: current.monthly_usd } : { daily_usd: current.daily_usd, monthly_usd: value } };
}

const when = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

function Breakdown({ title, rows, total }: { title: string; rows: { key: string; label: string; usd: number; calls: number }[]; total: number }) {
  return (
    <div className="min-w-0">
      <h3 className="text-sm font-semibold text-fg">{title}</h3>
      {rows.length === 0 ? (
        <p className="mt-1 text-sm text-fg-subtle">Nothing spent in this period.</p>
      ) : (
        <div className="mt-1 overflow-x-auto">
          <table className="w-full text-sm">
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="border-t border-line">
                  <td className="min-w-32 py-1.5 pr-3 [overflow-wrap:anywhere]">{r.label}</td>
                  <td className="whitespace-nowrap py-1.5 pr-3 text-right tabular-nums">{usd(r.usd)}</td>
                  <td className="whitespace-nowrap py-1.5 pr-3 text-right tabular-nums text-fg-subtle">{total > 0 ? `${Math.round((r.usd / total) * 100)}%` : "0%"}</td>
                  <td className="whitespace-nowrap py-1.5 text-right tabular-nums text-fg-subtle">
                    {r.calls} {r.calls === 1 ? "call" : "calls"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * Admin → AI & SEO → Settings → LLM providers & budget (top card): ONE budget for every provider, model and purpose together, with an
 * optional daily limit and an optional monthly limit. A Daily | Monthly switch chooses the period shown: its spend
 * against its limit, the one field that sets that limit, and where the period's spend went (for reading; the
 * breakdowns limit nothing). The seo-agent owns the budget (seo-agent/app/llm_budgets.py): this card only reads
 * and writes its API.
 */
export function LlmBudgetCard({ load, basePath }: { load: LlmBudgetLoad; basePath: string }) {
  const router = useRouter();
  const [view, setView] = useState<AgentLlmBudgetView | null>(load.view);
  const scope = load.scope;
  const saved = view?.budget ?? { daily_usd: null, monthly_usd: null };
  const savedLimit = scope === "day" ? saved.daily_usd : saved.monthly_usd;
  const [field, setField] = useState(savedLimit === null ? "" : String(savedLimit));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; issues?: string[] } | null>(null);
  useUnsavedChanges(field.trim() !== (savedLimit === null ? "" : String(savedLimit)));
  const w = WORD[scope];
  const tab = (s: AgentLlmScope) => `${basePath}&scope=${s}`;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const next = budgetBody(scope, field, saved);
    if ("issue" in next) {
      setMsg({ ok: false, text: next.issue });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/admin/seo/llm-budget", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next.body) });
      const body = (await res.json().catch(() => ({}))) as { error?: string; issues?: string[]; reference?: string; budget?: AgentLlmBudget };
      if (!res.ok) setMsg({ ok: false, text: (body.error ?? `HTTP ${res.status}`) + (body.reference ? ` (ref ${body.reference})` : ""), issues: body.issues });
      else {
        const budget = body.budget ?? next.body;
        const limit = scope === "day" ? budget.daily_usd : budget.monthly_usd;
        if (view) setView({ ...view, budget, limit_usd: limit, remaining_usd: limit === null ? null : Math.max(0, limit - view.spent_usd - view.pending_usd) });
        setField(limit === null ? "" : String(limit));
        setMsg({ ok: true, text: limit === null ? `Saved in the SEO agent: no ${w.adjective} limit.` : `Saved in the SEO agent: ${usd(limit)} ${w.adjective}. It applies from the next call.` });
        router.refresh();
      }
    } catch {
      setMsg({ ok: false, text: "Network error." });
    } finally {
      setBusy(false);
    }
  }

  const percent = view ? percentUsed(view.spent_usd, view.pending_usd, view.limit_usd) : null;
  const tone = barTone(percent);
  const legacy = view ? [...Object.entries(view.legacy_limits.providers).map(([k, v]) => ({ kind: "Provider", name: k, ...v })), ...Object.entries(view.legacy_limits.models).map(([k, v]) => ({ kind: "Model", name: k, ...v }))] : [];

  return (
    <Card className="mb-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="llm-budget" className="scroll-mt-24 text-lg font-semibold text-fg">LLM budget</h2>
          <p className="mt-1 text-sm text-fg-muted">One budget for every provider, model and purpose together: drafts, content flows and other flows, AI visibility, Ask the Blog and this site&apos;s own calls. Kept and enforced by the SEO agent.</p>
        </div>
        <nav aria-label="Budget period" className="flex shrink-0 rounded-lg border border-line p-0.5 text-sm">
          {(["day", "month"] as const).map((s) => (
            <Link key={s} href={tab(s)} scroll={false} aria-current={s === scope ? "page" : undefined} className={`rounded-md px-3 py-1.5 font-medium ${s === scope ? "bg-accent-soft text-accent-text" : "text-fg-muted hover:text-fg"}`}>
              {WORD[s].name}
            </Link>
          ))}
        </nav>
      </div>

      {!view ? (
        <div className="mt-4">
          <Alert tone={load.tooOld ? "info" : "error"}>{load.error ?? "The SEO agent could not be asked."} The budget is kept by the SEO agent, so it can be seen and changed only while it is reachable.</Alert>
        </div>
      ) : (
        <>
          <div className="mt-5" role={view.limit_usd === null ? undefined : "meter"} aria-valuemin={0} aria-valuemax={view.limit_usd ?? undefined} aria-valuenow={view.limit_usd === null ? undefined : Number((view.spent_usd + view.pending_usd).toFixed(2))} aria-label={`Spend ${w.period} against the ${w.adjective} limit`}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-2xl font-semibold tabular-nums text-fg">
                {usd(view.spent_usd)} <span className="text-base font-normal text-fg-subtle">spent {w.period}</span>
              </p>
              <p className="text-sm text-fg-muted">{view.limit_usd === null ? `No ${w.adjective} limit` : `${usd(view.remaining_usd ?? 0)} left of ${usd(view.limit_usd)}`}</p>
            </div>
            {percent !== null && (
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-sunken">
                <div className={`h-full ${tone === "reached" ? "bg-red-600" : tone === "near" ? "bg-amber-500" : "bg-accent"}`} style={{ width: `${percent}%` }} />
              </div>
            )}
            <p className="mt-2 text-sm text-fg-subtle">
              {view.pending_usd > 0 && <>{usd(view.pending_usd)} more is held for calls in progress. </>}
              {scope === "month" && view.forecast_usd !== null && <>At this month&apos;s rate so far: about {usd(view.forecast_usd)} by the end of the month. </>}
              Resets {when(view.resets_at)}.
            </p>
            {tone === "reached" && <p className="mt-2 text-sm font-medium text-red-700 dark:text-red-300">The {w.adjective} limit is reached: new LLM calls are refused until it resets or the limit is raised.</p>}
            {view.limit_usd === null && saved.daily_usd === null && saved.monthly_usd === null && (
              <div className="mt-3">
                <Alert tone="info">No limit is set, so nothing here stops LLM spending. Set a daily or a monthly limit below.</Alert>
              </div>
            )}
          </div>

          <form onSubmit={save} className="mt-5 max-w-md space-y-3">
            <Field label={`${w.name} limit (USD)`} htmlFor="llm-budget-limit" hint={`The most all LLM calls together may cost ${scope === "day" ? "in one day" : "in one month"} (UTC). Empty means no ${w.adjective} limit; 0 stops every call.`}>
              <Input id="llm-budget-limit" type="number" inputMode="decimal" min={0} step="0.01" value={field} onChange={(e) => setField(e.target.value)} placeholder="No limit" aria-describedby="llm-budget-limit-hint" />
            </Field>
            {msg && (
              <Alert tone={msg.ok ? "success" : "error"}>
                {msg.text}
                {msg.issues && msg.issues.length > 0 && (
                  <ul className="mt-1 list-disc pl-5">
                    {msg.issues.map((i) => <li key={i}>{i}</li>)}
                  </ul>
                )}
              </Alert>
            )}
            <Button type="submit" disabled={busy}>{busy ? "Saving…" : `Save ${w.adjective} limit`}</Button>
          </form>

          <p className="mt-5 border-t border-line pt-4 text-sm text-fg-muted">
            {WORD[view.other.scope].name}: {spentOf(view.other.spent_usd, view.other.limit_usd)} {WORD[view.other.scope].period}.{" "}
            <Link className="underline" href={tab(view.other.scope)} scroll={false}>
              Show {WORD[view.other.scope].adjective}
            </Link>
          </p>

          <div className="mt-5 grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-3">
            <Breakdown title="By provider" total={view.spent_usd} rows={view.by_provider.map((r) => ({ key: r.provider, label: r.provider, usd: r.usd, calls: r.calls }))} />
            <Breakdown title="By model" total={view.spent_usd} rows={view.by_model.map((r) => ({ key: `${r.provider}/${r.model}`, label: r.model, usd: r.usd, calls: r.calls }))} />
            <Breakdown title="By purpose" total={view.spent_usd} rows={view.by_purpose.map((r) => ({ key: r.purpose, label: r.purpose.replaceAll("_", " "), usd: r.usd, calls: r.calls }))} />
          </div>
          <p className="mt-2 text-xs text-fg-subtle">Where {w.period}&apos;s spend went. These are for reading: only the budget above limits spending.</p>

          <div className="mt-5 border-t border-line pt-4 text-sm text-fg-muted">
            <h3 className="font-semibold text-fg">Limits that still apply on their own</h3>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              <li>
                Ask the Blog public usage limit: {spentOf(view.ask_daily.spent_usd, view.ask_daily.limit_usd)} today. It keeps readers from using up the budget.{" "}
                <Link className="underline" href="/admin/automation?section=ask-the-blog">Ask the Blog</Link>
              </li>
              <li>
                The content flows&apos; own limits, cover image spend included. <Link className="underline" href="/admin/automation?section=agent-limits#job-settings-limits">Content flow limits</Link>
              </li>
            </ul>
          </div>

          {legacy.length > 0 && (
            <div className="mt-5 border-t border-line pt-4 text-sm">
              <h3 className="font-semibold text-fg">Earlier limits, no longer enforced</h3>
              <p className="mt-1 text-fg-muted">Before the one budget there was a limit per model and per provider. These were saved then and limit nothing now. They are shown so you can decide the budget above.</p>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-fg-subtle"><th className="py-1 pr-3 font-medium">Kind</th><th className="pr-3 font-medium">Name</th><th className="pr-3 text-right font-medium">Daily</th><th className="text-right font-medium">Monthly</th></tr>
                  </thead>
                  <tbody>
                    {legacy.map((l) => (
                      <tr key={`${l.kind}-${l.name}`} className="border-t border-line">
                        <td className="py-1.5 pr-3">{l.kind}</td>
                        <td className="min-w-32 pr-3 [overflow-wrap:anywhere]">{l.name}</td>
                        <td className="whitespace-nowrap pr-3 text-right tabular-nums">{l.daily_usd === null ? "none" : usd(l.daily_usd)}</td>
                        <td className="whitespace-nowrap text-right tabular-nums">{l.monthly_usd === null ? "none" : usd(l.monthly_usd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
