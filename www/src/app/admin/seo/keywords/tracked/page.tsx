import Link from "next/link";
import { AdminHeader, Card } from "@/components/admin/ui";
import { TrendLine } from "@/components/seo/Charts";
import { Empty } from "@/components/seo/ui";
import { addDays } from "@/lib/seo-intel/sqlutil";
import { trackedKeywords } from "@/lib/seo-intel/keywords";
import { getSeoSettings } from "@/lib/seo-intel/settings";

export const metadata = { title: "Tracked keywords" };

/** Watchlist: 90-day position history per tracked query and the last movement alert. */
export default async function TrackedPage() {
  const [t, s] = await Promise.all([trackedKeywords(), getSeoSettings()]);
  return (
    <>
      <AdminHeader title="Tracked keywords" description={`Position history from Search Console (impression-weighted, daily). You get an alert when a query's 7-day average moves more than ${s.keywords.trackedAlertPositions} positions (Settings → Keywords; email only when a recipient is set).`} actions={<Link href="/admin/seo/keywords" className="inline-flex min-h-9 items-center rounded-md border border-line-strong px-3 text-sm">All keywords</Link>} />
      {t.rows.length ? (
        <ul className="grid gap-4 lg:grid-cols-2">
          {t.rows.map((r) => {
            const start = t.asOf ? addDays(t.asOf, -(r.history.length - 1)) : null;
            const last = [...r.history].reverse().find((v) => Number.isFinite(v));
            const alert = r.last_alert as { from: number; to: number } | null;
            return (
              <li key={r.query}><Card className="!p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2"><p className="font-semibold text-fg">{r.query}</p><p className="text-sm tabular-nums text-fg-muted">position {last === undefined ? "—" : last.toFixed(1)}</p></div>
                {alert && r.last_alert_at && <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">Alert {r.last_alert_at.slice(0, 10)}: {alert.from.toFixed(1)} → {alert.to.toFixed(1)}</p>}
                <div className="mt-2"><TrendLine label={`Position for ${r.query} (lower is better)`} invert data={r.history.map((v, i) => ({ date: start ? addDays(start, i) : String(i), value: Number.isFinite(v) ? v : null }))} height={120} /></div>
              </Card></li>
            );
          })}
        </ul>
      ) : <Empty>No tracked keywords yet. Use “Track” on any row of Keyword opportunities.</Empty>}
    </>
  );
}
