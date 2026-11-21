import Link from "next/link";
import { notFound } from "next/navigation";
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { rowsOf } from "@/db/rows";
import { AdminHeader } from "@/components/admin/ui";
import { JobEditor, type JobForm } from "@/components/news/JobEditor";
import { jobConfigSchema } from "@/lib/news/schema";
import { getJob, jobVersions, listProfiles, listSources, listTopics } from "@/lib/news/service";

export const metadata = { title: "Job" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** /admin/crewai/jobs/new and /admin/crewai/jobs/{id}: the tabbed job editor with versions, diff and rollback. */
export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const isNew = id === "new";
  if (!isNew && !UUID.test(id)) notFound();
  const job = isNew ? null : await getJob(id);
  if (!isNew && !job) notFound();
  const db = await getDb();
  const [sources, topics, writing, image, versions] = await Promise.all([listSources(), listTopics(), listProfiles("writing"), listProfiles("image"), job ? jobVersions(id) : Promise.resolve([])]);
  const categories = rowsOf<{ slug: string; label: string }>(await db.execute(sql`select slug, label from category order by sort, slug`));
  const keys = (rows: Record<string, unknown>[]) => [...new Map(rows.map((r) => [String(r.key), { value: String(r.key), label: `${String(r.name)} (${String(r.key)})` }])).values()];
  const initial: JobForm = job
    ? { name: job.name, description: job.description, enabled: job.enabled, cron: job.cron, timezone: job.timezone, mode: job.mode, writing_profile_key: job.writing_profile_key, image_profile_key: job.image_profile_key, review_priority: job.review_priority, config: job.config as unknown as JobForm["config"] }
    : { name: "", description: "", enabled: false, cron: "0 7 * * *", timezone: "Asia/Kolkata", mode: "single_stories", writing_profile_key: "news-default", image_profile_key: "cover-template", review_priority: 50, config: jobConfigSchema.parse({}) as unknown as JobForm["config"] };
  return (
    <>
      <AdminHeader title={job ? job.name : "New job"} description={job ? <>Version {job.version}. Every save creates a new version; runs record the version they used. <Link href={`/admin/crewai/jobs/runs?job=${job.id}`} className="underline">Runs of this job</Link></> : "Start disabled, try a dry run, then enable it."} />
      <JobEditor
        id={job?.id ?? null}
        initial={initial}
        versions={versions.map((v) => ({ version: v.version, diff: v.diff as { path: string; before: unknown; after: unknown }[], note: v.note, created_by: v.created_by, created_at: String(v.created_at) }))}
        sources={sources.map((s) => ({ value: String(s.id), label: `${String(s.name)}${s.enabled ? "" : " (disabled)"}` }))}
        topics={topics.map((t) => ({ value: String(t.slug), label: String(t.label) }))}
        categories={categories.map((c) => ({ value: c.slug, label: c.label }))}
        writingKeys={keys(writing)}
        imageKeys={keys(image)}
      />
    </>
  );
}
