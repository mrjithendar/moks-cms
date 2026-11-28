import type { ReactNode } from "react";
import { LocalTime } from "@/components/LocalTime";
import { SectionHeading } from "@/components/admin/SettingsParts";
import { Card } from "@/components/admin/ui";
import { Alert } from "@/components/ui/form";
import { loadLlmStatus, type LlmStatusLoad } from "@/lib/llm/status";

/**
 * Settings → AI & models → LiteLLM (D-110; "LLM providers & budget" before it). LiteLLM is the site's only LLM gateway:
 * it holds the providers, models, provider keys, routing and budgets. This page only shows what the web app and the SEO
 * agent each see of it (connection, aliases, their keys' and team's spend and budgets) and links to LiteLLM's own Admin
 * UI, where all of it is changed. No key is shown, and LiteLLM's master key is never used here.
 */

const usd = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `$${v < 1 ? v.toFixed(4) : v.toFixed(2)}`);
const per = (d: string | null | undefined) => (d ? ` per ${d.replace(/^1d$/, "day").replace(/^7d$/, "week").replace(/^30d$/, "30 days").replace(/^1mo$/, "month")}` : "");

type Line = { who: string; alias: string | null; spend: number | null; max: number | null; duration: string | null; reset: string | null; models: string[] };

const CALLER: Record<string, string> = {
  agent: "SEO agent: flows, crews, content flows, reports",
  ask: "Ask the Blog (readers)",
  seo: "Web app: drafts, keyword intents, SEO enrichment, AI visibility",
  practice: "Python practice tutor",
};

