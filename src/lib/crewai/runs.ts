import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
import { getSeoSettings, type SeoSettings } from "../seo-intel/settings";
import { ACTIVE_STATUSES, BACKGROUND_FLOWS, RUN_STATUSES, TRIGGERS } from "./flows";

/**
 * The CrewAI console's reads (/admin/crewai): runs of the SEO agent's flows (seo_flow_runs, migration 0016) with the
 * run numbers, steps, log lines and model-call transcripts the agent records (migration 0036,
 * moks-seo-agent/app/run_history.py), and the cost per agent and model (seo_llm_usage, migration 0022). The web app
 * only reads these tables, apart from the retention job (purgeRunHistory); starting and cancelling runs goes through
 * the agent (lib/seo-agent/client.ts).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const pgText = (a: readonly string[]) => `{${a.map((x) => `"${x.replace(/(["\\])/g, "\\$1")}"`).join(",")}}`;
const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const obj = (v: unknown): Record<string, unknown> => {
  const x = typeof v === "string" ? (JSON.parse(v) as unknown) : v;
  return x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {};
};

export type RunRow = {
  runId: string;
  flow: string;
  number: number | null;
  targetId: string;
  draftId: string | null;
  status: string;
  currentStep: string | null;
  outcome: string | null;
  error: string | null;
  tokens: number;
  costUsd: number;
  triggeredBy: string;
  actor: string | null;
  correlationId: string | null;
  startedAt: string;
  finishedAt: string | null;
};

const RUN_COLS = sql`r.run_id, r.flow_name, r.run_number, r.target_id, r.draft_id, r.status, r.current_step, r.outputs->>'outcome' as outcome, r.error, r.tokens, r.cost_usd, r.triggered_by, r.actor, r.correlation_id, r.started_at, r.finished_at`;

function toRun(r: Record<string, unknown>): RunRow {
  return {
    runId: String(r.run_id),
    flow: String(r.flow_name),
    number: r.run_number == null ? null : Number(r.run_number),
    targetId: String(r.target_id ?? ""),
    draftId: r.draft_id ? String(r.draft_id) : null,
    status: String(r.status),
    currentStep: r.current_step ? String(r.current_step) : null,
    outcome: r.outcome ? String(r.outcome) : null,
    error: r.error ? String(r.error) : null,
    tokens: Number(r.tokens ?? 0),
    costUsd: Number(r.cost_usd ?? 0),
    triggeredBy: String(r.triggered_by),
    actor: r.actor ? String(r.actor) : null,
    correlationId: r.correlation_id ? String(r.correlation_id) : null,
    startedAt: iso(r.started_at)!,
    finishedAt: iso(r.finished_at),
  };
}

/** Run history tables (migration 0036) present? The console degrades to the run rows alone without them. */
export async function hasRunHistory(db?: Db): Promise<boolean> {
  const d = db ?? (await getDb());
  const [r] = rowsOf<{ n: number }>(await d.execute(sql`select count(*)::int as n from information_schema.tables where table_name in ('seo_flow_run_steps', 'seo_flow_run_logs', 'seo_flow_run_calls') and table_schema = any(current_schemas(false))`));
  return Number(r?.n ?? 0) === 3;
}

// --- Runs ---------------------------------------------------------------------------------------------------------------

/** `content`: one content flow's id (a `news_jobs` row): its runs and the image, training and other runs it made. */
export type RunFilter = { flow?: string | null; content?: string | null; status?: string | null; trigger?: string | null; q?: string | null; before?: string | null; limit?: number };

/** Newest first, `limit` per page; `before` is the last row's startedAt. `q`: "#12" (run number), a run id, or text
 * in the target, actor or error. */
