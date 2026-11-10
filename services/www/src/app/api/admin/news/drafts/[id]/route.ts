import { z } from "zod";
import { json, parse, SeoApiError, seoRoute, UUID } from "@/lib/seo-intel/http";
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { rowsOf } from "@/db/rows";
import { audit } from "@/lib/audit";
import { recordCategoryCorrection } from "@/lib/news/service";

export const dynamic = "force-dynamic";
const edit = z.object({
  title: z.string().trim().min(10).max(110).optional(),
  meta_description: z.string().trim().max(200).optional(),
  dek: z.string().max(320).optional(),
  body_mdx: z.string().max(60_000).optional(),
  categories: z.array(z.string().max(60)).min(1).max(3).optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(10).optional(),
  alt: z.string().trim().min(10).max(300).optional(),
});

/**
 * PATCH /api/admin/news/drafts/{id} — inline edits in review (title, meta, dek, body, categories, tags, cover alt).
 * Only while the draft waits for review (an approval covers the stored draft). Edits are tracked: the generated
 * version stays in news_articles.generated_doc, and publishing records the edit distance for the style review.
 */
export const PATCH = seoRoute<{ id: string }>("news-draft-edit", { mutating: true }, async (_req, ctx, p) => {
  if (!UUID.test(p.id)) throw new SeoApiError("Draft not found.", 404, "not_found");
  const b = parse(edit, ctx.body ?? {});
  const db = await getDb();
  const [d] = rowsOf<{ document: unknown; status: string }>(await db.execute(sql`select document, status from seo_drafts where id = ${p.id} and kind = 'new_article'`));
  if (!d) throw new SeoApiError("Draft not found.", 404, "not_found");
  if (d.status !== "ready_for_review") throw new SeoApiError(`This draft is ${d.status.replace(/_/g, " ")}; edits are only possible while it waits for review.`, 409, "conflict");
  const doc = (typeof d.document === "string" ? JSON.parse(d.document) : d.document ?? {}) as Record<string, unknown> & { news?: Record<string, unknown> & { image?: Record<string, unknown> | null; edits?: number } };
  if (!doc.news) throw new SeoApiError("Not a news draft.", 400, "invalid");
  const next: Record<string, unknown> & { news: NonNullable<typeof doc.news> } = { ...doc, news: { ...doc.news } };
  if (b.title !== undefined) next.title = b.title;
  if (b.meta_description !== undefined) next.meta_description = b.meta_description;
  if (b.body_mdx !== undefined) next.body_mdx = b.body_mdx;
  if (b.dek !== undefined) next.news.dek = b.dek;
  if (b.tags !== undefined) next.news.tags = b.tags;
  if (b.categories !== undefined) next.news.categories = b.categories;
  if (b.alt !== undefined && next.news.image) next.news.image = { ...next.news.image, alt: b.alt };
  next.news.edits = Number(doc.news.edits ?? 0) + 1;
  await db.execute(sql`update seo_drafts set document = ${JSON.stringify(next)}::jsonb, updated_at = now() where id = ${p.id} and status = 'ready_for_review'`);
  if (b.categories) await recordCategoryCorrection(ctx.actor, p.id, b.categories);
  await audit(ctx.actor, "news.draft.edit", p.id, { fields: Object.keys(b) });
  return json({ ok: true, edits: next.news.edits });
});
