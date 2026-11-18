import Link from "next/link";
import { AdminHeader, Card, StatusPill, Table, td, th } from "@/components/admin/ui";
import { CHECK_GROUPS, systemChecks, type Check } from "@/lib/health";
import { requireRole } from "@/lib/session";

export const metadata = { title: "System status" };
export const dynamic = "force-dynamic";

const ORDER: Record<Check["status"], number> = { down: 0, degraded: 1, "not configured": 2, ok: 3 };

/** Where a check is configured: its admin page in a new tab, or the deployment setting that holds it. */
function Configure({ c }: { c: Check }) {
  if (c.href)
    return (
      <a href={c.href} target="_blank" rel="noopener" className="link whitespace-nowrap" aria-label={`Configure ${c.name} (opens in a new tab)`}>
        Configure ↗
      </a>
    );
  if (c.env) return <span className="text-xs text-fg-subtle">Deployment: <code>{c.env}</code></span>;
  return <span className="text-xs text-fg-subtle">Nothing to configure</span>;
}

export default async function SystemPage() {
  await requireRole("admin");
  const { app, checks } = await systemChecks();
  const count = (s: Check["status"]) => checks.filter((c) => c.status === s).length;
  const problems = count("down") + count("degraded");
  return (
    <>
      <AdminHeader
        title="System status"
        description={problems ? `${problems} check(s) need attention. Each row links to the page where it is configured.` : "Live checks of every service the site depends on. Each row links to the page where it is configured."}
        actions={<Link href="/admin/system" prefetch={false} className="inline-flex items-center rounded-xl border border-line-strong px-4 py-2.5 text-sm font-semibold">Re-run checks</Link>}
      />
      <div className="mb-6 grid gap-3 sm:grid-cols-4">
        {(["down", "degraded", "not configured", "ok"] as const).map((s) => (
          <Card key={s} className="!p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-fg-subtle">{s === "ok" ? "Healthy" : s === "down" ? "Down" : s === "degraded" ? "Degraded" : "Not configured"}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-fg">{count(s)}</p>
          </Card>
        ))}
      </div>
      <Card className="mb-6">
        <dl className="grid gap-4 sm:grid-cols-5">
          {Object.entries(app).map(([k, v]) => (
            <div key={k}>
              <dt className="text-xs uppercase tracking-wider text-fg-subtle">{k}</dt>
              <dd className="mt-1 font-mono text-sm text-fg">{v}</dd>
            </div>
          ))}
        </dl>
      </Card>
      <div className="space-y-6">
        {CHECK_GROUPS.map((g) => {
          const rows = checks.filter((c) => c.group === g).sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.name.localeCompare(b.name));
          if (!rows.length) return null;
          return (
            <section key={g} aria-labelledby={`g-${g}`}>
              <h2 id={`g-${g}`} className="mb-2 font-semibold text-fg">{g}</h2>
              <Table head={<tr><th className={th}>Service</th><th className={th}>Status</th><th className={th}>Response</th><th className={th}>Details</th><th className={th}>Settings</th></tr>}>
                {rows.map((c) => (
                  <tr key={c.name}>
                    <td className={`${td} font-medium text-fg`}>{c.name}</td>
                    <td className={td}><StatusPill status={c.status} /></td>
                    <td className={`${td} font-mono text-xs`}>{c.ms === null ? "—" : `${c.ms} ms`}</td>
                    <td className={`${td} text-sm [overflow-wrap:anywhere]`}>{c.detail}</td>
                    <td className={td}><Configure c={c} /></td>
                  </tr>
                ))}
              </Table>
            </section>
          );
        })}
      </div>
    </>
  );
}
