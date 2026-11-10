import { getDb } from "@/db";
import { auditArticle } from "@/lib/seo-intel/audit-article";
import { loadAnalysisData } from "@/lib/seo-intel/data";
import { json, SeoApiError, seoRoute, UUID } from "@/lib/seo-intel/http";
import { issuesFor, METRICS, scoreBreakdown, type Metric } from "@/lib/seo-intel/issue-details";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/seo/content/{articleId}/details?metric=errors&run={contentHash}
 * The issues behind one number on Content optimization (lazy-loaded by its popover). Computed from the same audit as
 * the count. Cached privately per audit run: `run` is the audit's content hash, so a changed article gets a new URL.
 */
export const GET = seoRoute<{ id: string }>("content-details", { rate: { max: 300, windowSeconds: 60 } }, async (_req, ctx, { id }) => {
  if (!UUID.test(id)) throw new SeoApiError("Article not found.", 404, "not_found");
  const metric = ctx.query.get("metric") as Metric;
  if (!METRICS.includes(metric)) throw new SeoApiError("Unknown metric.", 400, "invalid");
  const d = await loadAnalysisData(await getDb());
  const a = d.articles.find((x) => x.id === id);
  if (!a) throw new SeoApiError("Article not found.", 404, "not_found");
  const audit = auditArticle(a, { knownPaths: d.knownPaths });
  const run = ctx.query.get("run");
  const items = metric === "score" ? [] : issuesFor(metric, audit, a.body);
  const body = { run: audit.contentHash, metric, total: items.length, items: items.slice(0, 200), ...(metric === "score" ? { score: scoreBreakdown(audit) } : {}) };
  return json(body, 200, run === audit.contentHash ? { "Cache-Control": "private, max-age=600" } : {});
});
