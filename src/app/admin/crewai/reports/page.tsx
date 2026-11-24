import Link from "next/link";
import { AdminHeader, Card, Table, td, th } from "@/components/admin/ui";
import { ReportStatus } from "@/components/crewai/reports/ReportClient";
import { CATEGORY_SHORT, duration, kb } from "@/components/crewai/reports/labels";
import { Empty, fmtWhen } from "@/components/seo/ui";
import { buttonClass } from "@/components/ui/form";
import { CATEGORIES } from "@/lib/reports/catalog";
import { PRESETS } from "@/lib/reports/ranges";
import { listReports } from "@/lib/reports/service";
import { REPORT_STATUSES } from "@/lib/reports/types";

export const metadata = { title: "Reports" };
export const dynamic = "force-dynamic";

const PAGE = 25;
const pick = (v: string | undefined, ok: readonly string[]) => (v && ok.includes(v) ? v : "");
const day = (v: string | undefined) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : "");

/** CrewAI console → Reports: every report of this site, searchable and filterable, with its status and files. */
export default async function ReportsLibrary({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const f = { q: (sp.q ?? "").trim().slice(0, 100), category: pick(sp.category, CATEGORIES.map((c) => c.key)), status: pick(sp.status, REPORT_STATUSES), type: pick(sp.type, [...Object.keys(PRESETS), "briefing"]), from: day(sp.from), to: day(sp.to) };
  const page = Math.max(1, Number(sp.page) || 1);
  const { items, total } = await listReports({ ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)), limit: PAGE, offset: (page - 1) * PAGE });
  const keep = (over: Record<string, string>) => `?${new URLSearchParams(Object.entries({ ...f, ...over }).filter(([, v]) => v) as [string, string][]).toString()}`;
  const filtered = Object.values(f).some(Boolean);
  const select = "min-h-9 rounded-md border border-line-strong bg-surface px-2 text-sm text-fg";
  return (
    <>
      <AdminHeader
        title="Reports"
        description="Reports on any dates for any part of the site: figures, charts, what is going wrong and why, what to fix, AI recommendations and costs. Each is stored in R2 as PDF, HTML, JSON and CSV, and can be emailed from here or from SEO-AI reports."
        actions={<Link className={buttonClass("primary", "sm")} href="/admin/crewai/reports/new">New report</Link>}
      />
      <Card className="mb-6 !p-4">
        <form method="get" className="flex flex-wrap items-end gap-3" aria-label="Filter reports">
          <label className="grid min-w-48 flex-1 gap-1 text-xs font-medium text-fg-muted">Search<input type="search" name="q" defaultValue={f.q} placeholder="Title" className={select} /></label>
          <label className="grid gap-1 text-xs font-medium text-fg-muted">Category<select name="category" defaultValue={f.category} className={select}><option value="">Any category</option>{CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select></label>
          <label className="grid gap-1 text-xs font-medium text-fg-muted">Status<select name="status" defaultValue={f.status} className={select}><option value="">Any status</option>{REPORT_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}</select></label>
          <label className="grid gap-1 text-xs font-medium text-fg-muted">Type<select name="type" defaultValue={f.type} className={select}><option value="">Any type</option>{Object.entries(PRESETS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}<option value="briefing">Weekly / monthly briefing</option></select></label>
          <label className="grid gap-1 text-xs font-medium text-fg-muted">Made from<input type="date" name="from" defaultValue={f.from} className={select} /></label>
          <label className="grid gap-1 text-xs font-medium text-fg-muted">Made until<input type="date" name="to" defaultValue={f.to} className={select} /></label>
          <button type="submit" className={buttonClass("primary", "sm")}>Apply</button>
          {filtered && <Link className={buttonClass("ghost", "sm")} href="/admin/crewai/reports">Clear</Link>}
        </form>
      </Card>
      {items.length ? (
        <>
          <Table head={<tr><th className={th}>Report</th><th className={th}>Status</th><th className={th}>Dates</th><th className={th}>Made</th><th className={th}>Time</th><th className={th}>Files</th></tr>}>
            {items.map((r) => (
              <tr key={r.id}>
                <td className={td}>
                  <Link className="font-medium text-fg underline-offset-2 hover:underline" href={r.kind === "briefing" ? `/admin/reports/${r.id}` : `/admin/crewai/reports/${r.id}`}>{r.title}</Link>
                  <span className="mt-1 flex flex-wrap gap-1">
                    {(r.kind === "briefing" ? ["seo"] : r.categories.length === CATEGORIES.length ? ["site-wide"] : r.categories).slice(0, 6).map((c) => <span key={c} className="rounded bg-surface-sunken px-1.5 py-0.5 text-xs text-fg-muted">{c === "site-wide" ? "Site-wide" : (CATEGORY_SHORT[c] ?? c)}</span>)}
                    {r.kind === "console" && r.categories.length > 6 && r.categories.length < CATEGORIES.length && <span className="text-xs text-fg-subtle">+{r.categories.length - 6}</span>}
                  </span>
                </td>
                <td className={td}><ReportStatus status={r.status} />{r.status === "running" && r.progress.percent ? <span className="ml-1 text-xs text-fg-subtle">{r.progress.percent}%</span> : null}</td>
                <td className={`${td} whitespace-nowrap`}>{r.start} – {r.end}<span className="block text-xs text-fg-subtle">{r.kind === "briefing" ? `${r.preset} briefing` : (PRESETS[r.preset as keyof typeof PRESETS] ?? r.preset)}</span></td>
                <td className={`${td} whitespace-nowrap`}>{fmtWhen(r.createdAt)}<span className="block text-xs text-fg-subtle">{r.createdBy ?? "schedule"}</span></td>
                <td className={`${td} whitespace-nowrap`}>{duration(r.durationMs)}{r.llmCostUsd > 0 && <span className="block text-xs text-fg-subtle">LLM ${r.llmCostUsd.toFixed(r.llmCostUsd < 0.01 ? 4 : 2)}</span>}</td>
                <td className={`${td} whitespace-nowrap`}>
                  {r.files.pdf ? <a className="underline" href={`/api/admin/crewai/reports/${r.id}/download?format=pdf`}>PDF</a> : <span className="text-fg-subtle">—</span>}
                  {r.bytes > 0 && <span className="block text-xs text-fg-subtle">{Object.keys(r.files).length} file(s) · {kb(r.bytes)}</span>}
                </td>
              </tr>
            ))}
          </Table>
          <nav aria-label="Pages" className="mt-4 flex items-center justify-between text-sm text-fg-muted">
            <span>{(page - 1) * PAGE + 1}–{(page - 1) * PAGE + items.length} of {total}</span>
            <span className="flex gap-3">
              {page > 1 && <Link className="link" href={keep({ page: String(page - 1) })}>← Newer</Link>}
              {page * PAGE < total && <Link className="link" href={keep({ page: String(page + 1) })}>Older →</Link>}
            </span>
          </nav>
        </>
      ) : (
        <Empty>{filtered ? "No report matches these filters." : "No report yet. Press New report to make the first one."}</Empty>
      )}
    </>
  );
}
