import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { rowsOf } from "@/db/rows";
import { AdminHeader } from "@/components/admin/ui";
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
  return (
    <>
      <AdminHeader title="Content profiles & playground" description="Versioned writing and image profiles that crew jobs write with. Proposed versions come from the weekly style review of your edits; nothing is applied until you approve it." actions={<StyleReviewButton />} />
      <ProfileStudio
        writing={plain(writing) as never}
        image={plain(image) as never}
        jobs={jobs.map((j) => ({ value: j.id, label: j.name }))}
        clusters={clusters.map((c) => ({ value: c.id, label: `${c.title.slice(0, 80)} (${c.source_count} src)` }))}
      />
    </>
  );
}
