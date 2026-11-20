"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Card } from "@/components/admin/ui";
import { Alert, Button, Input } from "@/components/ui/form";
import type { LlmBudgetsView } from "@/lib/llm-budgets-view";
import type { AgentLlmBudgets, AgentLlmLimit } from "@/lib/seo-agent/client";

type Row = { daily: string; monthly: string };
type Rows = Record<string, Row>;

const NEAR = 0.8;
const usd = (n: number) => `$${n.toFixed(2)}`;
const MODEL = /^[A-Za-z0-9._:\-/@]{1,120}$/;

/** "$1.20 of $50.00" against a limit, or "$1.20 · no limit" without one. */
export function spentOf(spent: number, limit: number | null | undefined): string {
  return limit === null || limit === undefined ? `${usd(spent)} · no limit` : `${usd(spent)} of ${usd(limit)}`;
}

export function nearLimit(spent: number, limit: number | null | undefined): boolean {
  return limit !== null && limit !== undefined && spent >= NEAR * limit;
}

const toRows = (r: Record<string, AgentLlmLimit>): Rows =>
  Object.fromEntries(Object.entries(r).map(([k, v]) => [k, { daily: v.daily_usd === null ? "" : String(v.daily_usd), monthly: v.monthly_usd === null ? "" : String(v.monthly_usd) }]));

/** The inputs as the agent takes them: an empty field is no limit (null), and a row with neither is left out. */
export function budgetsBody(models: Rows, providers: Rows): AgentLlmBudgets {
  const num = (v: string) => (v.trim() === "" ? null : Number(v));
  const out = (rows: Rows) =>
    Object.fromEntries(
      Object.entries(rows)
        .map(([k, v]): [string, AgentLlmLimit] => [k, { daily_usd: num(v.daily), monthly_usd: num(v.monthly) }])
        .filter(([, v]) => v.daily_usd !== null || v.monthly_usd !== null),
    );
  return { models: out(models), providers: out(providers) };
}

/**
 * Admin → Automation & AI → LLM budgets: a daily and a monthly limit per model and per provider (all its models
 * together), every one optional, with this month's spend. The seo-agent owns them: it stores them, validates a save
 * and checks them before every call (moks-seo-agent/app/llm_budgets.py). This card only reads and writes its API.
 */
