import { LocalTime } from "@/components/LocalTime";
import Link from "next/link";
import { AdminHeader, Card, Stat, Table, td, th } from "@/components/admin/ui";
import { ApiButton } from "@/components/seo/ApiButton";
import { StatusBadge } from "@/components/seo/badges";
import { getNewsSettings, listJobs } from "@/lib/news/service";

export const metadata = { title: "Jobs" };

const ago = (iso: unknown) => {
  if (!iso) return "never";
  const h = Math.round((Date.now() - Date.parse(String(iso))) / 3_600_000);
  return h < 1 ? "< 1 h ago" : h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
};

type LastRun = { id: string; status: string; started_at: string; counters: Record<string, number> } | null;

export default async function NewsJobsPage() {
  const [jobs, s] = await Promise.all([listJobs(), getNewsSettings()]);
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
        title="News desk"
        description="Jobs discover stories from trusted sources, rank them, and draft source-grounded news for your review. Nothing publishes without your approval."
        actions={<Link href="/admin/news/jobs/new" className="inline-flex min-h-11 items-center rounded-lg bg-accent px-4 text-sm font-semibold text-white">New job</Link>}
      />
      <div className="mb-8 grid gap-4 sm:grid-cols-3">
        <Stat label="Drafts today" value={today} hint={`global cap ${s.max_drafts_per_day}`} />
        <Stat label="Month-to-date cost" value={`$${month.toFixed(2)}`} hint={`caps: LLM $${s.llm_monthly_usd} · images $${s.image_monthly_usd}`} />
        <Stat label="Jobs" value={jobs.length} hint={`${jobs.filter((j) => j.enabled).length} enabled`} />
      </div>
      {jobs.length === 0 ? (
        <Card>
          <p className="text-sm text-fg-muted">No jobs yet. Add sources first (Sources → Add source), then create a job and try a dry run.</p>
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
                      <Link href={`/admin/news/jobs/${j.id}`} className="font-semibold text-fg hover:underline">{j.name}</Link>
                      <p className="text-xs text-fg-subtle">{j.enabled ? "enabled" : "paused"} · v{j.version} · {j.mode.replace(/_/g, " ")}</p>
                    </td>
                    <td className={td}>
                      <code className="text-xs">{j.cron}</code>
                      <p className="text-xs text-fg-subtle">{j.timezone}{j.next_runs[0] ? <> · next <LocalTime iso={j.next_runs[0]} /></> : ""}</p>
                    </td>
                    <td className={td}>
                      {run ? (
                        <>
                          <Link href={`/admin/news/runs/${run.id}`} className="hover:underline"><StatusBadge status={run.status} /></Link>
                          <p className="text-xs text-fg-subtle">{ago(run.started_at)} · {run.counters?.drafted ?? 0} drafted</p>
                        </>
                      ) : (
                        "never"
                      )}
                    </td>
                    <td className={`${td} tabular-nums`}>{j.drafts_today} / {j.config.max_articles_per_day}</td>
                    <td className={`${td} tabular-nums`}>${j.month_cost.toFixed(2)} <span className="text-xs text-fg-subtle">/ ${(j.config.budget.llm_monthly_usd + j.config.budget.image_monthly_usd).toFixed(0)}</span></td>
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
                  <Link href={`/admin/news/jobs/${j.id}`} className="font-semibold text-fg">{j.name}</Link>
                  <p className="mt-1 text-xs text-fg-subtle">{j.enabled ? "enabled" : "paused"} · {j.cron} ({j.timezone}) · today {j.drafts_today}/{j.config.max_articles_per_day} · ${j.month_cost.toFixed(2)} this month</p>
                  <div className="mt-3">{actions(j.id, j.enabled)}</div>
                </Card>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
