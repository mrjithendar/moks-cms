import Link from "next/link";
import { AdminHeader, Card, StatusPill, Table, td, th } from "@/components/admin/ui";
import { ApiButton } from "@/components/seo/ApiButton";
import { Empty, fmtWhen, Section } from "@/components/seo/ui";
import { latestScan } from "@/lib/seo-intel/technical";

export const metadata = { title: "Technical health" };

export default async function TechnicalPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const d = await latestScan({ severity: sp.severity, check: sp.check });
  const link = (k: string, v?: string) => { const p = new URLSearchParams(Object.entries(sp).filter(([, x]) => x) as [string, string][]); if (v) p.set(k, v); else p.delete(k); return `?${p}`; };
  return (
    <>
      <AdminHeader
        title="Technical health"
        description="Weekly crawl of the public site (this host only, robots.txt honoured, ≤ 1 request/second by default, private paths skipped): robots.txt, sitemaps, status codes, redirects, canonicals, titles, meta descriptions, headings, alt text, JSON-LD, Open Graph, viewport, indexability, broken links, orphans, title and description length, thin content, JavaScript-only text, slow responses, dead ends, click depth and AI-crawler access (robots.txt policy and a live request as each crawler). URL Inspection and PageSpeed are optional (Integrations)."
        actions={<ApiButton url="/api/admin/seo/technical/scan" label="Scan now" variant="primary" confirm="Queue a crawl of the public site now?" />}
      />
      {!d ? <Empty>No scan yet. &ldquo;Scan now&rdquo; queues one; the weekly schedule runs it automatically.</Empty> : (
        <>
          <Card>
            <p className="text-sm">Latest scan: <StatusPill status={d.scan.status === "succeeded" ? "ok" : d.scan.status === "running" ? "degraded" : "down"} /> started {fmtWhen(d.scan.startedAt)}, {d.scan.pagesCrawled} pages crawled.</p>
            <p className="mt-2 flex flex-wrap gap-3 text-sm">
              <Link className="underline" href={link("severity")}>all</Link>
              {["error", "warning", "info"].map((s) => <Link key={s} className={sp.severity === s ? "font-semibold" : "underline"} href={link("severity", s)}>{s}</Link>)}
            </p>
          </Card>
          <Section title="By check">
            <ul className="flex flex-wrap gap-2 text-sm">{d.byCheck.map((b) => <li key={`${b.check}-${b.severity}`}><Link className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1" href={link("check", b.check)}><StatusPill status={b.severity === "error" ? "critical" : b.severity === "warning" ? "warning" : "info"} />{b.check.replace(/_/g, " ")} · {b.count}</Link></li>)}</ul>
          </Section>
          <Section title={`${d.total} issues`}>
            {d.issues.length ? (
              <Table head={<tr><th className={th}>Severity</th><th className={th}>Check</th><th className={th}>URL</th><th className={th}>Finding</th></tr>}>
                {d.issues.map((i, n) => (
                  <tr key={n}>
                    <td className={td}><StatusPill status={i.severity === "error" ? "critical" : i.severity === "warning" ? "warning" : "info"} /></td>
                    <td className={td}>{i.check.replace(/_/g, " ")}</td>
                    <td className={`${td} max-w-xs [overflow-wrap:anywhere]`}>{i.url}</td>
                    <td className={`${td} [overflow-wrap:anywhere]`}>{i.message}</td>
                  </tr>
                ))}
              </Table>
            ) : <Empty>No issues for this filter.</Empty>}
          </Section>
        </>
      )}
    </>
  );
}