function Budget({ spend, max, duration, reset }: Pick<Line, "spend" | "max" | "duration" | "reset">) {
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

function State({ ok, label }: { ok: boolean | null; label: string }) {
  const tone = ok === null ? "bg-surface-sunken text-fg-muted" : ok ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200" : "bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-200";
  return <span className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>{label}</span>;
}

function Row({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[11rem_1fr] sm:gap-3">
      <dt className="text-sm text-fg-muted">{term}</dt>
      <dd className="min-w-0 text-sm text-fg [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

const code = (v: string | null | undefined) => (v ? <code className="font-mono text-xs">{v}</code> : "—");

export function LiteLlmCard({ load }: { load: LlmStatusLoad }) {
  const { web, agent } = load;
  const lines: Line[] = [
    ...(agent?.keys ?? []).map((k) => ({ who: k.caller, alias: k.alias, spend: k.spend_usd, max: k.max_budget_usd, duration: k.budget_duration, reset: k.budget_reset_at, models: k.models })),
    ...(web.usage?.keys ?? []).map((k) => ({ who: k.caller, alias: k.alias, spend: k.spendUsd, max: k.maxBudgetUsd, duration: k.budgetDuration, reset: k.budgetResetAt, models: k.models })),
  ];
  const team = agent?.team ? { alias: agent.team.alias, spend: agent.team.spend_usd, max: agent.team.max_budget_usd, duration: agent.team.budget_duration, reset: agent.team.budget_reset_at } : web.usage?.team ? { alias: web.usage.team.alias, spend: web.usage.team.spendUsd, max: web.usage.team.maxBudgetUsd, duration: web.usage.team.budgetDuration, reset: web.usage.team.budgetResetAt } : null;
  const notes = [...(web.usage?.errors ?? []), ...(agent?.errors ?? []), ...(load.agentError ? [load.agentError] : [])].filter((e, i, all) => all.indexOf(e) === i);
  const webState = !web.config ? { ok: null, label: "Not configured" } : web.health.ok ? { ok: true, label: "Connected" } : { ok: false, label: "Not reachable" };
  const agentState = load.agentError ? { ok: null, label: "Unknown" } : !agent?.configured ? { ok: null, label: "Not configured" } : agent.healthy ? { ok: true, label: "Connected" } : { ok: false, label: "Not reachable" };
  const targets = new Map((agent?.models ?? []).flatMap((m) => (m.name ? [[m.name, m.target] as const] : [])));
  const aliases = [...new Set([...(agent?.models ?? []).flatMap((m) => (m.name ? [m.name] : [])), ...web.health.aliases])].filter((a) => a !== "all-proxy-models").sort();
  return (
    <Card className="mb-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="min-w-0 max-w-3xl text-sm text-fg-muted">
          Every model call of this site goes through LiteLLM. It chooses the provider and model behind each alias, holds the provider keys and enforces the budgets: change them there. Spend can trail the last calls by up to a minute. Image and video generation are not model calls through LiteLLM (Settings → AI &amp; models → Image generation, Video generation).
        </p>
        {load.uiUrl && (
          <a href={load.uiUrl} target="_blank" rel="noreferrer" className="shrink-0 text-sm font-semibold link">
            Open LiteLLM ↗
          </a>
        )}
      </div>

      {!web.config && (
        <div className="mt-4">
          <Alert tone="info">
            The web app does not use LiteLLM yet: set {web.missing.map((m, i) => <span key={m}>{i ? " and " : ""}<code>{m}</code></span>)} (Secret <code>jithendar-com-env</code>). Until then drafts, keyword intents, SEO enrichment, AI visibility and the tutor make no model calls.
          </Alert>
        </div>
      )}
      {web.config && web.health.missing.length > 0 && (
        <div className="mt-4">
          <Alert tone="info">
            LiteLLM does not list {web.health.missing.map((m, i) => <span key={m}>{i ? ", " : ""}<code>{m}</code></span>)} for the web app&apos;s key: add the alias in LiteLLM (Models + Endpoints) or to the key&apos;s models.
          </Alert>
        </div>
      )}
      {notes.length > 0 && (
        <div className="mt-4">
          <Alert tone="info">{notes.join(" ")}</Alert>
        </div>
      )}

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <section aria-labelledby="litellm-web" className="min-w-0 rounded-lg border border-line p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id="litellm-web" className="text-sm font-semibold text-fg">Web app</h3>
            <State {...webState} />
          </div>
          <dl className="mt-3 space-y-2">
            <Row term="Endpoint">{code(web.config?.baseUrl)}</Row>
            <Row term="Default alias">{code(web.config?.model)}</Row>
            <Row term="Fast alias">{code(web.config?.modelFast)}</Row>
            <Row term="Tutor alias">{code(web.config?.modelPractice)}</Row>
            <Row term="Last health check">
              <LocalTime iso={web.health.checkedAt} />
              {web.health.latencyMs !== null ? ` · ${web.health.latencyMs} ms` : ""}
              {web.health.error ? <span className="block text-fg-muted">{web.health.error}</span> : null}
            </Row>
          </dl>
        </section>
        <section aria-labelledby="litellm-agent" className="min-w-0 rounded-lg border border-line p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id="litellm-agent" className="text-sm font-semibold text-fg">SEO agent</h3>
            <State {...agentState} />
          </div>
          <dl className="mt-3 space-y-2">
            <Row term="Endpoint">{code(agent?.base_url)}</Row>
            <Row term="Default alias">{code(agent?.aliases.default)}</Row>
            <Row term="Fast alias">{code(agent?.aliases.fast)}</Row>
            <Row term="Last health check">{agent ? <LocalTime iso={agent.checked_at} /> : "—"}</Row>
          </dl>
        </section>
      </div>

      {team && (
        <section className="mt-5" aria-labelledby="litellm-team">
          <h3 id="litellm-team" className="text-sm font-semibold text-fg">Team {team.alias ?? ""}: all keys together</h3>
          <div className="mt-2">
            <Budget spend={team.spend} max={team.max} duration={team.duration} reset={team.reset} />
          </div>
        </section>
      )}
      {lines.length > 0 && (
        <section className="mt-5" aria-labelledby="litellm-keys">
          <h3 id="litellm-keys" className="text-sm font-semibold text-fg">Keys</h3>
          <ul className="mt-2 divide-y divide-line rounded-lg border border-line">
            {lines.map((k) => (
              <li key={`${k.who}-${k.alias}`} className="flex flex-col gap-1.5 p-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-fg [overflow-wrap:anywhere]">{CALLER[k.who] ?? k.who}</p>
                  <p className="font-mono text-xs text-fg-subtle [overflow-wrap:anywhere]">{k.alias ?? "(no key alias)"}</p>
                </div>
                <div className="min-w-0 sm:w-80 sm:shrink-0">
                  <Budget spend={k.spend} max={k.max} duration={k.duration} reset={k.reset} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {aliases.length > 0 && (
        <section className="mt-5" aria-labelledby="litellm-aliases">
          <h3 id="litellm-aliases" className="text-sm font-semibold text-fg">Aliases these keys may use</h3>
          <ul className="mt-2 space-y-1 text-sm">
            {aliases.map((a) => (
              <li key={a} className="flex flex-wrap gap-x-2 [overflow-wrap:anywhere]">
                <span className="font-mono text-xs text-fg">{a}</span>
                {targets.get(a) ? <span className="text-fg-subtle">→ {targets.get(a)}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      )}
    </Card>
  );
}

export default async function LiteLlmSection() {
  const load = await loadLlmStatus();
  return (
    <section aria-labelledby="litellm-title" className="space-y-4">
      <SectionHeading id="litellm-title" title="LiteLLM" description="The site's LLM gateway: whether the web app and the SEO agent reach it, the aliases they ask for, and their keys' budgets and spend. Read only: change models, keys and budgets in LiteLLM." />
      <LiteLlmCard load={load} />
    </section>
  );
}
