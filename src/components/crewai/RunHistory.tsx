import Link from "next/link";
import { Card, Table, td, th } from "@/components/admin/ui";
import { Ago } from "@/components/crewai/Ago";
import { RunStatus, RunStatusIcon } from "@/components/crewai/RunStatusIcon";
import { TRIGGER_LABELS } from "@/lib/crewai/flows";
import { formatDuration, formatUsd, runDurationMs } from "@/lib/crewai/format";
import type { RunRow } from "@/lib/crewai/runs";

/** A crew's or flow's last runs (execution history), linking to each run's steps and log and to the full filtered list. */
export function RunHistory({ runs, allHref, labelOf }: { runs: RunRow[]; allHref: string; labelOf?: (flow: string) => string }) {
  return (
    <section aria-labelledby="history-h" className="mt-8">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 id="history-h" className="text-base font-semibold text-fg">Run history</h2>
        <Link href={allHref} className="text-sm text-fg-muted hover:underline">All runs</Link>
      </div>
      {runs.length === 0 ? (
        <Card><p className="text-sm text-fg-muted">No runs yet. Start one, or give it a schedule; every run&apos;s steps, retries, conditions and log appear here.</p></Card>
      ) : (
        <Table head={<tr><th className={th}>Run</th>{labelOf && <th className={th}>Flow</th>}<th className={th}>Status</th><th className={th}>Trigger</th><th className={th}>Started</th><th className={th}>Duration</th><th className={th}>Cost</th></tr>}>
          {runs.map((r) => (
            <tr key={r.runId}>
              <td className={td}><Link href={`/admin/crewai/runs/${r.runId}`} className="inline-flex items-center gap-1.5 font-medium text-fg hover:underline"><RunStatusIcon status={r.status} />#{r.number ?? "?"}</Link></td>
              {labelOf && <td className={`${td} text-xs`}>{labelOf(r.flow)}</td>}
              <td className={td}><RunStatus status={r.status} /></td>
              <td className={`${td} text-xs`}>{TRIGGER_LABELS[r.triggeredBy] ?? r.triggeredBy}{r.actor ? <span className="block text-fg-subtle">{r.actor}</span> : null}</td>
              <td className={`${td} text-xs`}><Ago iso={r.startedAt} /></td>
              <td className={`${td} tabular-nums`}>{formatDuration(runDurationMs(r.startedAt, r.finishedAt))}</td>
              <td className={`${td} tabular-nums`}>{formatUsd(r.costUsd)}</td>
            </tr>
          ))}
        </Table>
      )}
    </section>
  );
}
