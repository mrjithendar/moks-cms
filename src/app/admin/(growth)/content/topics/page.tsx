import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { rowsOf } from "@/db/rows";
import { AdminHeader } from "@/components/admin/ui";
import { TopicsEditor } from "@/components/news/TopicsEditor";
import { listTopics } from "@/lib/news/service";

export const metadata = { title: "Content topics" };

/** AI & SEO → Topics: the content topics every crew job classifies items into, each mapped to one of the site's categories. */
export default async function ContentTopicsPage() {
  const db = await getDb();
  const topics = await listTopics();
  const categories = rowsOf<{ slug: string; label: string }>(await db.execute(sql`select slug, label from category order by sort, slug`));
  const [m] = rowsOf<{ version: string; metrics: unknown; n_samples: number }>(await db.execute(sql`select version, metrics, n_samples from news_models where kind = 'classifier' and active`));
  const metrics = (typeof m?.metrics === "string" ? JSON.parse(m.metrics) : m?.metrics ?? {}) as { per_topic?: Record<string, never>; macro_f1?: number | null };
  return (
    <>
      <AdminHeader title="Content topics" description="Topics map to the site's own categories (Posts → Categories; no duplicates) and are shared by every crew job. Your category corrections in review become training labels; the classifier retrains weekly." />
      <TopicsEditor
        topics={topics.map((t) => ({ slug: String(t.slug), label: String(t.label), category_slug: (t.category_slug as string | null) ?? null, keywords: (t.keywords as string[]) ?? [], tags: (t.tags as string[]) ?? [], enabled: Boolean(t.enabled) }))}
        categories={categories}
        accuracy={metrics.per_topic ?? {}}
        model={m ? { version: m.version, macro_f1: metrics.macro_f1 ?? null, n: Number(m.n_samples) } : null}
      />
    </>
  );
}
