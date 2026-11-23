import Link from "next/link";
import { LocalTime } from "@/components/LocalTime";
import { Card, Stat, Table, td, th } from "@/components/admin/ui";
import { JobsSwitch } from "@/components/news/JobsSwitch";
import { ApiButton } from "@/components/seo/ApiButton";
import { StatusBadge } from "@/components/seo/badges";
import { buttonClass } from "@/components/ui/form";
import { newsDeskState, newsDeskStateText } from "@/lib/news/schema";
import { ensureNewsDefaults, getNewsSettings, listJobs } from "@/lib/news/service";

const ago = (iso: unknown) => {
  if (!iso) return "never";
  const h = Math.round((Date.now() - Date.parse(String(iso))) / 3_600_000);
  return h < 1 ? "< 1 h ago" : h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
};

type LastRun = { id: string; status: string; started_at: string; counters: Record<string, number> } | null;

/**
 * The content flows on AI & SEO → Flows: each finds stories or ideas in the content sources, ranks them and drafts for
 * review, on its own schedule. Stored as `news_jobs` rows and run by news_job_flow; they were "crew jobs" (their own
 * Jobs page) from 2026-11-21 to 2026-11-23. A run's id is its flow run's id, so every link goes to the one Runs page.
 */
export async function ContentFlows() {
  await ensureNewsDefaults().catch(() => undefined);
  const [flows, s] = await Promise.all([listJobs(), getNewsSettings()]);
  const desk = newsDeskState(s);
  const today = flows.reduce((n, j) => n + j.drafts_today, 0);
  const month = flows.reduce((n, j) => n + j.month_cost, 0);
  const actions = (id: string, enabled: boolean) => (
    <div className="flex flex-wrap gap-2">
      <ApiButton url={`/api/admin/news/jobs/${id}/actions`} body={{ action: "run" }} label="Run now" confirm="Run this content flow now? It drafts up to its per-run cap and spends from its budget." />
      <ApiButton url={`/api/admin/news/jobs/${id}/actions`} body={{ action: "dry_run", llm: true }} label="Dry run" variant="ghost" />
      <ApiButton url={`/api/admin/news/jobs/${id}/actions`} body={{ action: enabled ? "pause" : "resume" }} label={enabled ? "Pause" : "Resume"} variant="ghost" />
      <ApiButton url={`/api/admin/news/jobs/${id}/actions`} body={{ action: "clone" }} label="Clone" variant="ghost" />
    </div>
  );
  return (
    <section aria-labelledby="content-flows" className="mb-10">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="content-flows" className="text-base font-semibold text-fg">Content flows</h2>
          <p className="mt-1 max-w-3xl text-sm text-fg-muted">Each finds stories and ideas in your content sources, ranks them and drafts source-grounded content for your review, on its own schedule. Nothing publishes without your approval.</p>
        </div>
        <Link href="/admin/crewai/flows/content/new" className={buttonClass("primary", "sm")}>New content flow</Link>
      </div>
      <JobsSwitch desk={{ on: desk.on, by: desk.by, text: newsDeskStateText(desk) }} />
      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Stat label="Drafts today" value={today} hint={<>all content flows: at most {s.max_drafts_per_day} (<Link className="underline" href="/admin/automation?section=agent-limits#job-settings-limits">limits</Link>)</>} />
        <Stat label="Month-to-date cost" value={`$${month.toFixed(2)}`} hint={`LLM spend counts in the LLM budget · image cap $${s.image_monthly_usd}`} />
        <Stat label="Content flows" value={flows.length} hint={`${flows.filter((j) => j.enabled).length} enabled`} />
      </div>
      {flows.length === 0 ? (
        <Card>
          <p className="text-sm text-fg-muted">No content flows yet. Add content sources first (AI &amp; SEO → Content sources), then create a content flow and try a dry run.</p>
        </Card>
      ) : (
        <>
          <div className="hidden md:block">
            <Table head={<tr><th className={th}>Flow</th><th className={th}>Schedule</th><th className={th}>Last run</th><th className={th}>Today</th><th className={th}>Month cost</th><th className={th}>Actions</th></tr>}>
              {flows.map((j) => {
                const run = j.last_run as LastRun;
                return (
                  <tr key={j.id} className="border-t border-line">
                    <td className={td}>
                      <Link href={`/admin/crewai/flows/content/${j.id}`} className="font-semibold text-fg hover:underline">{j.name}</Link>
                      <p className="text-xs text-fg-subtle">{j.enabled ? "enabled" : "paused"} · v{j.version} · {j.mode.replace(/_/g, " ")}</p>
                    </td>
                    <td className={td}>
                      <code className="text-xs">{j.cron}</code>
                      <p className="text-xs text-fg-subtle">{j.timezone}{j.next_runs[0] ? <> · next <LocalTime iso={j.next_runs[0]} /></> : ""}</p>
                    </td>
                    <td className={td}>
                      {run ? (
                        <>
                          <Link href={`/admin/crewai/runs/${run.id}`} className="hover:underline"><StatusBadge status={run.status} /></Link>
                          <p className="text-xs text-fg-subtle">{ago(run.started_at)} · {run.counters?.drafted ?? 0} drafted · <Link href={`/admin/crewai/runs?content=${j.id}`} className="hover:underline">all runs</Link></p>
                        </>
                      ) : (
                        "never"
                      )}
                    </td>
                    <td className={`${td} tabular-nums`}>{j.drafts_today} / {j.config.max_articles_per_day}</td>
                    <td className={`${td} tabular-nums`}>${j.month_cost.toFixed(2)} <span className="text-xs text-fg-subtle">· image cap ${j.config.budget.image_monthly_usd.toFixed(0)}</span></td>
                    <td className={td}>{actions(j.id, j.enabled)}</td>
                  </tr>
                );
              })}
            </Table>
          </div>
          <ul className="space-y-3 md:hidden">
            {flows.map((j) => (
              <li key={j.id}>
                <Card>
                  <Link href={`/admin/crewai/flows/content/${j.id}`} className="font-semibold text-fg">{j.name}</Link>
                  <p className="mt-1 text-xs text-fg-subtle">{j.enabled ? "enabled" : "paused"} · {j.cron} ({j.timezone}) · today {j.drafts_today}/{j.config.max_articles_per_day} · ${j.month_cost.toFixed(2)} this month</p>
                  <div className="mt-3">{actions(j.id, j.enabled)}</div>
                </Card>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
