import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { rowsOf } from "@/db/rows";
import { AdminHeader, Card } from "@/components/admin/ui";
import { ProfileStudio } from "@/components/news/ProfileStudio";
import { StyleReviewButton } from "@/components/news/StyleReviewButton";
import { listJobs, listProfiles } from "@/lib/news/service";

export const metadata = { title: "Content profiles & playground" };

/** AI & SEO → Profiles & playground: the writing and image profiles crew jobs write with, and a playground to try them. */
export default async function ContentProfilesPage() {
  const db = await getDb();
  const [writing, image, jobs] = await Promise.all([listProfiles("writing"), listProfiles("image"), listJobs()]);
  const clusters = rowsOf<{ id: string; title: string; source_count: number }>(await db.execute(sql`select id, title, source_count from news_clusters where last_seen > now() - interval '4 days' order by source_count desc, last_seen desc limit 40`));
  const plain = <T,>(v: T) => JSON.parse(JSON.stringify(v)) as T;
  const writes = (j: (typeof jobs)[number]) => (j.config.output === "article" ? "blog articles" : "news stories");
  // Which jobs write with each profile (crew-jobs plan PR 5): a profile is shared by every job that names it.
  const usedBy = (key: string, kind: "writing" | "image") => jobs.filter((j) => (kind === "writing" ? j.writing_profile_key : j.image_profile_key) === key);
  const keys = (rows: Record<string, unknown>[]) => [...new Set(rows.map((r) => String(r.key)))];
  return (
    <>
      <AdminHeader title="Content profiles & playground" description="Versioned writing and image profiles that crew jobs write with. Proposed versions come from the weekly style review of your edits; nothing is applied until you approve it." actions={<StyleReviewButton />} />
      <ProfileStudio
        writing={plain(writing) as never}
        image={plain(image) as never}
        jobs={jobs.map((j) => ({ value: j.id, label: `${j.name} (writes ${writes(j)})` }))}
        clusters={clusters.map((c) => ({ value: c.id, label: `${c.title.slice(0, 80)} (${c.source_count} src)` }))}
      />
      <section aria-labelledby="used-by" className="mt-10">
        <h2 id="used-by" className="mb-3 text-base font-semibold text-fg">Which jobs write with each profile</h2>
        <div className="grid gap-4 lg:grid-cols-2">
          {(["writing", "image"] as const).map((kind) => (
            <Card key={kind}>
              <h3 className="text-sm font-semibold text-fg">{kind === "writing" ? "Writing profiles" : "Image profiles"}</h3>
              <ul className="mt-3 space-y-2 text-sm">
                {keys(kind === "writing" ? writing : image).map((key) => {
                  const by = usedBy(key, kind);
                  return (
                    <li key={key}>
                      <code className="text-xs">{key}</code>
                      <span className="text-fg-muted"> · {by.length ? by.map((j) => `${j.name} (${writes(j)})`).join(", ") : "no job yet"}</span>
                    </li>
                  );
                })}
              </ul>
            </Card>
          ))}
        </div>
      </section>
    </>
  );
}