export function LlmBudgetsCard({ data }: { data: LlmBudgetsView }) {
  const router = useRouter();
  const agent = data.agent;
  const [models, setModels] = useState<Rows>(() => toRows(agent?.budgets.models ?? {}));
  const [providers, setProviders] = useState<Rows>(() => toRows(agent?.budgets.providers ?? {}));
  const [extra, setExtra] = useState<string[]>([]);
  const [adding, setAdding] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; issues?: string[] } | null>(null);

  const spendModels = useMemo(() => agent?.models ?? [], [agent]);
  const spendProviders = useMemo(() => agent?.providers ?? [], [agent]);
  const saved = useMemo(() => agent?.budgets ?? { models: {}, providers: {} }, [agent]);
  const modelIds = useMemo(() => [...new Set([...spendModels.map((m) => m.model), ...data.configuredModels, ...Object.keys(saved.models), ...extra])].sort(), [spendModels, data.configuredModels, saved, extra]);
  const providerIds = useMemo(() => [...new Set(["anthropic", ...spendProviders.map((p) => p.provider), ...Object.keys(saved.providers)])].sort(), [spendProviders, saved]);
  const modelSpend = (id: string) =>
    spendModels.filter((m) => m.model === id).reduce((a, m) => ({ today: a.today + m.today_usd, month: a.month + m.month_usd, purposes: [...new Set([...a.purposes, ...m.purposes])] }), { today: 0, month: 0, purposes: [] as string[] });
  const providerSpend = (id: string) => spendProviders.find((p) => p.provider === id) ?? { today_usd: 0, month_usd: 0, forecast_usd: 0 };
  const row = (rows: Rows, id: string): Row => rows[id] ?? { daily: "", monthly: "" };
  const set = (kind: "models" | "providers", id: string, k: keyof Row, v: string) => (kind === "models" ? setModels : setProviders)((p) => ({ ...p, [id]: { ...row(p, id), [k]: v } }));

  function add() {
    const id = adding.trim();
    if (!MODEL.test(id)) return setMsg({ ok: false, text: "Use the provider's model id, for example claude-sonnet-5-5." });
    setExtra((x) => [...new Set([...x, id])]);
    setAdding("");
    setMsg(null);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/admin/seo/llm-budgets", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(budgetsBody(models, providers)) });
      const body = (await res.json().catch(() => ({}))) as { error?: string; issues?: string[]; reference?: string; budgets?: AgentLlmBudgets };
      if (!res.ok) setMsg({ ok: false, text: (body.error ?? `HTTP ${res.status}`) + (body.reference ? ` (ref ${body.reference})` : ""), issues: body.issues });
      else {
        if (body.budgets) {
          setModels(toRows(body.budgets.models));
          setProviders(toRows(body.budgets.providers));
        }
        setMsg({ ok: true, text: "Saved in the SEO agent. It applies from the next call." });
        router.refresh();
      }
    } catch {
      setMsg({ ok: false, text: "Network error." });
    } finally {
      setBusy(false);
    }
  }

  const limitInput = (kind: "models" | "providers", id: string, k: keyof Row, label: string) => (
    <Input aria-label={`${label} for ${id} (USD)`} inputMode="decimal" className="w-28" placeholder="no limit" value={row(kind === "models" ? models : providers, id)[k]} onChange={(e) => set(kind, id, k, e.target.value)} />
  );
  const spent = (value: number, lim: number | null | undefined) => <span className={nearLimit(value, lim) ? "font-medium text-amber-700 dark:text-amber-300" : ""}>{spentOf(value, lim)}</span>;

  return (
    <Card className="mb-6">
      <h2 className="font-semibold text-fg">LLM budgets</h2>
      <p className="mt-1 text-sm text-fg-muted">
        Set in the SEO agent, which makes the LLM calls and checks these before each one. A daily and a monthly limit for each model, and for each provider (all of its models together, for example the credit on your Anthropic account). Every limit is optional: leave a field empty for no limit.
        They count every Claude call (drafts, agent flows, Ask the Blog and the news desk), and a call must fit all of them. Days and months are UTC{agent?.month_resets_at ? `; this month ends ${agent.month_resets_at.slice(0, 10)}` : ""}. Changes are audit-logged.
      </p>
      {!agent ? (
        <div className="mt-4">
          <Alert>{data.agentError ?? "The SEO agent could not be asked."} The budgets are kept by the SEO agent, so they can be seen and changed only while it is reachable.</Alert>
        </div>
      ) : (
        <form onSubmit={save} className="mt-4 space-y-6">
          <div className="overflow-x-auto">
            <table className="w-full text-sm" aria-label="Provider budgets">
              <thead><tr className="text-left text-xs text-fg-subtle"><th className="py-1 font-medium">Provider (all its models)</th><th className="font-medium">Today</th><th className="font-medium">This month</th><th className="font-medium">Month-end forecast</th><th className="font-medium">Daily limit</th><th className="font-medium">Monthly limit</th></tr></thead>
              <tbody>
                {providerIds.map((id) => {
                  const s = providerSpend(id);
                  const lim = saved.providers[id];
                  return (
                    <tr key={id} className="border-t border-line">
                      <td className="py-1.5"><code>{id}</code></td>
                      <td className="tabular-nums">{spent(s.today_usd, lim?.daily_usd)}</td>
                      <td className="tabular-nums">{spent(s.month_usd, lim?.monthly_usd)}</td>
                      <td className="tabular-nums">{spent(s.forecast_usd, lim?.monthly_usd)}</td>
                      <td className="py-1">{limitInput("providers", id, "daily", "Daily limit")}</td>
                      <td className="py-1">{limitInput("providers", id, "monthly", "Monthly limit")}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm" aria-label="Model budgets">
              <thead><tr className="text-left text-xs text-fg-subtle"><th className="py-1 font-medium">Model</th><th className="font-medium">Used by (this month)</th><th className="font-medium">Today</th><th className="font-medium">This month</th><th className="font-medium">Daily limit</th><th className="font-medium">Monthly limit</th></tr></thead>
              <tbody>
                {modelIds.map((id) => {
                  const s = modelSpend(id);
                  const lim = saved.models[id];
                  return (
                    <tr key={id} className="border-t border-line">
                      <td className="py-1.5"><code>{id}</code></td>
                      <td className="text-xs text-fg-subtle">{s.purposes.length ? s.purposes.join(", ") : "—"}</td>
                      <td className="tabular-nums">{spent(s.today, lim?.daily_usd)}</td>
                      <td className="tabular-nums">{spent(s.month, lim?.monthly_usd)}</td>
                      <td className="py-1">{limitInput("models", id, "daily", "Daily limit")}</td>
                      <td className="py-1">{limitInput("models", id, "monthly", "Monthly limit")}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Input aria-label="Model id to add" className="w-64" placeholder="Another model id, e.g. claude-opus-5-5" value={adding} onChange={(e) => setAdding(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
              <Button type="button" variant="secondary" size="sm" onClick={add}>Add model</Button>
            </div>
          </div>
          {msg && <Alert tone={msg.ok ? "success" : "error"}>{msg.text}{msg.issues?.length ? <ul className="mt-1 list-disc pl-5">{msg.issues.map((i) => <li key={i}>{i}</li>)}</ul> : null}</Alert>}
          <Button type="submit" loading={busy}>Save budgets</Button>
        </form>
      )}
      {data.featureCaps.length > 0 && (
        <div className="mt-6">
          <h3 className="text-sm font-semibold text-fg">Feature caps (also apply)</h3>
          <ul className="mt-1 space-y-1 text-sm text-fg-muted">
            {data.featureCaps.map((c) => (
              <li key={c.feature}><strong className="text-fg">{c.feature}</strong>: {c.limit}, {c.scope}. Set in {c.href ? <Link className="underline" href={c.href}>{c.where}</Link> : c.where}.</li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
