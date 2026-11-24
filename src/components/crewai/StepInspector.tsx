import Link from "next/link";
import type { RunStep } from "@/lib/crewai/runs";
import { RunStatusIcon } from "./RunStatusIcon";

type Meta = { type?: string; chars?: number; preview?: string; keys?: string[]; items?: number; values?: Record<string, Meta | string> };
type Attempt = { attempt: number; status: string; error?: string; seconds?: number };

function MetaView({ m }: { m: unknown }) {
  if (!m || typeof m !== "object") return <span className="text-fg-subtle">—</span>;
  const v = m as Meta;
  if (v.type === "text") return <span><span className="text-fg-subtle">{v.chars?.toLocaleString()} characters</span>{v.preview ? <q className="mt-1 block whitespace-pre-wrap break-words text-fg">{v.preview}</q> : null}</span>;
  if (v.type === "object") {
    return (
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
        {Object.entries(v.values ?? {}).map(([k, x]) => (
          <div key={k} className="contents">
            <dt className="font-mono text-fg-muted">{k}</dt>
            <dd className="min-w-0 break-words">{typeof x === "string" ? x : <MetaView m={x} />}</dd>
          </div>
        ))}
      </dl>
    );
  }
  if (v.type === "list") return <span className="text-fg-subtle">{v.items} items</span>;
  if (v.type === "none") return <span className="text-fg-subtle">nothing</span>;
  return <span>{v.preview ?? v.type}</span>;
}

/**
 * Each step's recorded detail (structured, redacted by the agent before it was stored): the attempts and why each
 * failed, the condition and whether it held, the crew and version or the child run, tokens and cost, and short previews
 * of what went in and came out. Steps without detail (flows defined in code record only time and status) are left out.
 */
export function StepInspector({ steps }: { steps: RunStep[] }) {
  const shown = steps.filter((s) => Object.keys(s.detail).some((k) => k !== "seconds"));
  if (shown.length === 0) return null;
  return (
    <section aria-labelledby="inspect-h" className="space-y-3">
      <h2 id="inspect-h" className="text-base font-semibold text-fg">Steps in detail</h2>
      <ol className="space-y-2">
        {shown.map((s) => {
          const d = s.detail as Record<string, unknown>;
          const attempts = (d.attempts as Attempt[] | undefined) ?? [];
          const when = d.when as { op: string; operand: string; held: boolean; value?: unknown } | undefined;
          const cond = d.condition as { op: string; operand: string; held: boolean; otherwise: string; value?: unknown } | undefined;
          const skipped = d.outcome === "skipped";
          const failed = s.status === "failed";
          return (
            <li key={s.id}>
              <details open={failed} className={`rounded-lg border ${failed ? "border-red-300 dark:border-red-500/40" : "border-line"} bg-surface`}>
                <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-3 py-2 text-sm">
                  <RunStatusIcon status={skipped ? "cancelled" : s.status} />
                  <span className="font-medium text-fg">{String(d.label ?? d.id ?? s.step)}</span>
                  <span className="text-xs text-fg-subtle">{String(d.kind ?? "")}{skipped ? " · skipped" : ""}{attempts.length > 1 ? ` · ${attempts.length} attempts` : ""}{s.seconds != null ? ` · ${s.seconds.toFixed(1)} s` : ""}</span>
                  {d.failure ? <span className="w-full text-xs text-red-700 dark:text-red-300">{String(d.failure)}</span> : null}
                </summary>
                <div className="grid gap-3 border-t border-line px-3 py-3 text-xs md:grid-cols-2">
                  <dl className="space-y-1">
                    {d.crew ? <div><dt className="inline text-fg-muted">Crew </dt><dd className="inline"><Link className="text-accent-text hover:underline" href={`/admin/crewai/crews/${String(d.crew)}`}>{String(d.crew)}</Link>{d.crew_version ? ` v${String(d.crew_version)}` : ""}{d.crew_source ? <span className="text-fg-subtle"> ({String(d.crew_source)})</span> : null}</dd></div> : null}
                    {d.child_flow ? <div><dt className="inline text-fg-muted">Started </dt><dd className="inline">{String(d.child_flow)}{d.child_run_id ? <> · <Link className="text-accent-text hover:underline" href={`/admin/crewai/runs/${String(d.child_run_id)}`}>its run</Link></> : null}{d.child_status ? ` (${String(d.child_status)})` : ""}</dd></div> : null}
                    {d.flow_version ? <div><dt className="inline text-fg-muted">Flow version </dt><dd className="inline">v{String(d.flow_version)}</dd></div> : null}
                    {d.tokens != null ? <div><dt className="inline text-fg-muted">Tokens </dt><dd className="inline tabular-nums">{Number(d.tokens).toLocaleString()} · ${Number(d.cost_usd ?? 0).toFixed(4)}</dd></div> : null}
                    {when ? <div><dt className="inline text-fg-muted">Runs only if </dt><dd className="inline">{when.op} {when.operand} → <strong className={when.held ? "text-emerald-700 dark:text-emerald-300" : "text-amber-700 dark:text-amber-300"}>{when.held ? "held" : "did not hold"}</strong></dd></div> : null}
                    {cond ? <div><dt className="inline text-fg-muted">Condition </dt><dd className="inline">{cond.op} {cond.operand} → <strong>{cond.held ? "held" : `did not hold: ${cond.otherwise}`}</strong></dd></div> : null}
                    {attempts.length > 0 && (
                      <div>
                        <dt className="text-fg-muted">Attempts</dt>
                        <dd>
                          <ol className="mt-1 space-y-0.5">
                            {attempts.map((a) => <li key={a.attempt} className={a.status === "failed" ? "text-red-700 dark:text-red-300" : "text-fg"}>#{a.attempt} {a.status}{a.seconds != null ? ` in ${a.seconds} s` : ""}{a.error ? `: ${a.error}` : ""}</li>)}
                          </ol>
                        </dd>
                      </div>
                    )}
                  </dl>
                  <dl className="space-y-2">
                    {"input" in d && <div><dt className="mb-1 font-semibold text-fg-muted">In</dt><dd><MetaView m={d.input} /></dd></div>}
                    {"output" in d && <div><dt className="mb-1 font-semibold text-fg-muted">Out</dt><dd><MetaView m={d.output} /></dd></div>}
                  </dl>
                </div>
              </details>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
