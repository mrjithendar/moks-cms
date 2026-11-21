import Link from "next/link";
import { AdminHeader, Card } from "@/components/admin/ui";
import { AddPromptForm } from "@/components/seo/AddPromptForm";
import { ApiButton } from "@/components/seo/ApiButton";
import { Badge } from "@/components/seo/badges";
import { TrendLine } from "@/components/seo/Charts";
import { Empty, Section } from "@/components/seo/ui";
import { AI_PROVIDER_LABEL, AI_PROVIDERS, aiVisibilityOverview, NO_AI_OVERVIEW, providerReadiness, type AiProvider } from "@/lib/seo-intel/ai-visibility";
import { getSeoSettings } from "@/lib/seo-intel/settings";

export const metadata = { title: "AI visibility" };

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "—");

type Cell = { cited: boolean; mentioned: boolean; cited_rank: number | null; error: string | null; run_on: string } | undefined;

function CellView({ c }: { c: Cell }) {
  if (!c) return <span className="text-fg-subtle">—</span>;
  if (c.error === NO_AI_OVERVIEW) return <span className="text-xs text-fg-subtle" title="Google showed no AI Overview for this query">none</span>;
  if (c.error) return <span className="text-xs text-red-800 dark:text-red-300" title={c.error}>error</span>;
  if (c.cited) return <Badge t="green" title={`Cited as source #${c.cited_rank} (${c.run_on})`}>cited #{c.cited_rank}</Badge>;
  if (c.mentioned) return <Badge t="blue" title={`Named in the answer but not linked (${c.run_on})`}>mentioned</Badge>;
  return <span className="text-xs text-fg-subtle" title={c.run_on}>not cited</span>;
}

