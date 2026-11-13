import { json, seoRoute } from "@/lib/seo-intel/http";
import { testReddit } from "@/lib/seo-intel/promotion/reddit";

export const dynamic = "force-dynamic";

/** POST /api/admin/seo/promotion/reddit/test — one real read-only request; "connected" only on a real success. */
export const POST = seoRoute("promotion-reddit-test", { mutating: true, rate: { max: 6, windowSeconds: 600 } }, async (_req, ctx) => {
  const r = await testReddit();
  await ctx.audit("promotion.reddit_test", undefined, { status: r.status });
  // A failed test is returned as an error so the button shows Reddit's reason (already free of secrets).
  if (!r.ok) return json({ error: r.message, code: r.status }, r.status === "not_configured" ? 409 : 502);
  return json(r);
});
