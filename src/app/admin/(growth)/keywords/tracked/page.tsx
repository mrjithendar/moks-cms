import { sql } from "drizzle-orm";
import Link from "next/link";
import { getDb } from "@/db";
import { rowsOf } from "@/db/rows";
import { AdminHeader, Card } from "@/components/admin/ui";
import { ApiButton } from "@/components/seo/ApiButton";
import { Badge } from "@/components/seo/badges";
import { TrendLine } from "@/components/seo/Charts";
import { TrackKeywordForm } from "@/components/seo/TrackKeywordForm";
import { Empty } from "@/components/seo/ui";
import { dataForSeoStatus, serpHistory } from "@/lib/seo-intel/dataforseo";
import { addDays } from "@/lib/seo-intel/sqlutil";
import { trackedKeywords } from "@/lib/seo-intel/keywords";
import { getSeoSettings } from "@/lib/seo-intel/settings";
import { siteOrigin } from "@/lib/seo-intel/urls";

export const metadata = { title: "Tracked keywords" };

/**
 * Watchlist: 90-day Search Console position history per tracked query and the last movement alert, plus (with
 * DataForSEO) the live Google position, whether the results page shows an AI Overview, the top competitors and the
 * query's volume and difficulty.
 */
export default async function TrackedPage() {
  const [t, s] = await Promise.all([trackedKeywords(), getSeoSettings()]);
  const queries = t.rows.map((r) => r.query);
  const db = await getDb();
  const [serp, dfs, metrics] = await Promise.all([
    serpHistory(queries),
    dataForSeoStatus(s),
    queries.length
      ? rowsOf<{ query: string; search_volume: number | null; keyword_difficulty: number | null }>(await db.execute(sql`select query, search_volume, keyword_difficulty from seo_keyword_metrics where query = any(${`{${queries.map((q) => `"${q.replace(/["\\]/g, "\\$&")}"`).join(",")}}`}::text[])`))
      : [],
  ]);
  const metric = new Map(metrics.map((m) => [m.query, m]));
  const host = siteOrigin().hostname.replace(/^www\./, "");
  const live = dfs.enabled && dfs.credentials && s.dataforseo.rankTracking.enabled;
  return (
    <>
      <AdminHeader
        title="Tracked keywords"
        description={`Search Console position (impression-weighted, daily) and, with DataForSEO, the live Google position in the configured market (weekly). You get an alert when a query's 7-day Search Console average moves more than ${s.keywords.trackedAlertPositions} positions (Settings → Keywords; email only when a recipient is set).`}
        actions={
          <span className="flex flex-wrap gap-2">
            {live && <ApiButton url="/api/admin/seo/dataforseo/run" body={{ job: "serp_ranks" }} label="Check live ranks now" confirm={`Buy a live Google check for ${queries.length} keyword(s)? Spend so far this month: $${dfs.spentUsd.toFixed(2)} of $${dfs.budgetUsd}.`} />}
            <Link href="/admin/keywords" className="inline-flex min-h-9 items-center rounded-md border border-line-strong px-3 text-sm">All keywords</Link>
          </span>
        }
      />
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <TrackKeywordForm />
        {!live && <p className="text-xs text-fg-subtle">Live Google ranks are off: {!dfs.credentials ? "DataForSEO credentials are not set" : !dfs.enabled ? "DataForSEO is switched off in Settings → Data sources" : "rank tracking is switched off"}.</p>}
      </div>
      {t.rows.length ? (
        <ul className="grid gap-4 lg:grid-cols-2">
          {t.rows.map((r) => {
            const start = t.asOf ? addDays(t.asOf, -(r.history.length - 1)) : null;
            const last = [...r.history].reverse().find((v) => Number.isFinite(v));
            const alert = r.last_alert as { from: number; to: number } | null;
            const g = serp.get(r.query);
            const m = metric.get(r.query);
            return (
              <li key={r.query}><Card className="!p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-semibold text-fg">{r.query}</p>
                  <p className="text-sm tabular-nums text-fg-muted">
                    Search Console {last === undefined ? "—" : last.toFixed(1)}
                    {g?.latest && <> · Google <strong className="text-fg">{g.latest.position ?? `> ${s.dataforseo.rankTracking.depth}`}</strong></>}
                  </p>
                </div>
                <div className="mt-1 flex flex-wrap gap-1.5 text-xs">
                  {m?.search_volume != null && <Badge title="Monthly searches (DataForSEO)">{Intl.NumberFormat("en").format(m.search_volume)}/mo</Badge>}
                  {m?.keyword_difficulty != null && <Badge t={m.keyword_difficulty >= 70 ? "amber" : "gray"} title="Keyword difficulty 0–100 (DataForSEO)">KD {m.keyword_difficulty}</Badge>}
                  {g?.latest?.aiOverview && <Badge t="violet" title="The Google results page for this query shows an AI Overview">AI Overview</Badge>}
                  {g?.latest && <span className="text-fg-subtle">checked {g.latest.checkedOn}</span>}
                </div>
                {alert && r.last_alert_at && <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">Alert {r.last_alert_at.slice(0, 10)}: {alert.from.toFixed(1)} → {alert.to.toFixed(1)}</p>}
                <div className="mt-2"><TrendLine label={`Position for ${r.query} (lower is better)`} invert data={r.history.map((v, i) => ({ date: start ? addDays(start, i) : String(i), value: Number.isFinite(v) ? v : null }))} height={120} /></div>
                {g?.latest?.top.length ? (
                  <details className="mt-2 text-sm">
                    <summary className="cursor-pointer text-fg-muted">Top results on Google</summary>
                    <ol className="mt-1 space-y-0.5">
                      {g.latest.top.map((x) => <li key={`${x.position}-${x.domain}`} className={`tabular-nums ${x.domain === host || x.domain.endsWith(`.${host}`) ? "font-semibold text-fg" : "text-fg-muted"}`}>{x.position}. {x.domain}</li>)}
                    </ol>
                  </details>
                ) : null}
              </Card></li>
            );
          })}
        </ul>
      ) : <Empty>No tracked keywords yet. Track one above, or use “Track” on any row of Keyword opportunities.</Empty>}
    </>
  );
}
