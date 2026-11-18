import { sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { rowsOf } from "@/db/rows";
import { createDraftFromItem, createItem } from "@/lib/seo-intel/calendar";
import { requestDraft } from "@/lib/seo-agent/orchestrate";
import { json, parse, SeoApiError, seoRoute } from "@/lib/seo-intel/http";
import { getSeoSettings } from "@/lib/seo-intel/settings";

export const dynamic = "force-dynamic";

const body = z.object({
  action: z.enum(["draft_optimization", "draft_new_article", "track", "untrack", "ignore", "unignore"]),
  query: z.string().trim().min(1).max(200),
  /** draft_optimization: the article behind the best-ranking page, and the opportunity type. */
  articleId: z.string().uuid().optional(),
  kind: z.enum(["striking", "low_ctr", "rising", "new", "lost", "cannibalization", "gaps", "all"]).optional(),
  evidence: z.string().max(400).optional(),
});

/**
 * POST /api/admin/seo/keywords/actions — row actions on Keyword opportunities:
 * draft an optimization of the ranking article (Phase 1 draft; never edits), draft a new article (calendar item, plus a
 * CMS draft only when "new article" drafting is enabled), track / untrack, ignore / unignore.
 */
export const POST = seoRoute("keywords-action", { mutating: true, rate: { max: 60, windowSeconds: 600 } }, async (_req, ctx) => {
  const b = parse(body, ctx.body);
  const db = await getDb();
  if (b.action === "track") await db.execute(sql`insert into seo_tracked_keywords (query, added_by) values (${b.query}, ${ctx.actor.label}) on conflict (query) do nothing`);
  else if (b.action === "untrack") await db.execute(sql`delete from seo_tracked_keywords where query = ${b.query}`);
  else if (b.action === "ignore") await db.execute(sql`insert into seo_keyword_ignores (query, added_by) values (${b.query}, ${ctx.actor.label}) on conflict (query) do nothing`);
  else if (b.action === "unignore") await db.execute(sql`delete from seo_keyword_ignores where query = ${b.query}`);
  else if (b.action === "draft_optimization") {
    if (!b.articleId) throw new SeoApiError("No article ranks for this query in the CMS.", 400, "invalid");
    const category = b.kind === "low_ctr" ? "title_meta" : b.kind === "lost" ? "freshness" : "striking_expansion";
    const { queued } = await requestDraft(b.articleId, { extra: [{ id: `kw:${b.query}`.slice(0, 80), category, problem: `Search query “${b.query}”: ${b.evidence ?? "opportunity from Keyword opportunities"}`.slice(0, 500) }], trigger: "fix", actor: ctx.actor.label });
    await ctx.audit("keywords.draft_optimization", b.articleId, { query: b.query, category, queued });
    return json({ ok: true, queued }, 202);
  } else if (b.action === "draft_new_article") {
    const s = await getSeoSettings();
    const title = b.query.length >= 5 ? b.query.charAt(0).toUpperCase() + b.query.slice(1) : `Article: ${b.query}`;
    const [dup] = rowsOf<{ id: string }>(await db.execute(sql`select id from seo_editorial_calendar where lower(title) = lower(${title}) limit 1`));
    const itemId = dup?.id ?? (await createItem({ title, notes: `From Keyword opportunities (Search Console): ${b.evidence ?? b.query}`.slice(0, 2000) }));
    // The CMS draft is created only when "new article" drafting is enabled (off by default); it is a draft, never published.
    const draft = s.drafts.autoEligible.new_article && !dup ? await createDraftFromItem(itemId, ctx.actor) : null;
    await ctx.audit("keywords.draft_new_article", itemId, { query: b.query, draft: Boolean(draft) });
    return json({ ok: true, calendarItemId: itemId, draftPostId: draft?.postId ?? null });
  }
  await ctx.audit(`keywords.${b.action}`, undefined, { query: b.query });
  return json({ ok: true });
});
