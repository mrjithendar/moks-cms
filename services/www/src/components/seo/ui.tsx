import Link from "next/link";
import type { ReactNode } from "react";
import { Card } from "@/components/admin/ui";
import { LocalTime } from "@/components/LocalTime";
import { buttonClass } from "@/components/ui/form";
import type { Filters, Kpi, SourceStatus } from "@/lib/seo-intel/queries";

export const fmtInt = (v: number | null) => (v === null ? "—" : Intl.NumberFormat("en").format(Math.round(v)));
export const fmtPct = (v: number | null, digits = 1) => (v === null ? "—" : `${(v * 100).toFixed(digits)}%`);
export const fmtPos = (v: number | null) => (v === null ? "—" : v.toFixed(1));
/** A timestamp in the viewer's local time zone (LocalTime); "never" when empty. Use in JSX, not inside template strings. */
export const fmtWhen = (iso: string | null): ReactNode => (iso ? <LocalTime iso={iso} /> : "never");

export { SEO_SECTIONS } from "./sections";

function Change({ kpi }: { kpi: Kpi }) {
  if (kpi.change === null) return <span className="text-fg-subtle">no comparison</span>;
  const good = kpi.lowerIsBetter ? kpi.change < 0 : kpi.change > 0;
  const arrow = kpi.change > 0 ? "▲" : kpi.change < 0 ? "▼" : "■";
  return (
    <span className={kpi.change === 0 ? "text-fg-subtle" : good ? "text-emerald-700 dark:text-emerald-300" : "text-red-700 dark:text-red-300"}>
      <span aria-hidden="true">{arrow} </span>
      {(Math.abs(kpi.change) * 100).toFixed(1)}%<span className="sr-only">{kpi.change > 0 ? " increase" : " decrease"}</span> vs previous period
    </span>
  );
}