export async function listRuns(f: RunFilter = {}, db?: Db): Promise<RunRow[]> {
  const d = db ?? (await getDb());
  const where: SQL[] = [sql`true`];
  if (f.flow && /^[a-z][a-z0-9_]{2,60}$/.test(f.flow)) where.push(sql`r.flow_name = ${f.flow}`);
  // A content flow's run has its flow run's id (moks-seo-agent app/flows/news.py open_run).
  if (f.content && UUID.test(f.content.toLowerCase())) where.push(sql`r.run_id in (select n.id from news_runs n where n.job_id = ${f.content.toLowerCase()}::uuid)`);
  if (f.status && (RUN_STATUSES as readonly string[]).includes(f.status)) where.push(sql`r.status = ${f.status}`);
  if (f.status === "active") where.push(sql`r.status = any(${pgText(ACTIVE_STATUSES)}::text[])`);
  if (f.trigger && (TRIGGERS as readonly string[]).includes(f.trigger)) where.push(sql`r.triggered_by = ${f.trigger}`);
  const q = f.q?.trim().slice(0, 100);
  if (q) {
    const num = /^#?(\d{1,9})$/.exec(q);
    if (num) where.push(sql`r.run_number = ${Number(num[1])}`);
    else if (UUID.test(q.toLowerCase())) where.push(sql`(r.run_id = ${q.toLowerCase()}::uuid or r.draft_id = ${q.toLowerCase()}::uuid or r.correlation_id = ${q.toLowerCase()})`);
    else {
      const like = `%${q.replace(/[%_\\]/g, "")}%`;
      where.push(sql`(r.target_id ilike ${like} or r.actor ilike ${like} or r.error ilike ${like} or r.run_id::text like ${like})`);
    }
  }
  if (f.before && !Number.isNaN(Date.parse(f.before))) where.push(sql`r.started_at < ${new Date(f.before).toISOString()}::timestamptz`);
  const limit = Math.max(1, Math.min(f.limit ?? 50, 200));
  const rows = rowsOf<Record<string, unknown>>(await d.execute(sql`select ${RUN_COLS} from seo_flow_runs r where ${sql.join(where, sql` and `)} order by r.started_at desc, r.run_id desc limit ${limit}`));
  return rows.map(toRun);
}

/** Flows that have runs, for the filter (and any the catalogue knows comes from lib/crewai/flows.ts). */
export async function flowsWithRuns(db?: Db): Promise<string[]> {
  const d = db ?? (await getDb());
  return rowsOf<{ flow_name: string }>(await d.execute(sql`select distinct flow_name from seo_flow_runs order by flow_name`)).map((r) => r.flow_name);
}

export type RunStep = { id: number; seq: number; step: string; status: string; startedAt: string; finishedAt: string | null; error: string | null; seconds: number | null };
export type UsageRow = { agent: string | null; model: string; calls: number; inputTokens: number; outputTokens: number; costUsd: number; latencyMs: number; failed: number };
export type RunDetail = RunRow & {
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  steps: RunStep[];
  usage: UsageRow[];
  parent: RunRow | null;
  children: RunRow[];
  previous: { runId: string; number: number | null; status: string } | null;
  next: { runId: string; number: number | null; status: string } | null;
  history: boolean;
  transcripts: number;
};

export async function runDetail(runId: string, db?: Db): Promise<RunDetail | null> {
  if (!UUID.test(runId)) return null;
  const d = db ?? (await getDb());
  const [r] = rowsOf<Record<string, unknown>>(await d.execute(sql`select ${RUN_COLS}, r.inputs, r.outputs from seo_flow_runs r where r.run_id = ${runId}::uuid`));
  if (!r) return null;
  const run = toRun(r);
  const history = await hasRunHistory(d);
  const [steps, usage, parent, children, around, calls] = await Promise.all([
    history ? rowsOf<Record<string, unknown>>(await d.execute(sql`select id, seq, step, status, started_at, finished_at, error, detail from seo_flow_run_steps where run_id = ${runId}::uuid order by seq`)) : [],
    rowsOf<Record<string, unknown>>(
      await d.execute(sql`select agent, model, count(*)::int as calls, coalesce(sum(input_tokens), 0)::int as input_tokens, coalesce(sum(output_tokens), 0)::int as output_tokens,
        coalesce(sum(cost_usd), 0)::float8 as cost_usd, coalesce(sum(latency_ms), 0)::int as latency_ms, count(*) filter (where outcome <> 'ok')::int as failed
        from seo_llm_usage where run_id = ${runId} group by agent, model order by sum(cost_usd) desc nulls last`),
    ),
    run.correlationId && run.correlationId !== runId && UUID.test(run.correlationId)
      ? rowsOf<Record<string, unknown>>(await d.execute(sql`select ${RUN_COLS} from seo_flow_runs r where r.run_id = ${run.correlationId}::uuid`))
      : [],
    rowsOf<Record<string, unknown>>(await d.execute(sql`select ${RUN_COLS} from seo_flow_runs r where r.correlation_id = ${runId} and r.run_id <> ${runId}::uuid order by r.started_at limit 100`)),
    run.number == null
      ? []
      : rowsOf<Record<string, unknown>>(
          await d.execute(sql`(select run_id, run_number, status, 'previous' as dir from seo_flow_runs where flow_name = ${run.flow} and run_number < ${run.number} order by run_number desc limit 1)
            union all (select run_id, run_number, status, 'next' as dir from seo_flow_runs where flow_name = ${run.flow} and run_number > ${run.number} order by run_number asc limit 1)`),
        ),
    history ? rowsOf<{ n: number }>(await d.execute(sql`select count(*)::int as n from seo_flow_run_calls where run_id = ${runId}::uuid`)) : [],
  ]);
  const nav = (dir: string) => {
    const x = around.find((a) => a.dir === dir);
    return x ? { runId: String(x.run_id), number: x.run_number == null ? null : Number(x.run_number), status: String(x.status) } : null;
  };
  return {
    ...run,
    inputs: obj(r.inputs),
    outputs: obj(r.outputs),
    steps: steps.map((s) => ({ id: Number(s.id), seq: Number(s.seq), step: String(s.step), status: String(s.status), startedAt: iso(s.started_at)!, finishedAt: iso(s.finished_at), error: s.error ? String(s.error) : null, seconds: obj(s.detail).seconds == null ? null : Number(obj(s.detail).seconds) })),
    usage: usage.map((u) => ({ agent: u.agent ? String(u.agent) : null, model: String(u.model), calls: Number(u.calls), inputTokens: Number(u.input_tokens), outputTokens: Number(u.output_tokens), costUsd: Number(u.cost_usd), latencyMs: Number(u.latency_ms), failed: Number(u.failed) })),
    parent: parent[0] ? toRun(parent[0]) : null,
    children: children.map(toRun),
    previous: nav("previous"),
    next: nav("next"),
    history,
    transcripts: Number(calls[0]?.n ?? 0),
  };
}

