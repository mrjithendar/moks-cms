import { LocalTime } from "@/components/LocalTime";
import Link from "next/link";
import { AdminHeader, Card, Stat, Table, td, th } from "@/components/admin/ui";
import { ApiButton } from "@/components/seo/ApiButton";
import { StatusBadge } from "@/components/seo/badges";
import { SystemJobs } from "@/components/crewai/SystemJobs";
import { JobsSwitch } from "@/components/news/JobsSwitch";
import { newsDeskState, newsDeskStateText } from "@/lib/news/schema";
import { ensureNewsDefaults, getNewsSettings, listJobs } from "@/lib/news/service";

export const metadata = { title: "Jobs" };

const ago = (iso: unknown) => {
  if (!iso) return "never";
  const h = Math.round((Date.now() - Date.parse(String(iso))) / 3_600_000);
  return h < 1 ? "< 1 h ago" : h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
};

type LastRun = { id: string; status: string; started_at: string; counters: Record<string, number> } | null;

const KINDS = [
  { id: "all", label: "All jobs" },
  { id: "content", label: "Content jobs" },
  { id: "system", label: "System jobs" },
] as const;
type Kind = (typeof KINDS)[number]["id"];

/**
 * AI & SEO → Jobs: every job in one list (crew-jobs plan PR 2). Content jobs (news_jobs: news is one kind of content a
 * job writes; there is no Newsroom since 2026-11-21) with their switch and what each did today, and the system jobs
 * (the built-in flows' schedules, until then the CrewAI console's Schedules page). ?kind=content|system narrows it.
 */
export default async function CrewJobsPage({ searchParams }: { searchParams?: Promise<Record<string, string | undefined>> } = {}) {
  const sp = (await searchParams) ?? {};
  const kind: Kind = KINDS.find((k) => k.id === sp.kind)?.id ?? "all";
  const flow = sp.flow && /^[a-z][a-z0-9_]{2,39}_flow$/.test(sp.flow) ? sp.flow : null;
  await ensureNewsDefaults().catch(() => undefined);
  const [jobs, s] = await Promise.all([listJobs(), getNewsSettings()]);
  const desk = newsDeskState(s);
  const today = jobs.reduce((n, j) => n + j.drafts_today, 0);
  const month = jobs.reduce((n, j) => n + j.month_cost, 0);
  const actions = (id: string, enabled: boolean) => (
    <div className="flex flex-wrap gap-2">
      <ApiButton url={`/api/admin/news/jobs/${id}/actions`} body={{ action: "run" }} label="Run now" confirm="Run this job now? It drafts up to its per-run cap and spends from its budget." />
      <ApiButton url={`/api/admin/news/jobs/${id}/actions`} body={{ action: "dry_run", llm: true }} label="Dry run" variant="ghost" />
      <ApiButton url={`/api/admin/news/jobs/${id}/actions`} body={{ action: enabled ? "pause" : "resume" }} label={enabled ? "Pause" : "Resume"} variant="ghost" />
      <ApiButton url={`/api/admin/news/jobs/${id}/actions`} body={{ action: "clone" }} label="Clone" variant="ghost" />
    </div>
  );
  return (
    <>
      <AdminHeader
        title="Jobs"
        description="Crew jobs find stories and ideas in your content sources, rank them and draft source-grounded content for your review. Nothing publishes without your approval."
        actions={
          <>
            <Link href="/admin/crewai/jobs/runs" className="inline-flex min-h-11 items-center rounded-lg border border-line px-4 text-sm font-semibold text-fg hover:bg-surface-muted">Job runs</Link>
            <Link href="/admin/crewai/jobs/new" className="inline-flex min-h-11 items-center rounded-lg bg-accent px-4 text-sm font-semibold text-white">New job</Link>
          </>
        }
      />
      <nav aria-label="Kind of job" className="mb-6 flex flex-wrap gap-2">
        {KINDS.map((k) => (
          <Link key={k.id} href={k.id === "all" ? "/admin/crewai/jobs" : `/admin/crewai/jobs?kind=${k.id}`} aria-current={kind === k.id ? "page" : undefined} className={`inline-flex min-h-9 items-center rounded-full border px-3 text-sm ${kind === k.id ? "border-accent bg-accent/10 font-medium text-fg" : "border-line text-fg-muted hover:text-fg"}`}>
            {k.label}
          </Link>
        ))}
      </nav>
      {kind !== "system" && (
      <>
      <JobsSwitch desk={{ on: desk.on, by: desk.by, text: newsDeskStateText(desk) }} />
      <div className="mb-8 grid gap-4 sm:grid-cols-3">
        <Stat label="Drafts today" value={today} hint={<>all jobs: at most {s.max_drafts_per_day} (<Link className="underline" href="/admin/automation?section=agent-limits#job-settings-limits">limits</Link>)</>} />
        <Stat label="Month-to-date cost" value={`$${month.toFixed(2)}`} hint={`LLM spend counts in the LLM budget · image cap $${s.image_monthly_usd}`} />
        <Stat label="Jobs" value={jobs.length} hint={`${jobs.filter((j) => j.enabled).length} enabled`} />
      </div>
      {jobs.length === 0 ? (
        <Card>
          <p className="text-sm text-fg-muted">No jobs yet. Add content sources first (AI & SEO → Content sources), then create a job and try a dry run.</p>
        </Card>
      ) : (
        <>
          <div className="hidden md:block">
            <Table head={<tr><th className={th}>Job</th><th className={th}>Schedule</th><th className={th}>Last run</th><th className={th}>Today</th><th className={th}>Month cost</th><th className={th}>Actions</th></tr>}>
              {jobs.map((j) => {
                const run = j.last_run as LastRun;
                return (
                  <tr key={j.id} className="border-t border-line">
                    <td className={td}>
                      <Link href={`/admin/crewai/jobs/${j.id}`} className="font-semibold text-fg hover:underline">{j.name}</Link>
                      <p className="text-xs text-fg-subtle">{j.enabled ? "enabled" : "paused"} · v{j.version} · {j.mode.replace(/_/g, " ")}</p>
                    </td>
                    <td className={td}>
                      <code className="text-xs">{j.cron}</code>
                      <p className="text-xs text-fg-subtle">{j.timezone}{j.next_runs[0] ? <> · next <LocalTime iso={j.next_runs[0]} /></> : ""}</p>
                    </td>
                    <td className={td}>
                      {run ? (
                        <>
                          <Link href={`/admin/crewai/jobs/runs/${run.id}`} className="hover:underline"><StatusBadge status={run.status} /></Link>
                          <p className="text-xs text-fg-subtle">{ago(run.started_at)} · {run.counters?.drafted ?? 0} drafted</p>
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
            {jobs.map((j) => (
              <li key={j.id}>
                <Card>
                  <Link href={`/admin/crewai/jobs/${j.id}`} className="font-semibold text-fg">{j.name}</Link>
                  <p className="mt-1 text-xs text-fg-subtle">{j.enabled ? "enabled" : "paused"} · {j.cron} ({j.timezone}) · today {j.drafts_today}/{j.config.max_articles_per_day} · ${j.month_cost.toFixed(2)} this month</p>
                  <div className="mt-3">{actions(j.id, j.enabled)}</div>
                </Card>
              </li>
            ))}
          </ul>
        </>
      )}
      </>
      )}
      {kind !== "content" && <SystemJobs flow={flow} />}
    </>
  );
}
