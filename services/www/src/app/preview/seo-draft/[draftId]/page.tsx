import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { Collection } from "@/config/taxonomy";
import { getAuthor, getPublishedArticle } from "@/lib/content";
import { toIsoOffset } from "@/lib/dates-iso";
import { ArticleView } from "@/lib/pages/article";
import { applyChanges, isSubstantive } from "@/lib/seo-intel/changeset";
import { getDraft } from "@/lib/seo-intel/drafts";
import { UUID } from "@/lib/seo-intel/http";
import { requireRole } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Draft preview", robots: { index: false, follow: false } };

/**
 * The page exactly as it will be published: the live article rendered by the public ArticleView with the
 * accepted changes applied (pending changes are included only with ?include=pending), in the public layout.
 * Admin-only; noindex.
 */
export default async function DraftPreview({ params, searchParams }: { params: Promise<{ draftId: string }>; searchParams: Promise<{ include?: string }> }) {
  await requireRole("admin");
  const { draftId } = await params;
  const include = (await searchParams).include === "pending";
  if (!UUID.test(draftId)) notFound();
  const d = await getDraft(draftId);
  if (!d) notFound();
  const live = await getPublishedArticle(d.article.collection as Collection, d.base_snapshot.slug, { preview: false });
  if (!live) notFound();
  const author = await getAuthor(live.frontmatter.author);
  if (!author) notFound();
  const chosen = d.changes.filter((c) => c.decision === "accepted" || (include && c.decision === "pending"));
  const applied = applyChanges(d.base_snapshot, chosen);
  const fm = { ...live.frontmatter, seoTitle: applied.fields.seoTitle ?? undefined, seoDescription: applied.fields.seoDescription ?? undefined, ...(isSubstantive(chosen) ? { updatedAt: toIsoOffset(new Date()) } : {}) };
  const notice = (
    <div className="sticky top-16 z-30 border-b border-fuchsia-300 bg-fuchsia-50 px-5 py-3 text-sm text-fuchsia-950 dark:border-fuchsia-500/30 dark:bg-fuchsia-950 dark:text-fuchsia-100">
      <div className="mx-auto max-w-6xl">
        <strong>Draft preview.</strong> {chosen.length} {include ? "accepted + undecided" : "accepted"} change{chosen.length === 1 ? "" : "s"} applied; nothing is published by viewing this. Search title: “{applied.fields.seoTitle ?? live.frontmatter.title}”.{" "}
        <a className="underline" href={include ? "?" : "?include=pending"}>{include ? "Show accepted only" : "Include undecided changes"}</a>
      </div>
    </div>
  );
  return <ArticleView article={{ ...live, body: applied.body, frontmatter: fm, preview: true }} author={author} collection={d.article.collection as Collection} notice={notice} />;
}