export async function runStatus(runId: string, db?: Db): Promise<string | null> {
  if (!UUID.test(runId)) return null;
  const d = db ?? (await getDb());
  const [r] = rowsOf<{ status: string }>(await d.execute(sql`select status from seo_flow_runs where run_id = ${runId}::uuid`));
  return r?.status ?? null;
}

// --- Log --------------------------------------------------------------------------------------------------------------

export type LogLine = { id: number; step: string | null; level: string; logger: string | null; event: string | null; message: string; context: Record<string, unknown>; at: string };
const LEVELS: Record<string, string[]> = { debug: ["debug", "info", "warning", "error"], info: ["info", "warning", "error"], warning: ["warning", "error"], error: ["error"] };

/** Lines after `afterId` in order, at most `limit` (500 a page; the raw download asks for more). */
export async function runLogs(runId: string, afterId = 0, opts: { level?: string | null; q?: string | null; limit?: number } = {}, db?: Db): Promise<LogLine[]> {
  if (!UUID.test(runId)) return [];
  const d = db ?? (await getDb());
  if (!(await hasRunHistory(d))) return [];
  const levels = LEVELS[opts.level ?? "debug"] ?? LEVELS.debug!;
  const q = opts.q?.trim().slice(0, 200);
  const limit = Math.max(1, Math.min(opts.limit ?? 500, 20_000));
  const rows = rowsOf<Record<string, unknown>>(
    await d.execute(
      sql`select id, step, level, logger, event, message, context, at from seo_flow_run_logs where run_id = ${runId}::uuid and id > ${afterId}
        and level = any(${pgText(levels)}::text[]) ${q ? sql`and message ilike ${`%${q.replace(/[%_\\]/g, "")}%`}` : sql``} order by id limit ${limit}`,
    ),
  );
  return rows.map((l) => ({ id: Number(l.id), step: l.step ? String(l.step) : null, level: String(l.level), logger: l.logger ? String(l.logger) : null, event: l.event ? String(l.event) : null, message: String(l.message), context: obj(l.context), at: iso(l.at)! }));
}

// --- Transcripts -------------------------------------------------------------------------------------------------------

export type Transcript = { id: number; runId: string; step: string | null; agent: string | null; purpose: string | null; model: string | null; outcome: string; inputTokens: number; outputTokens: number; costUsd: number; latencyMs: number | null; system: string | null; prompt: string | null; response: string | null; error: string | null; at: string };

