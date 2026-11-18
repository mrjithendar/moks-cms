import { getDb } from "@/db";
import { json, parse, SeoApiError, seoRoute } from "@/lib/seo-intel/http";
import { createKeyword, KeywordError, keywordInput, listKeywords } from "@/lib/seo-intel/link-keywords";

export const dynamic = "force-dynamic";

/** GET /api/admin/seo/link-keywords — the keyword → URL list. POST — add one { keyword, url, caseSensitive?, enabled? }. */
export const GET = seoRoute("link-keywords-list", {}, async () => json(await listKeywords(await getDb())));

export const POST = seoRoute("link-keywords-create", { mutating: true }, async (_req, ctx) => {
  const input = parse(keywordInput, ctx.body);
  try {
    const k = await createKeyword(await getDb(), input, ctx.actor.label);
    await ctx.audit("links.keyword.create", k.id, { keyword: k.keyword, url: k.url });
    return json(k, 201);
  } catch (e) {
    if (e instanceof KeywordError) throw new SeoApiError(e.message, e.status, "invalid");
    throw e;
  }
});
