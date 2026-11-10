import { sql } from "drizzle-orm";
import { notFound } from "next/navigation";
import { getDb } from "@/db";
import { rowsOf } from "@/db/rows";
import { AgentRunStatus } from "@/components/seo/AgentRunStatus";
import { DiffReview, type SubmissionRow } from "@/components/seo/DiffReview";
import { NewArticleReview, type NewArticleDoc } from "@/components/seo/NewArticleReview";
import { markdownToHtml } from "@/lib/mdx/html";
import { getDraft } from "@/lib/seo-intel/drafts";
import { UUID } from "@/lib/seo-intel/http";
import { listSubmissions } from "@/lib/seo-intel/submission";
import { siteOrigin } from "@/lib/seo-intel/urls";

export const metadata = { title: "Review draft" };

export default async function DraftPage({ params }: { params: Promise<{ draftId: string }> }) {
  const { draftId } = await params;
  if (!UUID.test(draftId)) notFound();
  const d = await getDraft(draftId);
  if (!d) notFound();
  const db = await getDb();
  const ids = d.recommendation_ids;
  const evidence: Record<string, { label: string; detail: string }> = {};
  if (ids.length) {
    const recs = rowsOf<{ id: string; category: string; problem: string }>(await db.execute(sql`select id, category, problem from seo_recommendations where id = any(${`{${ids.join(",")}}`}::uuid[])`));
    for (const r of recs) evidence[`rec:${r.id}`] = { label: `Recommendation (${r.category.replace(/_/g, " ")})`, detail: r.problem };
    const ev = rowsOf<{ id: string; metric: string; period: string; value: number | null; value_text: string | null; source: string }>(await db.execute(sql`select id, metric, period, value, value_text, source from seo_recommendation_evidence where recommendation_id = any(${`{${ids.join(",")}}`}::uuid[])`));
    for (const e of ev) evidence[`ev:${e.id}`] = { label: `${e.metric.replace(/_/g, " ")} (${e.period}, ${e.source.toUpperCase()})`, detail: e.value_text ?? (e.value === null ? "" : String(Number(e.value) < 1 && Number(e.value) > 0 ? `${(Number(e.value) * 100).toFixed(2)}%` : Number(e.value).toLocaleString("en"))) };
  }
  const submissions: SubmissionRow[] = await listSubmissions(db, { articleId: d.article_id, draftId: d.id });
  const iso = (v: unknown) => (v ? new Date(String(v)).toISOString() : null);
  // v3: the run summary the seo-agent keeps for this thread (thread id = draft id). Absent for legacy drafts.
  const [run] = d.thread_id ? rowsOf<{ status: string; outcome: string | null; current_node: string | null; error: string | null; cost_usd: number }>(await db.execute(sql`select status, outputs->>'outcome' as outcome, current_step as current_node, error, cost_usd from seo_flow_runs where draft_id = ${d.id} order by started_at desc limit 1`)) : [];
  const runStrip = run ? <AgentRunStatus threadId={d.id} initial={{ status: run.status, outcome: run.outcome, currentNode: run.current_node, error: run.error, costUsd: Number(run.cost_usd) }} /> : null;
  if (d.kind === "new_article") {
    const doc = (typeof d.document === "string" ? JSON.parse(d.document) : d.document) as NewArticleDoc | null;
    return (
      <>
        {runStrip}
        <NewArticleReview draft={{ id: d.id, status: d.status, flags: d.flags, failureReason: (d.failure_reason as string | null) ?? null }} doc={doc} html={doc?.body_mdx ? await markdownToHtml(doc.body_mdx.slice(0, 200_000)) : ""} editorUrl={`/admin/posts/${d.article_id}`} />
      </>
    );
  }
  return (
    <>
    {runStrip}
    <DiffReview
      draft={{ id: d.id, status: d.status, changes: d.changes, flags: d.flags, summary: (d.summary as string | null) ?? null, failureReason: (d.failure_reason as string | null) ?? null, verification: (d.verification as never) ?? null, scheduledFor: iso(d.scheduled_for), decidedBy: (d.decided_by as string | null) ?? null, decidedAt: iso(d.decided_at), substantive: (d.substantive as boolean | null) ?? null, categories: (d.categories as string[]) ?? [] }}
      article={{ id: d.article_id, title: d.article.title, path: d.article.path, collection: d.article.collection, liveUrl: `${siteOrigin().origin}${d.article.path}` }}
      base={d.base_snapshot}
      evidence={evidence}
      submissions={submissions}
    />
    </>
  );
}