export async function transcript(id: number, db?: Db): Promise<Transcript | null> {
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const d = db ?? (await getDb());
  if (!(await hasRunHistory(d))) return null;
  const [c] = rowsOf<Record<string, unknown>>(await d.execute(sql`select * from seo_flow_run_calls where id = ${id}`));
  if (!c) return null;
  const s = (v: unknown) => (v == null ? null : String(v));
  return { id: Number(c.id), runId: String(c.run_id), step: s(c.step), agent: s(c.agent), purpose: s(c.purpose), model: s(c.model), outcome: String(c.outcome), inputTokens: Number(c.input_tokens), outputTokens: Number(c.output_tokens), costUsd: Number(c.cost_usd), latencyMs: c.latency_ms == null ? null : Number(c.latency_ms), system: s(c.system), prompt: s(c.prompt), response: s(c.response), error: s(c.error), at: iso(c.at)! };
}

// --- Overview ----------------------------------------------------------------------------------------------------------

export type FlowHealth = { flow: string; last: RunRow; recent: string[]; runs7d: number; succeeded7d: number; failed7d: number; cost7d: number; medianMs: number | null };
export type Overview = {
  day: { runs: number; succeeded: number; failed: number; active: number };
  week: { runs: number; succeeded: number; failed: number; costUsd: number; tokens: number; p50Ms: number | null; p95Ms: number | null };
  /** Runs of BACKGROUND_FLOWS in the last 7 days: left out of `day`, `week` and `perDay`. */
  background7d: number;
  perDay: { day: string; succeeded: number; failed: number; other: number }[];
  active: RunRow[];
  failures: RunRow[];
  flows: FlowHealth[];
};

/**
 * The console's overview. The totals (`day`, `week`, `perDay`) count the flows' work and leave BACKGROUND_FLOWS out
 * (`background7d` says how many runs that was); every flow, those included, is in `flows`, `active` and `failures`.
 * A flow's health is over its finished runs of the last 7 days, the same window as its run count and cost.
 */
