import Link from "next/link";
import { AdminHeader, Card } from "@/components/admin/ui";
import { LabelTasks } from "@/components/seo/LabelTasks";
import { listLabels } from "@/lib/seo-intel/ml-admin";

export const metadata = { title: "Labelling" };
export const dynamic = "force-dynamic";

export default async function LabelsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const task = sp.task === "intent_check" ? "intent_check" : "cluster";
  const { rows, counts, groups } = await listLabels(task);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return (
    <>
      <AdminHeader
        title="Labelling"
        description={
          task === "cluster"
            ? "Which queries belong together (one article could answer the whole group)? Claude suggested the groups; your confirmed answers are the sample the clustering model and the token-set rule are scored on."
            : "Queries where the intent classifier disagrees with Claude Haiku. Pick the right intent; the classifier is used only after 50 checks, and your answer becomes training data."
        }
      />
      <nav className="mb-4 flex gap-4 text-sm" aria-label="Labelling tasks">
        <Link href="/admin/seo/models/labels?task=cluster" aria-current={task === "cluster" ? "page" : undefined} className={task === "cluster" ? "font-semibold text-fg" : "text-fg-muted underline"}>Query groupings</Link>
        <Link href="/admin/seo/models/labels?task=intent_check" aria-current={task === "intent_check" ? "page" : undefined} className={task === "intent_check" ? "font-semibold text-fg" : "text-fg-muted underline"}>Intent disagreements</Link>
        <Link href="/admin/seo/models" className="ml-auto text-fg-muted underline">ML models</Link>
      </nav>
      <Card>
        <p className="mb-2 text-sm text-fg-muted">
          {total ? `${counts.pending ?? 0} waiting · ${(counts.confirmed ?? 0) + (counts.changed ?? 0)} labelled · ${counts.skipped ?? 0} skipped` : task === "cluster" ? "No sample yet: on ML models, “Ask Claude for suggestions” creates it." : "No disagreements yet: they appear after the classifier's first training run."}
        </p>
        <LabelTasks task={task} rows={rows} groups={groups} />
      </Card>
    </>
  );
}
