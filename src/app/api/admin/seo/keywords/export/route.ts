import { keywordTable, parseKwParams } from "@/lib/seo-intel/keywords";
import { seoRoute } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

/** Spreadsheet-safe cell: formulas (= + - @) are prefixed with ' (CSV injection). */
const cell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : typeof v === "number" ? (Number.isFinite(v) ? String(Number(v.toFixed(6))) : "") : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** GET /api/admin/seo/keywords/export?…same filters as the page… — CSV of the current view (up to 5,000 rows). */
export const GET = seoRoute("keywords-export", { rate: { max: 20, windowSeconds: 600 } }, async (_req, ctx) => {
  const p = { ...parseKwParams(ctx.query), limit: 500, offset: 0 };
  const header = ["query", "best_page", "position", "position_change", "impressions", "clicks", "ctr", "expected_ctr_site_curve", "click_gap_estimate", "intent", "parent_topic", "brand", "tracked", "search_volume_dataforseo", "keyword_difficulty_dataforseo"];
  const lines = [header.join(",")];
  for (let page = 0; page < 10; page++) {
    const r = await keywordTable({ ...p, offset: page * 500 });
    for (const x of r.rows) lines.push([x.query, x.page, x.position, x.change, x.impressions, x.clicks, x.ctr, x.expectedCtr, x.gap, x.intent, x.parentTopic, x.brand, x.tracked, x.volume, x.difficulty].map(cell).join(","));
    if (r.rows.length < 500) break;
  }
  return new Response(`${lines.join("\n")}\n`, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="keywords-${p.view}-${p.days}d.csv"`, "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" } });
});
