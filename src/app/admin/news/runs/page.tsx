import { LocalTime } from "@/components/LocalTime";
import Link from "next/link";
import { AdminHeader, Card, Table, td, th } from "@/components/admin/ui";
import { StatusBadge } from "@/components/seo/badges";
import { listJobs, listRuns } from "@/lib/news/service";

export const metadata = { title: "Run history" };
const STATUSES = ["running", "succeeded", "failed", "paused_budget", "skipped", "cancelled"];
const TRIGGERS = ["cron", "manual", "dry_run", "mcp", "retry"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export default async function RunsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const q = await searchParams;
  const job = q.job && UUID.test(q.job) ? q.job : null;
  const status = q.status && STATUSES.includes(q.status) ? q.status : null;
  const trigger = q.trigger && TRIGGERS.includes(q.trigger) ? q.trigger : null;
  const [runs, jobs] = await Promise.all([listRuns({ jobId: job, status, trigger, before: q.before ?? null, limit: 50 }), listJobs()]);
  const href = (k: string, v: string | null) => {
    const p = new URLSearchParams(Object.entries({ job, status, trigger }).filter((e): e is [string, string] => Boolean(e[1])));
    if (v) p.set(k, v);
    else p.delete(k);
    return `/admin/news/runs${p.size ? `?${p}` : ""}`;
  };
  const chip = (k: string, v: string | null, label: string, on: boolean) => (
    <Link key={`${k}:${v}`} href={href(k, v)} className={`inline-flex min-h-9 items-center rounded-full border px-3 text-xs ${on ? "border-accent bg-accent/10 text-fg" : "border-line text-fg-muted"}`}>
      {label}
    </Link>
  );
  return (
    <>
      <AdminHeader title="Run history" description="Every job, ingest, image, training and style-review run, with counters, cost and errors." />
      <div className="mb-4 flex flex-wrap gap-2">
        {chip("job", null, "All jobs", !job)}
        {jobs.map((j) => chip("job", j.id, j.name, job === j.id))}
      </div>
      <div className="mb-6 flex flex-wrap gap-2">
        {chip("status", null, "Any status", !status)}
        {STATUSES.map((s) => chip("status", s, s.replace(/_/g, " "), status === s))}
        <span className="mx-1 border-l border-line" aria-hidden="true" />
        {chip("trigger", null, "Any trigger", !trigger)}
        {TRIGGERS.map((t) => chip("trigger", t, t.replace(/_/g, " "), trigger === t))}
      </div>
      {runs.length === 0 ? (
        <Card><p className="text-sm text-fg-muted">No runs match.</p></Card>
      ) : (
        <Table head={<tr><th className={th}>Started</th><th className={th}>Job / kind</th><th className={th}>Trigger</th><th className={th}>Status</th><th className={th}>Duration</th><th className={th}>Counters</th><th className={th}>Cost</th><th className={th}>Error</th></tr>}>
          {runs.map((r) => {
            const c = r.counters as Record<string, number>;
            return (
              <tr key={String(r.id)} className="border-t border-line">
                <td className={td}><Link href={`/admin/news/runs/${String(r.id)}`} className="font-medium text-fg hover:underline"><LocalTime iso={String(r.started_at)} /></Link></td>
                <td className={td}>{String(r.job_name ?? "—")}<p className="text-xs text-fg-subtle">{String(r.kind)}{r.dry_run ? " · dry run" : ""}</p></td>
                <td className={td}>{String(r.trigger)}</td>
                <td className={td}><StatusBadge status={String(r.status)} /></td>
                <td className={`${td} tabular-nums`}>{Math.round(Number(r.seconds ?? 0))} s</td>
                <td className={`${td} text-xs`}>{["fetched", "new", "deduped", "clustered", "scored", "selected", "drafted", "failed_quality", "failed", "skipped_budget"].filter((k) => c[k]).map((k) => `${k.replace(/_/g, " ")} ${c[k]}`).join(" · ") || "—"}</td>
                <td className={`${td} tabular-nums`}>${(Number(r.cost_usd) + Number(r.image_cost_usd)).toFixed(3)}</td>
                <td className={`${td} max-w-xs text-xs text-red-700 dark:text-red-300 min-w-48 [overflow-wrap:anywhere]`}>{String(r.error_summary ?? "")}</td>
              </tr>
            );
          })}
        </Table>
      )}
      {runs.length === 50 && <p className="mt-4 text-sm"><Link className="underline" href={href("before", String(runs[runs.length - 1]!.started_at))}>Older runs →</Link></p>}
    </>
  );
}