/** Are AI assistants citing this site for the questions its readers ask? Weekly API answers; see docs/seo/AI_VISIBILITY.md. */
export default async function AiVisibilityPage() {
  const s = await getSeoSettings();
  const [o, ready] = [await aiVisibilityOverview(), providerReadiness(s)];
  const active = ready.filter((r) => r.ready);
  const shown = AI_PROVIDERS.filter((id) => active.some((a) => a.id === id) || o.prompts.some((p) => p.cells[id]));
  const gaps = o.prompts.filter((p) => p.gap && p.active);
  return (
    <>
      <AdminHeader
        title="AI visibility"
        description={`Each week the prompts below are asked to the enabled AI assistants with web search on; a prompt is "cited" when a source in the answer is on ${o.host}, "mentioned" when the answer names the site. These are API answers: the consumer apps can differ (models, memory, location), so read them as a trend for the same prompts.`}
        actions={
          s.aiVisibility.enabled && active.length ? (
            <ApiButton url="/api/admin/seo/ai-visibility" body={{ action: "run" }} label="Run now" confirm={`Ask ${o.prompts.filter((p) => p.active).length} prompt(s) to ${active.length} assistant(s)? Spend so far this month: $${o.spentUsd.toFixed(2)}; it counts against the LLM budget. Answers already collected today are not bought again.`} />
          ) : undefined
        }
      />
      <Card className="mb-4 !p-4 text-sm">
        <p className="text-fg">
          {s.aiVisibility.enabled ? "On" : "Off"} · weekly run on weekday {s.aiVisibility.weekday} at {String(s.aiVisibility.hourUtc).padStart(2, "0")}:00 UTC · up to {s.aiVisibility.maxPrompts} prompts · ${o.spentUsd.toFixed(2)} this month, counted in the LLM budget
        </p>
        <ul className="mt-2 flex flex-wrap gap-2 text-xs">
          {ready.map((r) => (
            <li key={r.id}>
              <Badge t={r.ready ? "green" : r.enabled ? "amber" : "gray"} title={r.reason ?? undefined}>{r.label}: {r.ready ? "on" : r.enabled ? r.reason : "off"}</Badge>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-fg-subtle">Switches, models and the monthly cap: Settings → AI &amp; drafts → AI visibility. API keys: the site&apos;s Secret (docs/seo/AI_VISIBILITY.md).</p>
      </Card>

      {o.byProvider.length > 0 && (
        <ul className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {o.byProvider.map((p) => {
            const t = o.trend.filter((x) => x.provider === p.id);
            return (
              <li key={p.id}>
                <Card className="!p-4">
                  <p className="text-xs text-fg-subtle">{p.label}</p>
                  <p className="text-2xl font-semibold tabular-nums text-fg">{pct(p.cited, p.answers)} <span className="text-sm font-normal text-fg-muted">cited</span></p>
                  <p className="text-xs tabular-nums text-fg-muted">{p.cited} of {p.answers} prompts · mentioned in {pct(p.mentioned, p.answers)} · last run {p.lastRun}</p>
                  <div className="mt-2"><TrendLine label={`Share of prompts citing the site, ${p.label}, by week`} unit="%" data={t.map((x) => ({ date: x.week, value: x.answers ? Math.round((x.cited / x.answers) * 100) : null }))} height={90} /></div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      <Section title="Prompts" description="Latest answer per assistant. Open a prompt for the answers, their sources and the history.">
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1"><AddPromptForm /></div>
          <ApiButton url="/api/admin/seo/ai-visibility" body={{ action: "suggest", limit: 10 }} label="Add 10 from Search Console" variant="ghost" />
        </div>
        {o.prompts.length ? (
          <div className="overflow-x-auto rounded-xl border border-line">
            <table className="w-full min-w-[40rem] text-sm">
              <thead className="bg-surface-muted text-left text-xs text-fg-subtle">
                <tr>
                  <th scope="col" className="px-3 py-2">Prompt</th>
                  {shown.map((id) => <th key={id} scope="col" className="px-3 py-2">{AI_PROVIDER_LABEL[id as AiProvider]}</th>)}
                  <th scope="col" className="px-3 py-2"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {o.prompts.map((p) => (
                  <tr key={p.id} className={p.active ? "" : "opacity-60"}>
                    <td className="px-3 py-2">
                      <Link href={`/admin/ai-visibility/${p.id}`} className="font-medium text-fg hover:underline [overflow-wrap:anywhere]">{p.prompt}</Link>
                      <span className="ml-2 text-[10px] text-fg-subtle">{p.source === "search_console" ? "from Search Console" : ""}{p.active ? "" : " · paused"}</span>
                    </td>
                    {shown.map((id) => <td key={id} className="px-3 py-2"><CellView c={p.cells[id]} /></td>)}
                    <td className="px-3 py-2">
                      <span className="flex flex-wrap gap-1">
                        <ApiButton url="/api/admin/seo/ai-visibility" body={{ action: "toggle", id: p.id, active: !p.active }} label={p.active ? "Pause" : "Resume"} variant="ghost" />
                        <ApiButton url="/api/admin/seo/ai-visibility" body={{ action: "remove", id: p.id }} label="Remove" variant="ghost" confirm={`Remove “${p.prompt}” and its answer history?`} />
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty>No prompts yet. Add the questions your readers would ask, or take suggestions from Search Console.</Empty>}
      </Section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title={`Not cited anywhere (${gaps.length})`} description="Assistants answered these, but none cited the site: candidates for a new article or a sharper section in an existing one.">
          {gaps.length ? (
            <ul className="grid gap-2">
              {gaps.slice(0, 30).map((g) => (
                <li key={g.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <Link href={`/admin/ai-visibility/${g.id}`} className="text-fg hover:underline [overflow-wrap:anywhere]">{g.prompt}</Link>
                  <ApiButton url="/api/admin/seo/keywords/actions" body={{ action: "draft_new_article", query: g.prompt, evidence: "AI visibility: no assistant cited the site for this prompt" }} label="Send to editorial calendar" variant="ghost" />
                </li>
              ))}
            </ul>
          ) : <Empty>Every answered prompt cites the site somewhere.</Empty>}
        </Section>
        <Section title="Who gets cited instead" description="Domains cited in the latest answers, by number of prompts.">
          {o.competitors.length ? (
            <ol className="divide-y divide-line text-sm">
              {o.competitors.map((c) => <li key={c.domain} className="flex justify-between gap-3 py-1.5"><span className="truncate text-fg">{c.domain}</span><span className="tabular-nums text-fg-muted">{c.prompts}</span></li>)}
            </ol>
          ) : <Empty>No answers yet.</Empty>}
        </Section>
      </div>
    </>
  );
}
