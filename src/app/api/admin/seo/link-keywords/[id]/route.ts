import { getDb } from "@/db";
import { json, parse, SeoApiError, seoRoute, UUID } from "@/lib/seo-intel/http";
import { deleteKeyword, KeywordError, keywordPatch, updateKeyword } from "@/lib/seo-intel/link-keywords";

export const dynamic = "force-dynamic";

/** PATCH /api/admin/seo/link-keywords/{id} — edit or enable/disable a keyword link. DELETE — remove it. */
export const PATCH = seoRoute<{ id: string }>("link-keywords-update", { mutating: true }, async (_req, ctx, { id }) => {
  if (!UUID.test(id)) throw new SeoApiError("Keyword not found.", 404, "not_found");
  try {
    const k = await updateKeyword(await getDb(), id, parse(keywordPatch, ctx.body));
    await ctx.audit("links.keyword.update", id, { keyword: k.keyword, url: k.url, enabled: k.enabled });
    return json(k);
  } catch (e) {
    if (e instanceof KeywordError) throw new SeoApiError(e.message, e.status, e.status === 404 ? "not_found" : "invalid");
    throw e;
  }
});

export const DELETE = seoRoute<{ id: string }>("link-keywords-delete", { mutating: true }, async (_req, ctx, { id }) => {
  if (!UUID.test(id) || !(await deleteKeyword(await getDb(), id))) throw new SeoApiError("Keyword not found.", 404, "not_found");
  await ctx.audit("links.keyword.delete", id);
  return json({ ok: true });
});
