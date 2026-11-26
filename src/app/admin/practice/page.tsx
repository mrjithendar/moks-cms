import Link from "next/link";
import { Flash, type FlashParams } from "@/components/admin/Flash";
import { AdminHeader, Card, Stat } from "@/components/admin/ui";
import { SettingsElsewhere } from "@/components/admin/SettingsParts";
import { adminOverview } from "@/lib/practice/admin";
import { executorEnv, getPracticeSettings } from "@/lib/practice/settings";
import { VERDICTS, type Verdict } from "@/lib/practice/types";
import { requireRole } from "@/lib/session";
import { settingsHref } from "@/lib/settings-areas";

export const metadata = { title: "Python practice" };

export default async function PracticeAdmin({ searchParams }: { searchParams: FlashParams }) {
  const user = await requireRole("admin", "author");
  const [o, s] = await Promise.all([adminOverview(), getPracticeSettings()]);
  const env = executorEnv();
  const sp = await searchParams;
  const isAdmin = user.role === "admin";
  return (
    <>
      <AdminHeader
        title="Python practice"
        description="Problems, roles, the code runner, the AI tutor and abuse signals for /python-practice."
        actions={
          <>
            <Link href="/admin/practice/problems" className="text-sm font-medium text-accent-text underline">
              Problems
            </Link>
            <Link href="/admin/practice/catalog" className="text-sm font-medium text-accent-text underline">
              Roles, topics &amp; daily
            </Link>
          </>
        }
      />
      <Flash ok={sp.ok} error={sp.error} />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Published problems" value={o.problems.published ?? 0} hint={`${o.problems.draft ?? 0} drafts · ${o.problems.archived ?? 0} archived`} />
        <Stat label="Learners (7 days)" value={o.active.learners} hint={`${o.active.sessions} active sessions`} />
        <Stat label="Pending runs" value={o.queue.pending} hint={o.queue.avgMs ? `avg ${Math.round(o.queue.avgMs)} ms to result (24 h)` : "no runs in 24 h"} />
        <Stat label="AI today" value={o.ai.requests} hint={`$${o.ai.costUsd.toFixed(2)} est. · ${o.ai.tokens} tokens`} />
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <h2 className="font-semibold text-fg">Code runner</h2>
          <dl className="mt-3 space-y-1 text-sm">
            <div>Execution switch: <strong>{s.execution.enabled ? "on" : "off"}</strong></div>
            <div>Executor URL and token: <strong>{env ? "configured" : "missing (PRACTICE_EXECUTOR_URL, PRACTICE_EXECUTOR_TOKEN)"}</strong></div>
            {o.executor.ok ? (
              <>
                <div>Executor: reachable · backend {o.executor.backend} · runtime class <code>{o.executor.runtime_class}</code></div>
                <div>Queue: {o.executor.queued} queued, {o.executor.running} running · dispatchers alive: {Object.keys(o.executor.dispatchers).length}</div>
                <div>Runtimes: {o.executor.runtimes.join(", ") || "none"}</div>
              </>
            ) : (
              <div>Executor: {o.executor.error}</div>
            )}
          </dl>
          <p className="mt-3 text-sm text-fg-muted">Turn execution on only after the gVisor sandbox is installed and verified (docs/PYTHON_PRACTICE_EXECUTOR.md).</p>
        </Card>
        <Card>
          <h2 className="font-semibold text-fg">Results in the last 24 hours</h2>
          {o.verdicts.length ? (
            <ul className="mt-3 space-y-1 text-sm">
              {o.verdicts.map((v) => (
                <li key={String(v.verdict)} className="flex justify-between">
                  <span>{VERDICTS[v.verdict as Verdict] ?? v.verdict}</span>
                  <span className="tabular-nums">{v.n}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-fg-muted">No runs.</p>
          )}
        </Card>
        <Card className="lg:col-span-2">
          <h2 className="font-semibold text-fg">Abuse signals (last hour)</h2>
          <p className="mt-1 text-sm text-fg-muted">Accounts with 10+ runs hitting time or memory limits, or 100+ runs. The executor also blocks repeat offenders for 15 minutes on its own.</p>
          {o.abuse.length ? (
            <div className="overflow-x-auto"><table className="mt-3 w-full text-sm">
              <thead className="text-left text-fg-subtle">
                <tr>
                  <th className="py-1">Account</th>
                  <th>Limit hits</th>
                  <th>Rate-limited</th>
                  <th>Infra errors</th>
                </tr>
              </thead>
              <tbody>
                {o.abuse.map((a) => (
                  <tr key={a.email}>
                    <td className="py-1">{a.email}</td>
                    <td>{a.timeouts}</td>
                    <td>{a.limited}</td>
                    <td>{a.infra}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          ) : (
            <p className="mt-3 text-sm text-fg-muted">Nothing unusual.</p>
          )}
        </Card>
      </div>
      {isAdmin && (
        <SettingsElsewhere href={settingsHref("practice")}>execution, quotas, the AI tutor, the leaderboard and retention are in Settings → Practice.</SettingsElsewhere>
      )}
    </>
  );
}