export function KpiCard({ kpi }: { kpi: Kpi }) {
  const value = kpi.format === "pct" ? fmtPct(kpi.value) : kpi.format === "pos" ? fmtPos(kpi.value) : fmtInt(kpi.value);
  return (
    <Card className="!p-4">
      <p className="text-sm text-fg-subtle">{kpi.label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight text-fg tabular-nums">{value}</p>
      <p className="mt-1 text-xs"><Change kpi={kpi} /></p>
      <dl className="mt-2 space-y-0.5 text-xs text-fg-subtle">
        <div><dt className="inline">Source: </dt><dd className="inline">{kpi.source}</dd></div>
        <div><dt className="inline">Period: </dt><dd className="inline">{kpi.period}</dd></div>
        {kpi.period !== "current" && <div><dt className="inline">Last sync: </dt><dd className="inline">{fmtWhen(kpi.lastSync)}</dd></div>}
        {kpi.note && <div className="text-amber-800 dark:text-amber-300">{kpi.note}</div>}
      </dl>
    </Card>
  );
}

const stateTone: Record<SourceStatus["state"], string> = {
  ok: "",
  disconnected: "border-line bg-surface-muted text-fg",
  never_synced: "border-line bg-surface-muted text-fg",
  stale: "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200",
  error: "border-red-200 bg-red-50 text-red-900 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200",
};

/** Disconnected / never synced / stale / error banner for a data source (nothing when the source is fine). */
export function SourceBanner({ status }: { status: SourceStatus }) {
  if (status.state === "ok") return null;
  return (
    <div role="status" className={`mb-4 rounded-lg border px-4 py-3 text-sm ${stateTone[status.state]}`}>
      <p className="font-medium">
        {status.state === "disconnected" ? "Disconnected" : status.state === "never_synced" ? "No data yet" : status.state === "stale" ? "Stale data" : "Sync error"}
      </p>
      <p className="mt-0.5">{status.message}</p>
      {status.lastError && status.state === "error" && <p className="mt-1 text-xs [overflow-wrap:anywhere]">Last error: {status.lastError}</p>}
      <p className="mt-2 flex flex-wrap gap-3 text-xs">
        <Link className="underline" href="/admin/seo/integrations">Integrations</Link>
        <Link className="underline" href="/admin/seo/sync">Sync history</Link>
      </p>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-sm text-fg-subtle">{children}</p>;
}

export function Section({ title, description, children, id }: { title: string; description?: ReactNode; children: ReactNode; id?: string }) {
  const hid = `${id ?? title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-h`;
  return (
    <section aria-labelledby={hid} className="mb-8">
      <h2 id={hid} className="text-lg font-semibold text-fg">{title}</h2>
      {description && <p className="mt-1 text-sm text-fg-muted">{description}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** One row of filters above the views: GET form, so every view is a shareable URL and works without JS. */
export function FilterBar({ f, show = ["range", "page", "category", "device", "country", "searchType"], categories = [], countries = [] }: { f: Filters; show?: string[]; categories?: { slug: string; label: string }[]; countries?: string[] }) {
  const input = "min-h-9 rounded-md border border-line-strong bg-surface px-2 text-sm text-fg";
  return (
    <form method="get" className="mb-6 flex flex-wrap items-end gap-3 rounded-xl border border-line bg-surface p-3" aria-label="Filters">
      {show.includes("range") && (
        <label className="grid gap-1 text-xs text-fg-subtle">Period
          <select name="range" defaultValue={f.range} className={input}>
            <option value="7">Last 7 days</option>
            <option value="28">Last 28 days</option>
            <option value="90">Last 90 days</option>
            <option value="custom">Custom</option>
          </select>
        </label>
      )}
      {show.includes("range") && (
        <>
          <label className="grid gap-1 text-xs text-fg-subtle">From<input type="date" name="start" defaultValue={f.start ?? ""} className={input} /></label>
          <label className="grid gap-1 text-xs text-fg-subtle">To<input type="date" name="end" defaultValue={f.end ?? ""} className={input} /></label>
        </>
      )}
      {show.includes("page") && <label className="grid gap-1 text-xs text-fg-subtle">Page contains<input name="page" defaultValue={f.page ?? ""} className={input} placeholder="/blog/" /></label>}
      {show.includes("query") && <label className="grid gap-1 text-xs text-fg-subtle">Query contains<input name="query" defaultValue={f.query ?? ""} className={input} /></label>}
      {show.includes("category") && (
        <label className="grid gap-1 text-xs text-fg-subtle">Category
          <select name="category" defaultValue={f.category ?? ""} className={input}>
            <option value="">All</option>
            {categories.map((c) => <option key={c.slug} value={c.slug}>{c.label}</option>)}
          </select>
        </label>
      )}
      {show.includes("device") && (
        <label className="grid gap-1 text-xs text-fg-subtle">Device
          <select name="device" defaultValue={f.device ?? ""} className={input}>
            <option value="">All</option><option value="desktop">Desktop</option><option value="mobile">Mobile</option><option value="tablet">Tablet</option>
          </select>
        </label>
      )}
      {show.includes("country") && (
        <label className="grid gap-1 text-xs text-fg-subtle">Country
          <select name="country" defaultValue={f.country ?? ""} className={input}>
            <option value="">All</option>
            {countries.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
      )}
      {show.includes("searchType") && (
        <label className="grid gap-1 text-xs text-fg-subtle">Search type
          <select name="searchType" defaultValue={f.searchType} className={input}>
            {["web", "image", "video", "news", "discover", "googleNews"].map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
      )}
      <button type="submit" className={buttonClass("secondary", "sm")}>Apply</button>
    </form>
  );
}

export function Pager({ total, limit, offset, base }: { total: number; limit: number; offset: number; base: URLSearchParams }) {
  if (total <= limit) return null;
  const link = (o: number) => {
    const p = new URLSearchParams(base);
    p.set("offset", String(o));
    return `?${p}`;
  };
  return (
    <nav aria-label="Pagination" className="mt-3 flex items-center gap-3 text-sm">
      {offset > 0 ? <Link className="underline" href={link(Math.max(0, offset - limit))}>Previous</Link> : <span className="text-fg-subtle">Previous</span>}
      <span className="text-fg-subtle">{offset + 1}–{Math.min(total, offset + limit)} of {total}</span>
      {offset + limit < total ? <Link className="underline" href={link(offset + limit)}>Next</Link> : <span className="text-fg-subtle">Next</span>}
    </nav>
  );
}
