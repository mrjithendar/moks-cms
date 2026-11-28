import { LocalTime } from "@/components/LocalTime";
import { Card } from "@/components/admin/ui";
import { Alert } from "@/components/ui/form";
import type { GatewayKeyView } from "@/lib/llm-gateway";
import type { AgentGatewayStatus } from "@/lib/seo-agent/client";

/**
 * Settings → AI & models → LLM providers & budget, when LiteLLM is the gateway (D-109): which keys the site's model
 * calls use, their budgets and spend, their team's, and what each alias points at. Read only: budgets, models and
 * credentials are changed in LiteLLM (its Admin UI); nothing here holds a key.
 */
export type LlmGatewayLoad = {
  agent: AgentGatewayStatus | null;
  web: { keys: GatewayKeyView[]; errors: string[] } | null;
  uiUrl: string | null;
  agentError: string | null;
};

const CALLER: Record<string, string> = {
  agent: "SEO agent: flows, crews, content flows, reports",
  ask: "Ask the Blog (readers)",
  seo: "Web app: drafts, keyword intents, SEO enrichment",
  practice: "Python practice tutor",
};

const usd = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `$${v < 1 ? v.toFixed(4) : v.toFixed(2)}`);
const per = (d: string | null | undefined) => (d ? ` per ${d.replace(/^1d$/, "day").replace(/^30d$/, "30 days").replace(/^1mo$/, "month")}` : "");

function Budget({ spend, max, duration, reset }: { spend: number | null; max: number | null; duration: string | null; reset: string | null }) {
  const pct = max && spend !== null ? Math.min(100, Math.round((spend / max) * 100)) : null;
  return (
    <div className="min-w-0">
      <p className="text-sm text-fg">
        {usd(spend)} spent{max !== null ? ` of ${usd(max)}${per(duration)}` : ": no budget set in LiteLLM"}
        {reset ? (
          <span className="text-fg-subtle">
            {" "}· resets <LocalTime iso={reset} />
          </span>
        ) : null}
      </p>
      {pct !== null && (
        <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken" role="progressbar" aria-label="Budget used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
          <div className={`h-full rounded-full ${pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-amber-500" : "bg-emerald-500"}`} style={{ width: `${Math.max(2, pct)}%` }} />
        </div>
      )}
    </div>
  );
}

export function LlmGatewayCard({ load }: { load: LlmGatewayLoad }) {
  const keys = [
    ...(load.agent?.keys ?? []).map((k) => ({ caller: k.caller, alias: k.alias, spend: k.spend_usd, max: k.max_budget_usd, duration: k.budget_duration, reset: k.budget_reset_at })),
    ...(load.web?.keys ?? []).map((k) => ({ caller: k.caller, alias: k.alias, spend: k.spendUsd, max: k.maxBudgetUsd, duration: k.budgetDuration, reset: k.budgetResetAt })),
  ];
  const errors = [...(load.agent?.errors ?? []), ...(load.web?.errors ?? []), ...(load.agentError ? [load.agentError] : [])];
  const team = load.agent?.team ?? null;
  return (
    <Card className="mb-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="llm-gateway" className="scroll-mt-24 text-lg font-semibold text-fg">LiteLLM gateway</h2>
          <p className="mt-1 max-w-3xl text-sm text-fg-muted">
            Every model call of this site goes through LiteLLM, except AI visibility (it asks each assistant itself) and image and video generation. LiteLLM chooses the provider and model behind each alias and enforces the budgets below; change them there. Spend can trail the last calls by up to a minute.
          </p>
        </div>
        {load.uiUrl && (
          <a href={load.uiUrl} target="_blank" rel="noreferrer" className="shrink-0 text-sm font-semibold link">
            Open LiteLLM ↗
          </a>
        )}
      </div>
      {errors.length > 0 && (
        <div className="mt-4">
          <Alert tone="info">{errors.join(" ")}</Alert>
        </div>
      )}
      {team && (
        <section className="mt-5" aria-labelledby="llm-gateway-team">
          <h3 id="llm-gateway-team" className="text-sm font-semibold text-fg">Team {team.alias ?? ""}: all keys together</h3>
          <div className="mt-2">
            <Budget spend={team.spend_usd} max={team.max_budget_usd} duration={team.budget_duration} reset={team.budget_reset_at} />
          </div>
        </section>
      )}
      {keys.length > 0 && (
        <section className="mt-5" aria-labelledby="llm-gateway-keys">
          <h3 id="llm-gateway-keys" className="text-sm font-semibold text-fg">Keys</h3>
          <ul className="mt-2 divide-y divide-line rounded-lg border border-line">
            {keys.map((k) => (
              <li key={`${k.caller}-${k.alias}`} className="flex flex-col gap-1.5 p-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-fg [overflow-wrap:anywhere]">{CALLER[k.caller] ?? k.caller}</p>
                  <p className="font-mono text-xs text-fg-subtle [overflow-wrap:anywhere]">{k.alias ?? "(no alias)"}</p>
                </div>
                <div className="min-w-0 sm:w-80 sm:shrink-0">
                  <Budget spend={k.spend} max={k.max} duration={k.duration} reset={k.reset} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {(load.agent?.models.length ?? 0) > 0 && (
        <section className="mt-5" aria-labelledby="llm-gateway-models">
          <h3 id="llm-gateway-models" className="text-sm font-semibold text-fg">Aliases</h3>
          <ul className="mt-2 space-y-1 text-sm">
            {load.agent!.models.map((m) => (
              <li key={m.name ?? ""} className="flex flex-wrap gap-x-2 [overflow-wrap:anywhere]">
                <span className="font-mono text-xs text-fg">{m.name}</span>
                <span className="text-fg-subtle">→ {m.target ?? "?"}</span>
                {m.input_usd_per_mtok !== null && (
                  <span className="text-fg-subtle">
                    · ${m.input_usd_per_mtok} in / ${m.output_usd_per_mtok ?? "?"} out per million tokens
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </Card>
  );
}
