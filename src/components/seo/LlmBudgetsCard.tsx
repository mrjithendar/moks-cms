"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Card } from "@/components/admin/ui";
import { Alert, Button, Input } from "@/components/ui/form";
import type { LlmBudgets, LlmLimit } from "@/lib/llm-budgets";
import type { LlmBudgetsView } from "@/lib/llm-budgets-view";

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

const toRows = (r: Record<string, LlmLimit>): Rows => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, { daily: v.dailyUsd === null ? "" : String(v.dailyUsd), monthly: v.monthlyUsd === null ? "" : String(v.monthlyUsd) }]));

/** The inputs as the API takes them: an empty field is no limit (null), and a row with neither is left out. */
export function budgetsBody(models: Rows, providers: Rows): LlmBudgets {
  const num = (v: string) => (v.trim() === "" ? null : Number(v));
  const out = (rows: Rows) => Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, { dailyUsd: num(v.daily), monthlyUsd: num(v.monthly) }]).filter(([, v]) => (v as LlmLimit).dailyUsd !== null || (v as LlmLimit).monthlyUsd !== null));
  return { models: out(models), providers: out(providers) };
}

/**
 * Admin → Automation & AI → LLM budgets: a daily and a monthly limit per model and per provider (all its models
 * together), every one optional, with this month's spend. Saved as one document (lib/llm-budgets.ts); the web app
 * checks it before each Claude call and the seo-agent within about 30 seconds.
 */
export function LlmBudgetsCard({ data }: { data: LlmBudgetsView }) {
  const router = useRouter();
  const { spend } = data;
  const [models, setModels] = useState<Rows>(() => toRows(data.budgets.models));
  const [providers, setProviders] = useState<Rows>(() => toRows(data.budgets.providers));
  const [extra, setExtra] = useState<string[]>([]);
  const [adding, setAdding] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; issues?: string[] } | null>(null);

  const modelIds = useMemo(() => [...new Set([...spend.models.map((m) => m.model), ...data.configuredModels, ...Object.keys(data.budgets.models), ...extra])].sort(), [spend.models, data.configuredModels, data.budgets.models, extra]);
  const providerIds = useMemo(() => [...new Set(["anthropic", ...spend.providers.map((p) => p.provider), ...Object.keys(data.budgets.providers)])].sort(), [spend.providers, data.budgets.providers]);
  const modelSpend = (id: string) => spend.models.filter((m) => m.model === id).reduce((a, m) => ({ today: a.today + m.todayUsd, month: a.month + m.monthUsd, purposes: [...new Set([...a.purposes, ...m.purposes])] }), { today: 0, month: 0, purposes: [] as string[] });
  const providerSpend = (id: string) => spend.providers.find((p) => p.provider === id) ?? { todayUsd: 0, monthUsd: 0, forecastUsd: 0 };
  const saved = (kind: "models" | "providers", id: string) => data.budgets[kind][id];
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
      const body = (await res.json().catch(() => ({}))) as { error?: string; issues?: string[]; reference?: string; budgets?: LlmBudgets };
      if (!res.ok) setMsg({ ok: false, text: (body.error ?? `HTTP ${res.status}`) + (body.reference ? ` (ref ${body.reference})` : ""), issues: body.issues });
      else {
        if (body.budgets) {
          setModels(toRows(body.budgets.models));
          setProviders(toRows(body.budgets.providers));
        }
        setMsg({ ok: true, text: "Saved. The site applies it now; the SEO agent within about 30 seconds." });
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
        A daily and a monthly limit for each model, and for each provider (all of its models together, for example the credit on your Anthropic account). Every limit is optional: leave a field empty for no limit.
        They count every Claude call by the site and the SEO agent (drafts, agent flows, Ask the Blog and the news desk), and a call must fit all of them. Days and months are UTC{spend.monthResetsAt ? `; this month ends ${spend.monthResetsAt.slice(0, 10)}` : ""}. Changes are audit-logged.
      </p>
      <form onSubmit={save} className="mt-4 space-y-6">
        <div className="overflow-x-auto">
          <table className="w-full text-sm" aria-label="Provider budgets">
            <thead><tr className="text-left text-xs text-fg-subtle"><th className="py-1 font-medium">Provider (all its models)</th><th className="font-medium">Today</th><th className="font-medium">This month</th><th className="font-medium">Month-end forecast</th><th className="font-medium">Daily limit</th><th className="font-medium">Monthly limit</th></tr></thead>
            <tbody>
              {providerIds.map((id) => {
                const s = providerSpend(id);
                const lim = saved("providers", id);
                return (
                  <tr key={id} className="border-t border-line">
                    <td className="py-1.5"><code>{id}</code></td>
                    <td className="tabular-nums">{spent(s.todayUsd, lim?.dailyUsd)}</td>
                    <td className="tabular-nums">{spent(s.monthUsd, lim?.monthlyUsd)}</td>
                    <td className="tabular-nums">{spent(s.forecastUsd, lim?.monthlyUsd)}</td>
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
                const lim = saved("models", id);
                return (
                  <tr key={id} className="border-t border-line">
                    <td className="py-1.5"><code>{id}</code></td>
                    <td className="text-xs text-fg-subtle">{s.purposes.length ? s.purposes.join(", ") : "—"}</td>
                    <td className="tabular-nums">{spent(s.today, lim?.dailyUsd)}</td>
                    <td className="tabular-nums">{spent(s.month, lim?.monthlyUsd)}</td>
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
        {data.featureCaps.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold text-fg">Feature caps (also apply)</h3>
            <ul className="mt-1 space-y-1 text-sm text-fg-muted">
              {data.featureCaps.map((c) => (
                <li key={c.feature}><strong className="text-fg">{c.feature}</strong>: {c.limit}, {c.scope}. Set in {c.href ? <Link className="underline" href={c.href}>{c.where}</Link> : c.where}.</li>
              ))}
            </ul>
          </div>
        )}
        {msg && <Alert tone={msg.ok ? "success" : "error"}>{msg.text}{msg.issues?.length ? <ul className="mt-1 list-disc pl-5">{msg.issues.map((i) => <li key={i}>{i}</li>)}</ul> : null}</Alert>}
        <Button type="submit" loading={busy}>Save budgets</Button>
      </form>
    </Card>
  );
}
