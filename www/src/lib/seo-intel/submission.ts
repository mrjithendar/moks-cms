import type { Db } from "@/db";

/** Phase 3 fills this in: IndexNow, Search Console sitemap resubmission and the delayed URL Inspection check. */
export type SubmitTarget = { draftId: string | null; articleId: string; path: string; reason: "publish" | "rollback" | "edit" };
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- stub until Phase 3
export async function submitAfterPublish(_db: Db, _t: SubmitTarget, _opts: { now?: Date } = {}): Promise<void> {}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- stub until Phase 3
export async function listSubmissions(_db: Db, _f: { articleId: string; draftId?: string }): Promise<import("@/components/seo/DiffReview").SubmissionRow[]> {
  return [];
}