export async function overview(now: Date = new Date(), db?: Db): Promise<Overview> {
  const d = db ?? (await getDb());
  const nowIso = now.toISOString();
  const work = BACKGROUND_FLOWS.length ? sql`flow_name not in (${sql.join(BACKGROUND_FLOWS.map((f) => sql`${f}`), sql`, `)})` : sql`true`;
  const [[day], [week], perDay, active, failures, flows] = await Promise.all([
    d.execute(sql`select count(*)::int as runs, count(*) filter (where status = 'succeeded')::int as succeeded, count(*) filter (where status = 'failed')::int as failed,
        (select count(*)::int from seo_flow_runs where status in ('queued', 'running') and ${work}) as active
      from seo_flow_runs where started_at > ${nowIso}::timestamptz - interval '1 day' and ${work}`).then((x) => rowsOf<Record<string, unknown>>(x)),
    d.execute(sql`select count(*) filter (where ${work})::int as runs, count(*) filter (where status = 'succeeded' and ${work})::int as succeeded,
        count(*) filter (where status = 'failed' and ${work})::int as failed,
        coalesce(sum(cost_usd) filter (where ${work}), 0)::float8 as cost_usd, coalesce(sum(tokens) filter (where ${work}), 0)::bigint as tokens,
        percentile_cont(0.5) within group (order by extract(epoch from (finished_at - started_at)) * 1000) filter (where finished_at is not null and ${work}) as p50,
        percentile_cont(0.95) within group (order by extract(epoch from (finished_at - started_at)) * 1000) filter (where finished_at is not null and ${work}) as p95,
        count(*) filter (where not (${work}))::int as background
      from seo_flow_runs where started_at > ${nowIso}::timestamptz - interval '7 days'`).then((x) => rowsOf<Record<string, unknown>>(x)),
    d.execute(sql`select to_char(date_trunc('day', started_at at time zone 'UTC'), 'YYYY-MM-DD') as day, count(*) filter (where status = 'succeeded')::int as succeeded,
        count(*) filter (where status = 'failed')::int as failed, count(*) filter (where status not in ('succeeded', 'failed'))::int as other
      from seo_flow_runs where started_at > ${nowIso}::timestamptz - interval '14 days' and ${work} group by 1 order by 1`).then((x) => rowsOf<Record<string, unknown>>(x)),
    d.execute(sql`select ${RUN_COLS} from seo_flow_runs r where r.status in ('queued', 'running') order by r.started_at desc limit 20`).then((x) => rowsOf<Record<string, unknown>>(x)),
    d.execute(sql`select ${RUN_COLS} from seo_flow_runs r where r.status = 'failed' and r.started_at > ${nowIso}::timestamptz - interval '7 days' order by r.started_at desc limit 6`).then((x) => rowsOf<Record<string, unknown>>(x)),
    d.execute(sql`with ranked as (select r.*, row_number() over (partition by flow_name order by started_at desc, run_id desc) as rn from seo_flow_runs r)
      select ${RUN_COLS},
        (select array_agg(x.status order by x.rn) from ranked x where x.flow_name = r.flow_name and x.rn <= 10) as recent,
        (select count(*)::int from seo_flow_runs y where y.flow_name = r.flow_name and y.started_at > ${nowIso}::timestamptz - interval '7 days') as runs_7d,
        (select count(*)::int from seo_flow_runs y where y.flow_name = r.flow_name and y.status = 'succeeded' and y.started_at > ${nowIso}::timestamptz - interval '7 days') as succeeded_7d,
        (select count(*)::int from seo_flow_runs y where y.flow_name = r.flow_name and y.status = 'failed' and y.started_at > ${nowIso}::timestamptz - interval '7 days') as failed_7d,
        (select coalesce(sum(cost_usd), 0)::float8 from seo_flow_runs y where y.flow_name = r.flow_name and y.started_at > ${nowIso}::timestamptz - interval '7 days') as cost_7d,
        (select percentile_cont(0.5) within group (order by extract(epoch from (x.finished_at - x.started_at)) * 1000) from ranked x where x.flow_name = r.flow_name and x.rn <= 10 and x.status = 'succeeded') as median_ms
      from ranked r where r.rn = 1 order by r.started_at desc`).then((x) => rowsOf<Record<string, unknown>>(x)),
  ]);
  const n = (v: unknown) => (v == null ? null : Number(v));
  return {
    day: { runs: Number(day?.runs ?? 0), succeeded: Number(day?.succeeded ?? 0), failed: Number(day?.failed ?? 0), active: Number(day?.active ?? 0) },
    week: { runs: Number(week?.runs ?? 0), succeeded: Number(week?.succeeded ?? 0), failed: Number(week?.failed ?? 0), costUsd: Number(week?.cost_usd ?? 0), tokens: Number(week?.tokens ?? 0), p50Ms: n(week?.p50), p95Ms: n(week?.p95) },
    background7d: Number(week?.background ?? 0),
    perDay: perDay.map((p) => ({ day: String(p.day), succeeded: Number(p.succeeded), failed: Number(p.failed), other: Number(p.other) })),
    active: active.map(toRun),
    failures: failures.map(toRun),
    flows: flows.map((f) => ({
      flow: String(f.flow_name),
      last: toRun(f),
      recent: Array.isArray(f.recent) ? (f.recent as unknown[]).map(String) : typeof f.recent === "string" ? String(f.recent).replace(/^\{|\}$/g, "").split(",").filter(Boolean) : [],
      runs7d: Number(f.runs_7d ?? 0),
      succeeded7d: Number(f.succeeded_7d ?? 0),
      failed7d: Number(f.failed_7d ?? 0),
      cost7d: Number(f.cost_7d ?? 0),
      medianMs: n(f.median_ms),
    })),
  };
}

// --- Settings and retention ----------------------------------------------------------------------------------------------

/** GET /internal/seo-agent/run-history/settings: what the agent needs (moks-seo-agent/app/run_history.py). */
export async function runHistoryCallbackSettings(): Promise<{ transcripts: boolean }> {
  const s = await getSeoSettings();
  return { transcripts: s.runHistory.transcripts };
}

/** Daily retention job (seo-intel/jobs.ts runRetention): old log lines and transcripts; runs and steps stay. */
export async function purgeRunHistory(db: Db, s: SeoSettings["runHistory"], now: Date = new Date()): Promise<{ logs: number; calls: number }> {
  if (!(await hasRunHistory(db))) return { logs: 0, calls: 0 };
  const day = 86_400_000;
  const logsBefore = new Date(now.getTime() - s.logRetentionDays * day).toISOString();
  const callsBefore = new Date(now.getTime() - s.transcriptRetentionDays * day).toISOString();
  const [l] = rowsOf<{ n: number }>(await db.execute(sql`with d as (delete from seo_flow_run_logs where at < ${logsBefore}::timestamptz returning 1) select count(*)::int as n from d`));
  const [c] = rowsOf<{ n: number }>(await db.execute(sql`with d as (delete from seo_flow_run_calls where at < ${callsBefore}::timestamptz returning 1) select count(*)::int as n from d`));
  return { logs: Number(l?.n ?? 0), calls: Number(c?.n ?? 0) };
}
