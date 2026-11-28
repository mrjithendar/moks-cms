import "server-only";
import { sql, type SQL } from "drizzle-orm";
import type { Db } from "@/db";
import { rowsOf } from "@/db/rows";
import { BACKGROUND_FLOWS } from "../crewai/flows";
import { change, fmt, signedPct } from "./format";
import { bounds, eachDay, istToday } from "./ranges";
import type { Chart, Column, Finding, Format, Kpi, ReportRange, Severity, TableBlock } from "./types";

/**
 * One builder per report category (catalog.ts). Every figure is a query over the site's own tables for the report's
 * dates and the equal period before; nothing is estimated, and a figure that cannot be known is null ("–"), never 0.
 * Findings are rules over those figures, written by code: the AI analysis explains them, it never adds facts.
 * Costs are the ones the SEO agent recorded at call time from its price table (seo_llm_usage.cost_usd); a call with
 * tokens and no cost is counted as "cost unknown", not as free.
 */
export type Ctx = {
  db: Db;
  range: ReportRange;
  cur: { from: string; to: string };
  prev: { from: string; to: string };
  /** Flows the report is narrowed to (the crews chosen become the flows that run them); null = every flow. */
  flows: string[] | null;
  /** Prompt families (moks-seo-agent PROMPT_VERSION without its version) of the crews chosen; null = every crew. */
  families: string[] | null;
  /** Prompt family → crew label, from the agent's crew catalogue (when it answers). */
  crewOfFamily: Map<string, string>;
  id: (prefix: "M" | "C" | "T") => string;
  /** Record text from the system (an error, a log line) as untrusted evidence; returns its id (E…). */
  untrusted: (kind: "error" | "log", text: string) => string;
};
export type DraftFinding = Omit<Finding, "id" | "category">;
export type Part = { kpis: Kpi[]; charts: Chart[]; tables: TableBlock[]; findings: DraftFinding[]; rows: Record<string, number | null>; note?: string };
export type Builder = (ctx: Ctx) => Promise<Part>;

const q = async <T = Record<string, unknown>>(ctx: Ctx, query: SQL) => rowsOf<T>(await ctx.db.execute(query));
const num = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const int = (v: unknown) => num(v) ?? 0;
const arr = (xs: readonly string[]) => sql`${`{${xs.map((x) => `"${x.replace(/["\\]/g, "")}"`).join(",")}}`}::text[]`;
const empty = (): Part => ({ kpis: [], charts: [], tables: [], findings: [], rows: {} });

function kpi(ctx: Ctx, label: string, value: number | null, previous: number | null | undefined, format: Format, better: "up" | "down" | null = null, note?: string): Kpi {
  return { id: ctx.id("M"), label, value, format, previous: previous ?? null, change: change(value, previous ?? null), better, ...(note ? { note } : {}) };
}
function table(ctx: Ctx, title: string, columns: Column[], rows: Record<string, string | number | null>[], note?: string): TableBlock {
  return { id: ctx.id("T"), title, columns, rows, ...(note ? { note } : {}) };
}
/** One series per name, a point for every day of the range (0 where the query has no row). */
function daily(ctx: Ctx, title: string, rows: Record<string, unknown>[], series: { key: string; name: string }[], unit = "", type: "line" | "bar" = "line"): Chart {
  const by = new Map(rows.map((r) => [String(r.d).slice(0, 10), r]));
  const days = eachDay(ctx.range.start, ctx.range.end);
  return { id: ctx.id("C"), type, title, unit, series: series.map((s) => ({ name: s.name, points: days.map((d) => [d, num(by.get(d)?.[s.key]) ?? 0] as [string, number]) })) };
}
const bar = (ctx: Ctx, title: string, points: [string, number][], unit = ""): Chart => ({ id: ctx.id("C"), type: "bar", title, unit, series: [{ name: title, points: points.slice(0, 10) }] });
const ratio = (a: number | null, b: number | null) => (a === null || b === null || b === 0 ? null : a / b);
const istDay = (col: string) => sql.raw(`(${col} at time zone 'Asia/Kolkata')::date::text`);

// --- scope ---------------------------------------------------------------------------------------------------------

/** Flow runs in the report's scope: the flows chosen (or all), never the housekeeping tick unless chosen. */
function runScope(ctx: Ctx, alias = "r"): SQL {
  const col = sql.raw(`${alias}.flow_name`);
  if (ctx.flows) return sql`${col} = any(${arr(ctx.flows)})`;
  return sql`${col} <> all(${arr(BACKGROUND_FLOWS)})`;
}
/** LLM calls in scope: of the flows chosen (by run), and of the crews chosen (by prompt family). */
function usageScope(ctx: Ctx, alias = "u"): SQL {
  const parts: SQL[] = [sql`true`];
  if (ctx.flows) parts.push(sql`${sql.raw(alias)}.run_id in (select run_id::text from seo_flow_runs where flow_name = any(${arr(ctx.flows)}))`);
  if (ctx.families) parts.push(sql`regexp_replace(coalesce(${sql.raw(alias)}.prompt_version, ''), '(-v[0-9].*|\\+.*)$', '') = any(${arr(ctx.families)})`);
  return sql.join(parts, sql` and `);
}
const inRange = (col: string, b: { from: string; to: string }) => sql`${sql.raw(col)} >= ${b.from} and ${sql.raw(col)} < ${b.to}`;
export const family = (promptVersion: string | null | undefined) => String(promptVersion ?? "").replace(/(-v[0-9].*|\+.*)$/, "");

// --- CrewAI execution and performance ------------------------------------------------------------------------------

async function runTotals(ctx: Ctx, b: { from: string; to: string }) {
  const [r] = await q(ctx, sql`
    select count(*)::int as total, count(*) filter (where status = 'succeeded')::int as ok, count(*) filter (where status = 'failed')::int as failed,
      count(*) filter (where status = 'cancelled')::int as cancelled, count(*) filter (where status = 'paused_budget')::int as paused,
      percentile_cont(0.5) within group (order by extract(epoch from finished_at - started_at) * 1000) filter (where finished_at is not null) as p50,
      percentile_cont(0.95) within group (order by extract(epoch from finished_at - started_at) * 1000) filter (where finished_at is not null) as p95
    from seo_flow_runs r where ${inRange("r.started_at", b)} and ${runScope(ctx)}`);
  return { total: int(r?.total), ok: int(r?.ok), failed: int(r?.failed), cancelled: int(r?.cancelled), paused: int(r?.paused), p50: num(r?.p50), p95: num(r?.p95) };
}

export const crewai: Builder = async (ctx) => {
  const p = empty();
  const [cur, prev] = await Promise.all([runTotals(ctx, ctx.cur), runTotals(ctx, ctx.prev)]);
  p.rows.flow_runs = cur.total;
  const rate = ratio(cur.ok, cur.total - (cur.paused + cur.cancelled) || null);
  const prevRate = ratio(prev.ok, prev.total - (prev.paused + prev.cancelled) || null);
  p.kpis.push(
    kpi(ctx, "Flow runs", cur.total, prev.total, "int", null),
    kpi(ctx, "Succeeded", cur.ok, prev.ok, "int", "up"),
    kpi(ctx, "Failed", cur.failed, prev.failed, "int", "down"),
    kpi(ctx, "Success rate", rate, prevRate, "pct", "up", "succeeded ÷ runs that finished (cancelled and budget-paused runs left out)"),
    kpi(ctx, "Median run time", cur.p50, prev.p50, "ms", "down"),
    kpi(ctx, "95th percentile run time", cur.p95, prev.p95, "ms", "down"),
  );
  const perDay = await q(ctx, sql`select ${istDay("r.started_at")} as d, count(*) filter (where status = 'succeeded')::int as ok, count(*) filter (where status = 'failed')::int as failed from seo_flow_runs r where ${inRange("r.started_at", ctx.cur)} and ${runScope(ctx)} group by 1`);
  p.charts.push(daily(ctx, "Runs per day", perDay, [{ key: "ok", name: "succeeded" }, { key: "failed", name: "failed" }], "runs"));
  const flows = await q(ctx, sql`
    select r.flow_name as flow, count(*)::int as runs, count(*) filter (where status = 'succeeded')::int as ok, count(*) filter (where status = 'failed')::int as failed,
      percentile_cont(0.5) within group (order by extract(epoch from finished_at - started_at) * 1000) filter (where finished_at is not null) as p50,
      coalesce(sum(cost_usd), 0)::float8 as cost, coalesce(sum(tokens), 0)::int as tokens
    from seo_flow_runs r where ${inRange("r.started_at", ctx.cur)} and ${runScope(ctx)} group by 1 order by 2 desc limit 30`);
  const flowTable = table(ctx, "Runs by flow", [{ key: "flow", label: "Flow", width: 0.3 }, { key: "runs", label: "Runs", format: "int" }, { key: "ok", label: "Succeeded", format: "int" }, { key: "failed", label: "Failed", format: "int" }, { key: "rate", label: "Success rate", format: "pct" }, { key: "p50", label: "Median time", format: "ms" }, { key: "cost", label: "Cost", format: "usd" }], flows.map((f) => ({ flow: String(f.flow), runs: int(f.runs), ok: int(f.ok), failed: int(f.failed), rate: ratio(int(f.ok), int(f.runs)), p50: num(f.p50), cost: num(f.cost) })));
  p.tables.push(flowTable);
  const steps = await q(ctx, sql`
    select r.flow_name as flow, s.step, count(*)::int as n, avg(extract(epoch from s.finished_at - s.started_at) * 1000)::float8 as avg_ms, count(*) filter (where s.status = 'failed')::int as failed
    from seo_flow_run_steps s join seo_flow_runs r on r.run_id = s.run_id
    where ${inRange("r.started_at", ctx.cur)} and ${runScope(ctx)} and s.finished_at is not null group by 1, 2 order by 4 desc nulls last limit 12`).catch(() => null);
  if (steps === null) p.note = "Step durations are not available (run history tables missing).";
  else {
    p.rows.run_steps = steps.length;
    if (steps.length) p.tables.push(table(ctx, "Slowest steps (average)", [{ key: "flow", label: "Flow", width: 0.3 }, { key: "step", label: "Step", width: 0.25 }, { key: "n", label: "Runs", format: "int" }, { key: "avg_ms", label: "Average time", format: "ms" }, { key: "failed", label: "Failed", format: "int" }], steps.map((s) => ({ flow: String(s.flow), step: String(s.step), n: int(s.n), avg_ms: num(s.avg_ms), failed: int(s.failed) }))));
  }
  // Findings: each flow that failed often, with the error it failed with most; a fall in the success rate.
  for (const f of flows) {
    const runs = int(f.runs);
    const failed = int(f.failed);
    if (!failed || (failed < 3 && failed / runs < 0.2)) continue;
    const [top] = await q<{ error: string | null; n: number }>(ctx, sql`select left(coalesce(error, ''), 400) as error, count(*)::int as n from seo_flow_runs r where ${inRange("r.started_at", ctx.cur)} and flow_name = ${String(f.flow)} and status = 'failed' group by 1 order by 2 desc limit 1`);
    const ev = [flowTable.id];
    if (top?.error) ev.push(ctx.untrusted("error", `${String(f.flow)}: ${top.error}`));
    const sev: Severity = failed / runs >= 0.5 ? "high" : failed / runs >= 0.2 ? "medium" : "low";
    p.findings.push({ severity: sev, title: `${String(f.flow)} failed ${failed} of ${runs} runs`, detail: top?.error ? `${int(top.n)} of them failed with the same recorded error (${ev[1]}).` : "The runs record no error message.", impact: "The work this flow does was not done for those runs.", evidence: ev, confirmed: !!top?.error, owner: String(f.flow) });
  }
  if (rate !== null && prevRate !== null && prevRate - rate >= 0.05 && cur.total >= 10) {
    p.findings.push({ severity: "medium", title: "The flow success rate fell", detail: `From ${fmt(prevRate, "pct")} to ${fmt(rate, "pct")}.`, impact: "More runs need a retry or a person.", evidence: [p.kpis[3]!.id], confirmed: false });
  }
  const stuck = await q<{ flow: string; n: number }>(ctx, sql`select flow_name as flow, count(*)::int as n from seo_flow_runs r where status in ('queued', 'running') and started_at < now() - interval '2 hours' and ${runScope(ctx)} group by 1`);
  for (const s of stuck) p.findings.push({ severity: "high", title: `${s.flow}: ${int(s.n)} run(s) queued or running for more than 2 hours`, detail: "A run this old has almost certainly stopped without finishing (a restart or a lost worker); it also holds its flow's lock for its target.", impact: "New runs of this flow for the same target are refused until it is cancelled.", evidence: [flowTable.id], confirmed: true, owner: s.flow });
  return p;
};

// --- Workflow reliability and failures ------------------------------------------------------------------------------

export const reliability: Builder = async (ctx) => {
  const p = empty();
  const [cur, prev] = await Promise.all([runTotals(ctx, ctx.cur), runTotals(ctx, ctx.prev)]);
  p.rows.flow_runs = cur.total;
  const errors = await q(ctx, sql`
    select r.flow_name as flow, left(regexp_replace(coalesce(r.error, 'no error recorded'), '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', '<id>', 'g'), 300) as error, count(*)::int as n, max(r.started_at)::text as last
    from seo_flow_runs r where r.status = 'failed' and ${inRange("r.started_at", ctx.cur)} and ${runScope(ctx)} group by 1, 2 order by 3 desc limit 15`);
  const stuck = await q<{ n: number }>(ctx, sql`select count(*)::int as n from seo_flow_runs r where status in ('queued', 'running') and started_at < now() - interval '2 hours' and ${runScope(ctx)}`);
  const steps = await q(ctx, sql`
    select r.flow_name as flow, s.step, count(*)::int as n, left(max(coalesce(s.error, '')), 300) as error
    from seo_flow_run_steps s join seo_flow_runs r on r.run_id = s.run_id
    where s.status = 'failed' and ${inRange("r.started_at", ctx.cur)} and ${runScope(ctx)} group by 1, 2 order by 3 desc limit 12`).catch(() => []);
  const jobs = await q(ctx, sql`
    select kind, count(*)::int as total, count(*) filter (where status = 'failed')::int as failed, count(*) filter (where attempts > 1)::int as retried, left(max(last_error) filter (where status = 'failed'), 300) as error
    from job where ${inRange("created_at", ctx.cur)} group by 1 order by 3 desc, 2 desc`).catch(() => null);
  const syncs = await q(ctx, sql`
    select job_type as type, count(*)::int as total, count(*) filter (where status = 'failed')::int as failed, left(max(error) filter (where status = 'failed'), 300) as error
    from seo_sync_jobs where ${inRange("started_at", ctx.cur)} group by 1 order by 3 desc`).catch(() => null);
  const content = await q(ctx, sql`
    select count(*)::int as runs, count(*) filter (where status = 'failed')::int as failed,
      count(*) filter (where status = 'succeeded' and coalesce((counters->>'scored')::int, 0) > 0 and coalesce((counters->>'selected')::int, 0) = 0)::int as empty_runs,
      coalesce(sum((counters->>'scored')::int), 0)::int as scored
    from news_runs where kind = 'job' and not dry_run and ${inRange("started_at", ctx.cur)}`).catch(() => null);
  const failedJobs = jobs?.reduce((n, j) => n + int(j.failed), 0) ?? null;
  const failedSyncs = syncs?.reduce((n, s) => n + int(s.failed), 0) ?? null;
  p.rows.jobs = jobs?.length ?? null;
  p.rows.sync_jobs = syncs?.length ?? null;
  p.rows.news = content ? int(content[0]?.runs) : null;
  p.kpis.push(
    kpi(ctx, "Failed flow runs", cur.failed, prev.failed, "int", "down"),
    kpi(ctx, "Failure rate", ratio(cur.failed, cur.total), ratio(prev.failed, prev.total), "pct", "down"),
    kpi(ctx, "Runs stuck over 2 hours (now)", int(stuck[0]?.n), null, "int", "down"),
    kpi(ctx, "Failed background jobs", failedJobs, null, "int", "down"),
    kpi(ctx, "Failed data syncs", failedSyncs, null, "int", "down"),
  );
  if (content) p.kpis.push(kpi(ctx, "Content flow runs that selected nothing", int(content[0]?.empty_runs), null, "int", "down"));
  const errTable = table(ctx, "Flow failures by error", [{ key: "flow", label: "Flow", width: 0.22 }, { key: "error", label: "Error (as recorded)", width: 0.5 }, { key: "n", label: "Runs", format: "int" }, { key: "last", label: "Last" }], errors.map((e) => ({ flow: String(e.flow), error: String(e.error), n: int(e.n), last: String(e.last).slice(0, 16) })), "Error text is shown as the system recorded it, with ids removed.");
  if (errors.length) p.tables.push(errTable);
  if (steps.length) p.tables.push(table(ctx, "Failed steps", [{ key: "flow", label: "Flow", width: 0.22 }, { key: "step", label: "Step", width: 0.18 }, { key: "n", label: "Failures", format: "int" }, { key: "error", label: "Last error", width: 0.45 }], steps.map((s) => ({ flow: String(s.flow), step: String(s.step), n: int(s.n), error: String(s.error ?? "") }))));
  if (jobs?.length) p.tables.push(table(ctx, "Background jobs (web worker)", [{ key: "kind", label: "Kind" }, { key: "total", label: "Jobs", format: "int" }, { key: "failed", label: "Failed", format: "int" }, { key: "retried", label: "Retried", format: "int" }, { key: "error", label: "Last error", width: 0.4 }], jobs.map((j) => ({ kind: String(j.kind), total: int(j.total), failed: int(j.failed), retried: int(j.retried), error: String(j.error ?? "") }))));
  if (syncs?.length) p.tables.push(table(ctx, "Data syncs", [{ key: "type", label: "Sync" }, { key: "total", label: "Runs", format: "int" }, { key: "failed", label: "Failed", format: "int" }, { key: "error", label: "Last error", width: 0.5 }], syncs.map((s) => ({ type: String(s.type), total: int(s.total), failed: int(s.failed), error: String(s.error ?? "") }))));
  for (const e of errors.slice(0, 5)) {
    if (int(e.n) < 2) continue;
    const eid = ctx.untrusted("error", `${String(e.flow)}: ${String(e.error)}`);
    p.findings.push({ severity: int(e.n) >= 5 ? "high" : "medium", title: `${String(e.flow)}: the same error ${int(e.n)} times`, detail: `Recorded error ${eid}; last seen ${String(e.last).slice(0, 16)} UTC.`, impact: "A repeated error is a defect or a broken dependency, not bad luck: retrying alone will not clear it.", evidence: [errTable.id, eid], confirmed: true, owner: String(e.flow) });
  }
  for (const j of jobs ?? []) {
    if (!int(j.failed)) continue;
    const eid = j.error ? ctx.untrusted("error", `job ${String(j.kind)}: ${String(j.error)}`) : null;
    p.findings.push({ severity: "medium", title: `Background job "${String(j.kind)}" failed ${int(j.failed)} time(s)`, detail: eid ? `Last error ${eid}.` : "No error recorded.", impact: "What the job does (indexing, submissions, syncs) did not happen for those jobs.", evidence: [p.kpis[3]!.id, ...(eid ? [eid] : [])], confirmed: !!eid, owner: "web worker" });
  }
  for (const s of syncs ?? []) {
    if (!int(s.failed)) continue;
    const eid = s.error ? ctx.untrusted("error", `sync ${String(s.type)}: ${String(s.error)}`) : null;
    p.findings.push({ severity: "medium", title: `${String(s.type)} sync failed ${int(s.failed)} of ${int(s.total)} time(s)`, detail: eid ? `Last error ${eid}.` : "No error recorded.", impact: "Reports and recommendations work from stale data until a sync succeeds.", evidence: [p.kpis[4]!.id, ...(eid ? [eid] : [])], confirmed: !!eid, owner: `${String(s.type)} sync` });
  }
  if (content && int(content[0]?.empty_runs) >= 2) {
    const reasons = await q<{ reason: string; n: number }>(ctx, sql`
      select regexp_replace(k.reason, '\\s*\\(.*\\)$', '') as reason, count(*)::int as n from news_candidates k join news_runs r on r.id = k.run_id
      where r.kind = 'job' and ${inRange("r.started_at", ctx.cur)} and k.decision <> 'selected' group by 1 order by 2 desc limit 3`).catch(() => []);
    const eid = reasons.length ? ctx.untrusted("log", `content flow rejection reasons: ${reasons.map((r) => `${int(r.n)} × ${r.reason}`).join("; ")}`) : null;
    p.findings.push({ severity: "high", title: `${int(content[0]?.empty_runs)} content flow runs succeeded but selected no story`, detail: `They scored ${int(content[0]?.scored)} stories in all and wrote nothing.${eid ? ` Rejection reasons: ${eid}.` : ""}`, impact: "Content flows look healthy in the run list while producing no drafts.", evidence: [p.kpis[5]!.id, ...(eid ? [eid] : [])], confirmed: !!eid, owner: "content flows" });
  }
  if (int(stuck[0]?.n)) p.findings.push({ severity: "high", title: `${int(stuck[0]?.n)} run(s) queued or running for more than 2 hours`, detail: "Cancel them in the CrewAI console (Runs) so their flows can start again for those targets.", impact: "Their flow and target stay locked.", evidence: [p.kpis[2]!.id], confirmed: true });
  return p;
};

// --- AI and LLM usage, cost and budget, agents ------------------------------------------------------------------------

async function usageTotals(ctx: Ctx, b: { from: string; to: string }) {
  const [r] = await q(ctx, sql`
    select count(*)::int as calls, coalesce(sum(input_tokens), 0)::float8 as input, coalesce(sum(output_tokens), 0)::float8 as output,
      coalesce(sum(cache_read_tokens), 0)::float8 as cache_read, coalesce(sum(cache_write_tokens), 0)::float8 as cache_write,
      coalesce(sum(cost_usd), 0)::float8 as cost, count(*) filter (where outcome <> 'ok')::int as not_ok,
      count(*) filter (where error_code = 'max_tokens')::int as truncated,
      count(*) filter (where cost_usd = 0 and (input_tokens + output_tokens) > 0)::int as unpriced,
      percentile_cont(0.5) within group (order by latency_ms) as p50, percentile_cont(0.95) within group (order by latency_ms) as p95
    from seo_llm_usage u where ${inRange("u.at", b)} and ${usageScope(ctx)}`);
  return { calls: int(r?.calls), input: int(r?.input), output: int(r?.output), cacheRead: int(r?.cache_read), cacheWrite: int(r?.cache_write), cost: num(r?.cost) ?? 0, notOk: int(r?.not_ok), truncated: int(r?.truncated), unpriced: int(r?.unpriced), p50: num(r?.p50), p95: num(r?.p95) };
}

export const aiUsage: Builder = async (ctx) => {
  const p = empty();
  const [cur, prev] = await Promise.all([usageTotals(ctx, ctx.cur), usageTotals(ctx, ctx.prev)]);
  p.rows.llm_usage = cur.calls;
  const cacheShare = ratio(cur.cacheRead, cur.input + cur.cacheRead || null);
  p.kpis.push(
    kpi(ctx, "Model calls", cur.calls, prev.calls, "int"),
    kpi(ctx, "Input tokens", cur.input, prev.input, "tokens"),
    kpi(ctx, "Output tokens", cur.output, prev.output, "tokens"),
    kpi(ctx, "Cached input share", cacheShare, ratio(prev.cacheRead, prev.input + prev.cacheRead || null), "pct", "up", "cache reads ÷ (input + cache reads)"),
    kpi(ctx, "Median call latency", cur.p50, prev.p50, "ms", "down"),
    kpi(ctx, "Calls cut off at max tokens", cur.truncated, prev.truncated, "int", "down"),
  );
  const perDay = await q(ctx, sql`select ${istDay("u.at")} as d, count(*)::int as calls, coalesce(sum(input_tokens), 0)::float8 as input, coalesce(sum(output_tokens), 0)::float8 as output from seo_llm_usage u where ${inRange("u.at", ctx.cur)} and ${usageScope(ctx)} group by 1`);
  p.charts.push(daily(ctx, "Model calls per day", perDay, [{ key: "calls", name: "calls" }], "calls"));
  p.charts.push(daily(ctx, "Tokens per day", perDay, [{ key: "input", name: "input" }, { key: "output", name: "output" }], "tokens"));
  const byPurpose = await q(ctx, sql`select purpose, count(*)::int as calls, coalesce(sum(input_tokens), 0)::float8 as input, coalesce(sum(output_tokens), 0)::float8 as output, coalesce(sum(cost_usd), 0)::float8 as cost from seo_llm_usage u where ${inRange("u.at", ctx.cur)} and ${usageScope(ctx)} group by 1 order by 5 desc limit 15`);
  p.tables.push(table(ctx, "Usage by purpose", [{ key: "purpose", label: "Purpose" }, { key: "calls", label: "Calls", format: "int" }, { key: "input", label: "Input tokens", format: "tokens" }, { key: "output", label: "Output tokens", format: "tokens" }, { key: "cost", label: "Cost", format: "usd" }], byPurpose.map((r) => ({ purpose: String(r.purpose), calls: int(r.calls), input: int(r.input), output: int(r.output), cost: num(r.cost) }))));
  const byModel = await q(ctx, sql`
    select provider, model, count(*)::int as calls, percentile_cont(0.5) within group (order by latency_ms) as p50, count(*) filter (where outcome <> 'ok')::int as not_ok, coalesce(sum(output_tokens), 0)::float8 as output
    from seo_llm_usage u where ${inRange("u.at", ctx.cur)} and ${usageScope(ctx)} group by 1, 2 order by 3 desc limit 15`);
  const modelTable = table(ctx, "Usage by model", [{ key: "model", label: "Model", width: 0.32 }, { key: "provider", label: "Provider" }, { key: "calls", label: "Calls", format: "int" }, { key: "output", label: "Output tokens", format: "tokens" }, { key: "p50", label: "Median latency", format: "ms" }, { key: "not_ok", label: "Not OK", format: "int" }], byModel.map((r) => ({ model: String(r.model), provider: String(r.provider), calls: int(r.calls), output: int(r.output), p50: num(r.p50), not_ok: int(r.not_ok) })));
  p.tables.push(modelTable);
  if (cur.truncated) {
    const top = await q<{ who: string; n: number }>(ctx, sql`select coalesce(nullif(agent, ''), purpose) as who, count(*)::int as n from seo_llm_usage u where ${inRange("u.at", ctx.cur)} and ${usageScope(ctx)} and error_code = 'max_tokens' group by 1 order by 2 desc limit 3`);
    p.findings.push({ severity: "medium", title: `${cur.truncated} model call(s) were cut off at their output limit`, detail: `Most by: ${top.map((t) => `${t.who} (${int(t.n)})`).join(", ")}. The answer was incomplete; the tokens were still paid for.`, impact: "Incomplete drafts or analyses, retries, wasted cost.", evidence: [p.kpis[5]!.id, modelTable.id], confirmed: true, owner: top[0]?.who ?? null });
  }
  return p;
};

export const llmCost: Builder = async (ctx) => {
  const p = empty();
  const [cur, prev] = await Promise.all([usageTotals(ctx, ctx.cur), usageTotals(ctx, ctx.prev)]);
  p.rows.llm_usage = cur.calls;
  const runs = await q(ctx, sql`
    select count(distinct u.run_id) filter (where r.status = 'succeeded')::int as ok_runs,
      coalesce(sum(u.cost_usd) filter (where r.status = 'succeeded'), 0)::float8 as ok_cost,
      coalesce(sum(u.cost_usd) filter (where r.status in ('failed', 'cancelled')), 0)::float8 as failed_cost,
      count(distinct u.run_id) filter (where r.status in ('failed', 'cancelled'))::int as failed_runs
    from seo_llm_usage u join seo_flow_runs r on r.run_id::text = u.run_id where ${inRange("u.at", ctx.cur)} and ${usageScope(ctx)}`);
  p.rows.flow_runs = int(runs[0]?.ok_runs) + int(runs[0]?.failed_runs);
  const drafts = await q(ctx, sql`
    select (select count(*) from seo_drafts where ${inRange("created_at", ctx.cur)})::int + coalesce((select count(*) from news_articles where ${inRange("created_at", ctx.cur)}), 0)::int as n`).catch(async () => q(ctx, sql`select count(*)::int as n from seo_drafts where ${inRange("created_at", ctx.cur)}`));
  const contentCost = await q(ctx, sql`
    select coalesce(sum(u.cost_usd), 0)::float8 as cost from seo_llm_usage u join seo_flow_runs r on r.run_id::text = u.run_id
    where ${inRange("u.at", ctx.cur)} and ${usageScope(ctx)} and r.flow_name in ('new_article_flow', 'optimize_article_flow', 'news_job_flow', 'news_draft_flow', 'custom_flow')`);
  const okRuns = int(runs[0]?.ok_runs);
  const nDrafts = int(drafts[0]?.n);
  p.kpis.push(
    kpi(ctx, "LLM cost", cur.cost, prev.cost, "usd", "down", "as recorded by the SEO agent at call time"),
    kpi(ctx, "Cost per successful run", okRuns ? (num(runs[0]?.ok_cost) ?? 0) / okRuns : null, null, "usd", "down", "LLM cost of the runs that succeeded ÷ those runs"),
    kpi(ctx, "Cost per AI draft", nDrafts ? (num(contentCost[0]?.cost) ?? 0) / nDrafts : null, null, "usd", "down", "cost of the drafting flows ÷ drafts and articles created"),
    kpi(ctx, "Cost of failed or cancelled runs", num(runs[0]?.failed_cost), null, "usd", "down"),
    kpi(ctx, "Input tokens", cur.input, prev.input, "tokens"),
    kpi(ctx, "Output tokens", cur.output, prev.output, "tokens"),
  );
  if (cur.unpriced) p.kpis.push(kpi(ctx, "Calls with unknown cost", cur.unpriced, null, "int", "down", "tokens recorded but no price configured for the model"));
  // Daily cost against the previous period, day by day.
  const dayCost = await q(ctx, sql`select ${istDay("u.at")} as d, coalesce(sum(cost_usd), 0)::float8 as cost from seo_llm_usage u where ${inRange("u.at", ctx.cur)} and ${usageScope(ctx)} group by 1`);
  const prevCost = await q(ctx, sql`select ${istDay("u.at")} as d, coalesce(sum(cost_usd), 0)::float8 as cost from seo_llm_usage u where ${inRange("u.at", ctx.prev)} and ${usageScope(ctx)} group by 1`);
  const days = eachDay(ctx.range.start, ctx.range.end);
  const prevDays = eachDay(ctx.range.previousStart, ctx.range.previousEnd);
  const cm = new Map(dayCost.map((r) => [String(r.d), num(r.cost) ?? 0]));
  const pm = new Map(prevCost.map((r) => [String(r.d), num(r.cost) ?? 0]));
  p.charts.push({ id: ctx.id("C"), type: "line", title: "Daily LLM cost (previous period aligned by day)", unit: "usd", series: [{ name: "this period", points: days.map((d) => [d, cm.get(d) ?? 0]) }, { name: "previous period", points: days.map((d, i) => [d, pm.get(prevDays[i] ?? "") ?? 0]) }] });
  const months = await q(ctx, sql`select to_char(date_trunc('month', at), 'YYYY-MM') as m, coalesce(sum(cost_usd), 0)::float8 as cost from seo_llm_usage u where at >= date_trunc('month', ${ctx.cur.to}::timestamptz) - interval '5 months' and at < ${ctx.cur.to} and ${usageScope(ctx)} group by 1 order by 1`);
  p.charts.push(bar(ctx, "Monthly LLM cost (last 6 months)", months.map((r) => [String(r.m), num(r.cost) ?? 0]), "usd"));
  const group = async (by: SQL, label: string, key: string, joinRuns = false) => {
    const rows = await q(ctx, sql`
      select ${by} as k, count(*)::int as calls, coalesce(sum(u.input_tokens), 0)::float8 as input, coalesce(sum(u.output_tokens), 0)::float8 as output, coalesce(sum(u.cost_usd), 0)::float8 as cost
      from seo_llm_usage u ${joinRuns ? sql`left join seo_flow_runs r on r.run_id::text = u.run_id` : sql``}
      where ${inRange("u.at", ctx.cur)} and ${usageScope(ctx)} group by 1 order by 5 desc limit 15`);
    const total = rows.reduce((s, r) => s + (num(r.cost) ?? 0), 0);
    return table(ctx, `Cost by ${label}`, [{ key, label: label[0]!.toUpperCase() + label.slice(1), width: 0.3 }, { key: "calls", label: "Calls", format: "int" }, { key: "input", label: "Input tokens", format: "tokens" }, { key: "output", label: "Output tokens", format: "tokens" }, { key: "cost", label: "Cost", format: "usd" }, { key: "share", label: "Share", format: "pct" }], rows.map((r) => ({ [key]: String(r.k ?? "—"), calls: int(r.calls), input: int(r.input), output: int(r.output), cost: num(r.cost), share: total ? (num(r.cost) ?? 0) / total : null })));
  };
  const byProvider = await group(sql`u.provider`, "provider", "provider");
  const byModel = await group(sql`u.model`, "model", "model");
  const byFlow = await group(sql`coalesce(r.flow_name, 'web app (no flow run)')`, "flow", "flow", true);
  const byAgent = await group(sql`coalesce(nullif(u.agent, ''), 'no agent (' || u.purpose || ')')`, "agent", "agent");
  const byFamily = await group(sql`regexp_replace(coalesce(u.prompt_version, ''), '(-v[0-9].*|\\+.*)$', '')`, "crew", "crew");
  for (const r of byFamily.rows) r.crew = ctx.crewOfFamily.get(String(r.crew)) ?? (r.crew ? `${String(r.crew)} (prompt family)` : "no crew");
  const byCategory = await q(ctx, sql`
    select coalesce(c, 'uncategorised') as k, coalesce(sum(u.cost_usd), 0)::float8 as cost, count(*)::int as calls
    from seo_llm_usage u left join seo_flow_runs r on r.run_id::text = u.run_id
    left join lateral (select unnest(f.categories) as c from crewai_flows f where f.flow_name = r.flow_name and f.deleted_at is null and f.definition <> 'content' limit 1) cat on true
    where ${inRange("u.at", ctx.cur)} and ${usageScope(ctx)} group by 1 order by 2 desc`).catch(() => []);
  p.tables.push(byProvider, byModel, byFamily, byFlow, byAgent);
  if (byCategory.length) p.tables.push(table(ctx, "Cost by flow category", [{ key: "category", label: "Category" }, { key: "calls", label: "Calls", format: "int" }, { key: "cost", label: "Cost", format: "usd" }], byCategory.map((r) => ({ category: String(r.k), calls: int(r.calls), cost: num(r.cost) })), "Each run's cost under its flow's first category in the catalogue."));
  p.charts.push(bar(ctx, "Cost by model", byModel.rows.map((r) => [String(r.model), Number(r.cost ?? 0)]), "usd"));
  const perRun = await q(ctx, sql`
    select r.flow_name as flow, count(distinct r.run_id)::int as runs, (coalesce(sum(u.cost_usd), 0) / nullif(count(distinct r.run_id), 0))::float8 as avg, max(r.cost_usd)::float8 as max
    from seo_flow_runs r join seo_llm_usage u on u.run_id = r.run_id::text where ${inRange("r.started_at", ctx.cur)} and ${runScope(ctx)} group by 1 order by 3 desc nulls last limit 10`);
  const perRunTable = table(ctx, "Cost per run by flow", [{ key: "flow", label: "Flow", width: 0.34 }, { key: "runs", label: "Runs with model calls", format: "int" }, { key: "avg", label: "Average per run", format: "usd" }, { key: "max", label: "Most expensive run", format: "usd" }], perRun.map((r) => ({ flow: String(r.flow), runs: int(r.runs), avg: num(r.avg), max: num(r.max) })));
  p.tables.push(perRunTable);
  // Budget: the one LLM budget the SEO agent keeps (UTC day and month). Asked from the agent (it owns it); else read
  // from its table; else unknown, which is said as such (never "no budget").
  const budget = await llmBudget(ctx);
  p.rows.llm_budget = budget ? 1 : null;
  if (!budget) {
    p.note = "The LLM budget could not be read: the SEO agent did not answer and its budget table is not on this database.";
  } else {
    p.kpis.push(
      kpi(ctx, "Spent this month (UTC, now)", budget.month, null, "usd", "down", budget.forecast !== null ? `forecast for the month ${fmt(budget.forecast, "usd")}` : undefined),
      kpi(ctx, "Monthly LLM budget", budget.monthly, null, "usd", null, budget.monthly === null ? "no monthly limit set" : undefined),
      kpi(ctx, "Daily LLM budget", budget.daily, null, "usd", null, budget.daily === null ? "no daily limit set" : undefined),
    );
    const [mtdKpi, monthlyKpi] = p.kpis.slice(-3);
    const monthly = budget.monthly;
    if (monthly === null && budget.daily === null) p.findings.push({ severity: "low", title: "No LLM budget is set", detail: "Neither a daily nor a monthly limit: nothing stops LLM spending.", impact: "A runaway flow or a retry loop is only stopped by the provider's own limit.", evidence: [monthlyKpi!.id], confirmed: true, owner: "Settings → AI & models → LLM providers & budget" });
    else if (monthly !== null && monthly > 0 && (budget.month ?? 0) / monthly >= 0.8) {
      const used = (budget.month ?? 0) / monthly;
      p.findings.push({ severity: used >= 1 ? "critical" : "high", title: used >= 1 ? "The monthly LLM budget is used up" : `${fmt(used, "pct")} of the monthly LLM budget is used`, detail: `${fmt(budget.month, "usd")} of ${fmt(monthly, "usd")} this month (UTC).`, impact: used >= 1 ? "LLM calls are refused until the month ends or the limit is raised: flows pause with budget errors." : "At this pace LLM calls will be refused before the month ends.", evidence: [mtdKpi!.id, monthlyKpi!.id], confirmed: true, owner: "Settings → AI & models → LLM providers & budget" });
    } else if (monthly !== null && budget.forecast !== null && budget.forecast > monthly) p.findings.push({ severity: "medium", title: "The month's LLM spend is on course to pass the monthly budget", detail: `Forecast ${fmt(budget.forecast, "usd")} against a limit of ${fmt(monthly, "usd")}.`, impact: "LLM calls would be refused before the month ends.", evidence: [mtdKpi!.id, monthlyKpi!.id], confirmed: false, owner: "Settings → AI & models → LLM providers & budget" });
  }
  if ((num(runs[0]?.failed_cost) ?? 0) > 0) p.findings.push({ severity: (num(runs[0]?.failed_cost) ?? 0) > cur.cost * 0.2 ? "medium" : "low", title: `${fmt(num(runs[0]?.failed_cost), "usd")} was spent on runs that failed or were cancelled`, detail: `${int(runs[0]?.failed_runs)} run(s) used the model and did not finish.`, impact: "Paid work with nothing to show; fixing the failure saves this cost.", evidence: [p.kpis[3]!.id], confirmed: true });
  if (cur.unpriced) p.findings.push({ severity: "low", title: `${cur.unpriced} call(s) have tokens but no recorded cost`, detail: "Their model has no price in the agent's price table, so their cost is unknown, not zero.", impact: "Cost totals are lower than the real spend.", evidence: [p.kpis.find((k) => k.label === "Calls with unknown cost")!.id], confirmed: true, owner: "Settings → AI & models → LLM providers & budget (model prices)" });
  if (prev.cost > 0 && cur.cost / prev.cost >= 1.5 && cur.cost - prev.cost >= 1) p.findings.push({ severity: "medium", title: `LLM cost rose ${signedPct(change(cur.cost, prev.cost))}`, detail: `${fmt(cur.cost, "usd")} against ${fmt(prev.cost, "usd")} in the previous period.`, impact: "See cost by flow and by agent for where it went.", evidence: [p.kpis[0]!.id, byFlow.id], confirmed: false });
  return p;
};

async function llmBudget(ctx: Ctx): Promise<{ daily: number | null; monthly: number | null; month: number | null; forecast: number | null } | null> {
  try {
    const { getLlmBudget } = await import("../seo-agent/client");
    const v = await getLlmBudget("month");
    return { daily: num(v.budget.daily_usd), monthly: num(v.budget.monthly_usd), month: num(v.spent_usd), forecast: num(v.forecast_usd) };
  } catch {
    const row = await q<{ daily_usd: unknown; monthly_usd: unknown }>(ctx, sql`select daily_usd, monthly_usd from seo_agent_llm_budget limit 1`).catch(() => null);
    if (row === null) return null;
    const [mtd] = await q(ctx, sql`select coalesce(sum(cost_usd), 0)::float8 as month from seo_llm_usage where at >= date_trunc('month', now() at time zone 'UTC') at time zone 'UTC'`);
    return { daily: num(row[0]?.daily_usd), monthly: num(row[0]?.monthly_usd), month: num(mtd?.month), forecast: null };
  }
}

export const agents: Builder = async (ctx) => {
  const p = empty();
  const rows = await q(ctx, sql`
    select regexp_replace(coalesce(u.prompt_version, ''), '(-v[0-9].*|\\+.*)$', '') as fam, coalesce(nullif(u.agent, ''), '(no agent)') as agent, count(*)::int as calls,
      coalesce(sum(u.input_tokens), 0)::float8 as input, coalesce(sum(u.output_tokens), 0)::float8 as output, coalesce(sum(u.cost_usd), 0)::float8 as cost,
      percentile_cont(0.5) within group (order by u.latency_ms) as p50, count(*) filter (where u.error_code = 'max_tokens')::int as truncated, count(*) filter (where u.outcome <> 'ok')::int as not_ok
    from seo_llm_usage u where ${inRange("u.at", ctx.cur)} and ${usageScope(ctx)} group by 1, 2 order by 6 desc limit 30`);
  p.rows.llm_usage = rows.reduce((n, r) => n + int(r.calls), 0);
  const calls = await q(ctx, sql`
    select c.agent, count(*)::int as calls, count(distinct c.run_id)::int as runs, avg(c.output_tokens)::float8 as avg_out
    from seo_flow_run_calls c join seo_flow_runs r on r.run_id = c.run_id where ${inRange("c.at", ctx.cur)} and ${runScope(ctx)} and c.agent is not null group by 1`).catch(() => null);
  p.rows.run_calls = calls?.length ?? null;
  const perRun = new Map((calls ?? []).map((c) => [String(c.agent), int(c.runs) ? int(c.calls) / int(c.runs) : null]));
  const t = table(ctx, "Agents", [{ key: "crew", label: "Crew", width: 0.2 }, { key: "agent", label: "Agent", width: 0.16 }, { key: "calls", label: "Calls", format: "int" }, { key: "per_run", label: "Calls per run", format: "float" }, { key: "output", label: "Output tokens", format: "tokens" }, { key: "cost", label: "Cost", format: "usd" }, { key: "p50", label: "Median latency", format: "ms" }, { key: "truncated", label: "Cut off", format: "int" }],
    rows.map((r) => ({ crew: ctx.crewOfFamily.get(String(r.fam)) ?? (String(r.fam) || "—"), agent: String(r.agent), calls: int(r.calls), per_run: perRun.get(String(r.agent)) ?? null, output: int(r.output), cost: num(r.cost), p50: num(r.p50), truncated: int(r.truncated) })));
  p.tables.push(t);
  const crews = new Map<string, { calls: number; cost: number }>();
  for (const r of t.rows) {
    const c = crews.get(String(r.crew)) ?? { calls: 0, cost: 0 };
    crews.set(String(r.crew), { calls: c.calls + Number(r.calls), cost: c.cost + Number(r.cost ?? 0) });
  }
  p.kpis.push(kpi(ctx, "Agents that called a model", rows.length, null, "int"), kpi(ctx, "Crews that called a model", crews.size, null, "int"));
  p.charts.push(bar(ctx, "Cost by crew", [...crews.entries()].sort((a, b) => b[1].cost - a[1].cost).map(([k, v]) => [k, v.cost]), "usd"));
  for (const r of t.rows) {
    const n = Number(r.calls);
    if (n >= 5 && Number(r.truncated) / n >= 0.1) p.findings.push({ severity: "medium", title: `${String(r.agent)} (${String(r.crew)}) was cut off in ${Number(r.truncated)} of ${n} calls`, detail: "Its answers hit the output token limit.", impact: "Incomplete work for the next agent, and paid tokens wasted; raise this agent's output limit or ask for shorter output.", evidence: [t.id], confirmed: true, owner: `${String(r.crew)} → ${String(r.agent)}` });
  }
  return p;
};

// --- Search, traffic, keywords ------------------------------------------------------------------------------------------

export const seo: Builder = async (ctx) => {
  const p = empty();
  const totals = async (s: string, e: string) => {
    const [r] = await q(ctx, sql`select sum(clicks)::float8 as clicks, sum(impressions)::float8 as impressions, sum(position * impressions) filter (where position is not null) / nullif(sum(impressions) filter (where position is not null), 0) as position, count(*)::int as days from seo_gsc_daily_totals where search_type = 'web' and date between ${s} and ${e}`);
    return { clicks: num(r?.clicks), impressions: num(r?.impressions), position: num(r?.position), days: int(r?.days) };
  };
  const [cur, prev] = await Promise.all([totals(ctx.range.start, ctx.range.end), totals(ctx.range.previousStart, ctx.range.previousEnd)]);
  p.rows.gsc_totals = cur.days;
  if (!cur.days) {
    p.note = "No Search Console data for these dates.";
  } else {
    p.kpis.push(
      kpi(ctx, "Search clicks", cur.clicks, prev.days ? prev.clicks : null, "int", "up"),
      kpi(ctx, "Search impressions", cur.impressions, prev.days ? prev.impressions : null, "int", "up"),
      kpi(ctx, "Click-through rate", ratio(cur.clicks, cur.impressions), prev.days ? ratio(prev.clicks, prev.impressions) : null, "pct", "up"),
      kpi(ctx, "Average position", cur.position, prev.days ? prev.position : null, "float", "down", "lower is better"),
    );
    const perDay = await q(ctx, sql`select date::text as d, sum(clicks)::float8 as clicks, sum(impressions)::float8 as impressions from seo_gsc_daily_totals where search_type = 'web' and date between ${ctx.range.start} and ${ctx.range.end} group by 1`);
    p.charts.push(daily(ctx, "Search clicks per day", perDay, [{ key: "clicks", name: "clicks" }], "clicks"));
    if (cur.days < ctx.range.days) p.findings.push({ severity: "low", title: `Search Console data covers ${cur.days} of ${ctx.range.days} days`, detail: "Search Console publishes data with a delay of about two days, and a sync may have been missed.", impact: "The latest days are missing or still changing.", evidence: [p.kpis[0]!.id], confirmed: true, owner: "gsc sync" });
    const c = change(cur.clicks, prev.clicks);
    if (prev.days && c !== null && c <= -0.2 && (prev.clicks ?? 0) >= 50) p.findings.push({ severity: c <= -0.4 ? "high" : "medium", title: `Search clicks fell ${signedPct(c)}`, detail: `${fmt(cur.clicks, "int")} clicks against ${fmt(prev.clicks, "int")} in the previous period.`, impact: "Less organic traffic.", evidence: [p.kpis[0]!.id], confirmed: false });
  }
  const pages = await q(ctx, sql`
    with c as (select page, sum(clicks)::float8 as clicks from seo_gsc_page_daily where search_type = 'web' and date between ${ctx.range.start} and ${ctx.range.end} group by page),
    pr as (select page, sum(clicks)::float8 as clicks from seo_gsc_page_daily where search_type = 'web' and date between ${ctx.range.previousStart} and ${ctx.range.previousEnd} group by page)
    select coalesce(c.page, pr.page) as page, coalesce(c.clicks, 0) as clicks, coalesce(pr.clicks, 0) as prev, post.title
    from c full outer join pr on pr.page = c.page left join seo_url_map m on m.url = coalesce(c.page, pr.page) left join post on post.id = m.article_id`).catch(() => null);
  p.rows.gsc_pages = pages?.length ?? null;
  if (pages?.length) {
    const rows = pages.map((r) => ({ page: String(r.title ?? r.page), clicks: num(r.clicks) ?? 0, previous: num(r.prev) ?? 0, delta: (num(r.clicks) ?? 0) - (num(r.prev) ?? 0) }));
    const cols: Column[] = [{ key: "page", label: "Page", width: 0.52 }, { key: "clicks", label: "Clicks", format: "int" }, { key: "previous", label: "Previous", format: "int" }, { key: "delta", label: "Change", format: "int" }];
    p.tables.push(table(ctx, "Top pages by clicks", cols, [...rows].sort((a, b) => b.clicks - a.clicks).slice(0, 10)));
    const down = rows.filter((r) => r.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, 10);
    const up = rows.filter((r) => r.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, 10);
    if (up.length) p.tables.push(table(ctx, "Growing pages", cols, up));
    if (down.length) {
      const dt = table(ctx, "Declining pages", cols, down);
      p.tables.push(dt);
      if (down[0]!.delta <= -20) p.findings.push({ severity: "medium", title: `“${down[0]!.page}” lost ${fmt(-down[0]!.delta, "int")} clicks`, detail: `${fmt(down[0]!.clicks, "int")} clicks against ${fmt(down[0]!.previous, "int")}.`, impact: "The page that lost the most search traffic; check its rankings and whether it needs an update.", evidence: [dt.id], confirmed: false });
    }
  }
  const recs = await q(ctx, sql`
    select count(*) filter (where ${inRange("created_at", ctx.cur)})::int as created, count(*) filter (where ${inRange("implemented_at", ctx.cur)})::int as implemented,
      count(*) filter (where review_status = 'pending')::int as pending, count(*) filter (where review_status = 'pending' and priority_band = 'high')::int as pending_high
    from seo_recommendations`).catch(() => null);
  if (recs) {
    p.rows.recommendations = int(recs[0]?.created);
    p.kpis.push(kpi(ctx, "Recommendations created", int(recs[0]?.created), null, "int"), kpi(ctx, "Recommendations implemented", int(recs[0]?.implemented), null, "int", "up"), kpi(ctx, "High-priority recommendations waiting", int(recs[0]?.pending_high), null, "int", "down"));
    if (int(recs[0]?.pending_high) >= 5) p.findings.push({ severity: "medium", title: `${int(recs[0]?.pending_high)} high-priority recommendations are waiting for review`, detail: `${int(recs[0]?.pending)} recommendations are pending in all.`, impact: "The site's biggest search opportunities are not being acted on.", evidence: [p.kpis.at(-1)!.id], confirmed: true, owner: "AI & SEO → Recommendations" });
  }
  return p;
};

export const traffic: Builder = async (ctx) => {
  const p = empty();
  const totals = async (s: string, e: string) => {
    const [r] = await q(ctx, sql`select sum(sessions)::float8 as sessions, sum(sessions) filter (where channel_group = 'Organic Search')::float8 as organic, sum(engaged_sessions)::float8 as engaged, sum(active_users)::float8 as users, sum(new_users)::float8 as new_users, sum(screen_page_views)::float8 as views, count(distinct date)::int as days from seo_ga4_page_daily where date between ${s} and ${e}`);
    return { sessions: num(r?.sessions), organic: num(r?.organic), engaged: num(r?.engaged), users: num(r?.users), newUsers: num(r?.new_users), views: num(r?.views), days: int(r?.days) };
  };
  const [cur, prev] = await Promise.all([totals(ctx.range.start, ctx.range.end), totals(ctx.range.previousStart, ctx.range.previousEnd)]);
  p.rows.ga4 = cur.days;
  if (!cur.days) {
    p.note = "No Google Analytics 4 data for these dates.";
    return p;
  }
  const pv = (v: number | null) => (prev.days ? v : null);
  p.kpis.push(
    kpi(ctx, "Sessions", cur.sessions, pv(prev.sessions), "int", "up"),
    kpi(ctx, "Organic search sessions", cur.organic, pv(prev.organic), "int", "up"),
    kpi(ctx, "Active users (summed per page and day)", cur.users, pv(prev.users), "int", "up"),
    kpi(ctx, "Engagement rate", ratio(cur.engaged, cur.sessions), pv(ratio(prev.engaged, prev.sessions)), "pct", "up"),
    kpi(ctx, "Page views", cur.views, pv(prev.views), "int", "up"),
  );
  const perDay = await q(ctx, sql`select date::text as d, sum(sessions)::float8 as sessions, sum(sessions) filter (where channel_group = 'Organic Search')::float8 as organic from seo_ga4_page_daily where date between ${ctx.range.start} and ${ctx.range.end} group by 1`);
  p.charts.push(daily(ctx, "Sessions per day", perDay, [{ key: "sessions", name: "all" }, { key: "organic", name: "organic search" }], "sessions"));
  const channels = await q(ctx, sql`select coalesce(channel_group, '(not set)') as channel, sum(sessions)::float8 as sessions, sum(engaged_sessions)::float8 as engaged from seo_ga4_page_daily where date between ${ctx.range.start} and ${ctx.range.end} group by 1 order by 2 desc limit 10`);
  p.tables.push(table(ctx, "Sessions by channel", [{ key: "channel", label: "Channel" }, { key: "sessions", label: "Sessions", format: "int" }, { key: "rate", label: "Engagement rate", format: "pct" }], channels.map((c) => ({ channel: String(c.channel), sessions: num(c.sessions), rate: ratio(num(c.engaged), num(c.sessions)) }))));
  const pages = await q(ctx, sql`select landing_page as page, sum(sessions)::float8 as sessions, sum(engaged_sessions)::float8 as engaged from seo_ga4_page_daily where date between ${ctx.range.start} and ${ctx.range.end} group by 1 order by 2 desc limit 10`);
  p.tables.push(table(ctx, "Top landing pages", [{ key: "page", label: "Landing page", width: 0.6 }, { key: "sessions", label: "Sessions", format: "int" }, { key: "rate", label: "Engagement rate", format: "pct" }], pages.map((c) => ({ page: String(c.page), sessions: num(c.sessions), rate: ratio(num(c.engaged), num(c.sessions)) }))));
  const c = change(cur.sessions, prev.sessions);
  if (prev.days && c !== null && c <= -0.2 && (prev.sessions ?? 0) >= 100) p.findings.push({ severity: c <= -0.4 ? "high" : "medium", title: `Sessions fell ${signedPct(c)}`, detail: `${fmt(cur.sessions, "int")} against ${fmt(prev.sessions, "int")}.`, impact: "Fewer readers.", evidence: [p.kpis[0]!.id], confirmed: false });
  return p;
};

export const search: Builder = async (ctx) => {
  const p = empty();
  const top = await q(ctx, sql`
    with c as (select query, sum(clicks)::float8 as clicks, sum(impressions)::float8 as impressions, sum(position * impressions) / nullif(sum(impressions), 0) as position from seo_gsc_query_daily where search_type = 'web' and date between ${ctx.range.start} and ${ctx.range.end} group by query),
    pr as (select query, sum(clicks)::float8 as clicks from seo_gsc_query_daily where search_type = 'web' and date between ${ctx.range.previousStart} and ${ctx.range.previousEnd} group by query)
    select c.query, c.clicks, c.impressions, c.position, pr.clicks as prev from c left join pr on pr.query = c.query`).catch(() => null);
  p.rows.gsc_queries = top?.length ?? null;
  if (!top?.length) {
    p.note = "No Search Console query data for these dates.";
  } else {
    const rows = top.map((r) => ({ query: String(r.query), clicks: num(r.clicks) ?? 0, impressions: num(r.impressions) ?? 0, position: num(r.position), prev: num(r.prev) }));
    const striking = rows.filter((r) => r.position !== null && r.position >= 8 && r.position <= 20).sort((a, b) => b.impressions - a.impressions);
    p.kpis.push(kpi(ctx, "Queries with impressions", rows.length, null, "int", "up"), kpi(ctx, "New queries (none the period before)", rows.filter((r) => r.prev === null).length, null, "int", "up"), kpi(ctx, "Striking-distance queries (position 8–20)", striking.length, null, "int"));
    const cols: Column[] = [{ key: "query", label: "Query", width: 0.46 }, { key: "clicks", label: "Clicks", format: "int" }, { key: "impressions", label: "Impressions", format: "int" }, { key: "ctr", label: "CTR", format: "pct" }, { key: "position", label: "Position", format: "float" }];
    const withCtr = (r: (typeof rows)[number]) => ({ ...r, ctr: ratio(r.clicks, r.impressions) });
    p.tables.push(table(ctx, "Top queries by clicks", cols, [...rows].sort((a, b) => b.clicks - a.clicks).slice(0, 12).map(withCtr)));
    if (striking.length) {
      const st = table(ctx, "Striking-distance queries", cols, striking.slice(0, 12).map(withCtr), "Average position 8–20: page one is within reach with a better title, section or internal links.");
      p.tables.push(st);
      p.findings.push({ severity: "low", title: `${striking.length} queries rank just off or low on page one`, detail: `The biggest by impressions: “${striking[0]!.query}”.`, impact: "The cheapest search gains: these pages already rank.", evidence: [st.id], confirmed: true, owner: "AI & SEO → Keywords" });
    }
    const lowCtr = rows.filter((r) => r.impressions >= 500 && r.position !== null && r.position <= 5 && r.clicks / r.impressions < 0.02).slice(0, 8);
    if (lowCtr.length) {
      const lt = table(ctx, "High position, low click-through", cols, lowCtr.map(withCtr));
      p.tables.push(lt);
      p.findings.push({ severity: "low", title: `${lowCtr.length} queries rank in the top 5 with under 2% click-through`, detail: "The title or snippet is not winning the click.", impact: "Traffic lost without any ranking change.", evidence: [lt.id], confirmed: true });
    }
  }
  const tracked = await q(ctx, sql`select query, last_position, alert_positions from seo_tracked_keywords order by query limit 30`).catch(() => null);
  p.rows.tracked_keywords = tracked?.length ?? null;
  if (tracked?.length) p.tables.push(table(ctx, "Tracked keywords", [{ key: "query", label: "Keyword", width: 0.5 }, { key: "last_position", label: "Last position", format: "float" }, { key: "alert_positions", label: "Alert after a move of", format: "float" }], tracked.map((t) => ({ query: String(t.query), last_position: num(t.last_position), alert_positions: num(t.alert_positions) }))));
  return p;
};

// --- Content, editorial planning, quality --------------------------------------------------------------------------------

export const content: Builder = async (ctx) => {
  const p = empty();
  const published = async (b: { from: string; to: string }) => int((await q(ctx, sql`select count(*)::int as n from post where status = 'published' and deleted_at is null and ${inRange("published_at", b)}`))[0]?.n);
  const [pubCur, pubPrev] = await Promise.all([published(ctx.cur), published(ctx.prev)]);
  p.rows.posts = pubCur;
  const drafts = await q(ctx, sql`
    select coalesce(kind, 'optimize') as kind, count(*)::int as created, count(*) filter (where status = 'generation_failed')::int as failed,
      count(*) filter (where status in ('approved', 'scheduled', 'published', 'publishing'))::int as approved, count(*) filter (where status = 'rejected')::int as rejected,
      count(*) filter (where status = 'ready_for_review')::int as waiting
    from seo_drafts where ${inRange("created_at", ctx.cur)} group by 1 order by 2 desc`).catch(() => null);
  p.rows.drafts = drafts?.reduce((n, d) => n + int(d.created), 0) ?? null;
  const news = await q(ctx, sql`select status, count(*)::int as n from news_articles where ${inRange("created_at", ctx.cur)} group by 1 order by 2 desc`).catch(() => null);
  p.rows.news = news?.reduce((n, a) => n + int(a.n), 0) ?? null;
  const total = (k: "created" | "failed" | "approved" | "rejected" | "waiting") => drafts?.reduce((n, d) => n + int(d[k]), 0) ?? null;
  p.kpis.push(kpi(ctx, "Posts published", pubCur, pubPrev, "int", "up"), kpi(ctx, "AI drafts created", total("created"), null, "int"), kpi(ctx, "AI drafts approved or published", total("approved"), null, "int", "up"), kpi(ctx, "AI drafts rejected", total("rejected"), null, "int", "down"), kpi(ctx, "AI drafts that failed to generate", total("failed"), null, "int", "down"), kpi(ctx, "Content flow articles", p.rows.news, null, "int"));
  const perDay = await q(ctx, sql`select ${istDay("published_at")} as d, count(*)::int as n from post where status = 'published' and deleted_at is null and ${inRange("published_at", ctx.cur)} group by 1`);
  p.charts.push(daily(ctx, "Posts published per day", perDay, [{ key: "n", name: "posts" }], "posts", "line"));
  const list = await q(ctx, sql`select title, collection, category, published_at::text as at from post where status = 'published' and deleted_at is null and ${inRange("published_at", ctx.cur)} order by published_at desc limit 20`);
  if (list.length) p.tables.push(table(ctx, "Published in the period", [{ key: "title", label: "Title", width: 0.55 }, { key: "collection", label: "Collection" }, { key: "category", label: "Category" }, { key: "at", label: "Published" }], list.map((r) => ({ title: String(r.title), collection: String(r.collection), category: String(r.category), at: String(r.at).slice(0, 16) }))));
  if (drafts?.length) p.tables.push(table(ctx, "AI drafts by kind", [{ key: "kind", label: "Kind" }, { key: "created", label: "Created", format: "int" }, { key: "approved", label: "Approved", format: "int" }, { key: "rejected", label: "Rejected", format: "int" }, { key: "waiting", label: "Waiting", format: "int" }, { key: "failed", label: "Failed", format: "int" }], drafts.map((d) => ({ kind: String(d.kind), created: int(d.created), approved: int(d.approved), rejected: int(d.rejected), waiting: int(d.waiting), failed: int(d.failed) }))));
  if (news?.length) p.tables.push(table(ctx, "Content flow articles by status", [{ key: "status", label: "Status" }, { key: "n", label: "Articles", format: "int" }], news.map((n) => ({ status: String(n.status), n: int(n.n) }))));
  const failed = total("failed") ?? 0;
  if (failed >= 2) {
    const [why] = await q<{ reason: string | null }>(ctx, sql`select left(failure_reason, 300) as reason from seo_drafts where status = 'generation_failed' and ${inRange("created_at", ctx.cur)} and failure_reason is not null group by 1 order by count(*) desc limit 1`);
    const eid = why?.reason ? ctx.untrusted("error", `draft generation: ${why.reason}`) : null;
    p.findings.push({ severity: "medium", title: `${failed} AI drafts failed to generate`, detail: eid ? `Most common reason ${eid}.` : "No reason recorded.", impact: "Planned articles and improvements are late.", evidence: [p.kpis[4]!.id, ...(eid ? [eid] : [])], confirmed: !!eid });
  }
  if (pubCur === 0 && ctx.range.days >= 14) p.findings.push({ severity: "medium", title: "Nothing was published in the period", detail: `No post went live in ${ctx.range.days} days.`, impact: "A publication without new content loses search freshness and returning readers.", evidence: [p.kpis[0]!.id], confirmed: true });
  return p;
};

export const editorial: Builder = async (ctx) => {
  const p = empty();
  const today = istToday();
  const [r] = await q(ctx, sql`
    select count(*) filter (where c.status not in ('dropped'))::int as open_total,
      count(*) filter (where ${inRange("c.created_at", ctx.cur)})::int as added,
      count(*) filter (where c.target_date between ${ctx.range.start} and ${ctx.range.end} and c.status <> 'dropped')::int as planned,
      count(*) filter (where ${inRange("c.published_at", ctx.cur)})::int as published,
      count(*) filter (where c.target_date < ${today} and c.status not in ('published', 'dropped') and p.status is distinct from 'scheduled' and p.status is distinct from 'published')::int as overdue,
      count(*) filter (where c.target_date is null and c.status not in ('published', 'dropped'))::int as unscheduled
    from seo_editorial_calendar c left join post p on p.id = c.post_id and p.deleted_at is null`).catch(() => [undefined]);
  if (!r) {
    p.note = "The editorial calendar is not available.";
    return p;
  }
  p.rows.calendar = int(r.added) + int(r.planned);
  p.kpis.push(kpi(ctx, "Ideas added", int(r.added), null, "int"), kpi(ctx, "Planned for these dates", int(r.planned), null, "int"), kpi(ctx, "Published from the calendar", int(r.published), null, "int", "up"), kpi(ctx, "Past their date, not scheduled (now)", int(r.overdue), null, "int", "down"), kpi(ctx, "Waiting without a date (now)", int(r.unscheduled), null, "int"));
  const late = await q(ctx, sql`
    select c.title, c.target_date::text as date, c.status, case when c.post_id is null then 'no draft' when p.status = 'draft' then 'draft not scheduled' else coalesce(p.status, 'no draft') end as draft
    from seo_editorial_calendar c left join post p on p.id = c.post_id and p.deleted_at is null
    where c.target_date < ${today} and c.status not in ('published', 'dropped') and p.status is distinct from 'scheduled' and p.status is distinct from 'published' order by c.target_date limit 20`);
  if (late.length) {
    const lt = table(ctx, "Past their date", [{ key: "title", label: "Item", width: 0.55 }, { key: "date", label: "Date" }, { key: "draft", label: "Draft" }], late.map((l) => ({ title: String(l.title), date: String(l.date), draft: String(l.draft) })));
    p.tables.push(lt);
    p.findings.push({ severity: late.length >= 3 ? "medium" : "low", title: `${int(r.overdue)} calendar item(s) are past their date and not scheduled`, detail: `${late.filter((l) => l.draft === "no draft").length} have no draft; ${late.filter((l) => l.draft !== "no draft").length} have a draft that is not scheduled.`, impact: "The publishing plan has slipped; System status shows the editorial calendar as degraded.", evidence: [p.kpis[3]!.id, lt.id], confirmed: true, owner: "Posts → Editorial calendar" });
  }
  const bySource = await q(ctx, sql`select coalesce(brief->>'source', kind) as source, count(*)::int as n from seo_editorial_calendar where ${inRange("created_at", ctx.cur)} group by 1 order by 2 desc`);
  if (bySource.length) p.tables.push(table(ctx, "Ideas added by source", [{ key: "source", label: "Source" }, { key: "n", label: "Ideas", format: "int" }], bySource.map((s) => ({ source: String(s.source), n: int(s.n) }))));
  const ideas = await q(ctx, sql`select status, count(*)::int as n from seo_content_ideas where ${inRange("created_at", ctx.cur)} group by 1 order by 2 desc`).catch(() => null);
  p.rows.content_ideas = ideas?.reduce((n, i) => n + int(i.n), 0) ?? null;
  if (ideas?.length) p.tables.push(table(ctx, "Content ideas by status", [{ key: "status", label: "Status" }, { key: "n", label: "Ideas", format: "int" }], ideas.map((i) => ({ status: String(i.status), n: int(i.n) }))));
  return p;
};

export const quality: Builder = async (ctx) => {
  const p = empty();
  const audits = await q(ctx, sql`select count(*)::int as n, avg(score)::float8 as avg, count(*) filter (where score < 60)::int as low from seo_content_audits where ${inRange("audited_at", ctx.cur)}`).catch(() => null);
  const prevAudits = await q(ctx, sql`select avg(score)::float8 as avg from seo_content_audits where ${inRange("audited_at", ctx.prev)}`).catch(() => null);
  p.rows.audits = audits ? int(audits[0]?.n) : null;
  const flags = await q(ctx, sql`
    select count(*)::int as drafts, coalesce(sum((select count(*) from jsonb_array_elements(case when jsonb_typeof(flags) = 'array' then flags else '[]'::jsonb end) f where f->>'severity' = 'error')), 0)::int as errors
    from seo_drafts where ${inRange("created_at", ctx.cur)}`).catch(() => null);
  p.rows.drafts = flags ? int(flags[0]?.drafts) : null;
  const opts = await q(ctx, sql`select count(*) filter (where status = 'accepted')::int as accepted, count(*) filter (where status = 'rejected')::int as rejected from seo_article_optimizations where ${inRange("decided_at", ctx.cur)}`).catch(() => null);
  p.rows.optimizations = opts ? int(opts[0]?.accepted) + int(opts[0]?.rejected) : null;
  const news = await q(ctx, sql`select count(*)::int as n, count(*) filter (where status = 'failed_quality')::int as failed_quality, count(*) filter (where review_outcome = 'rejected')::int as rejected from news_articles where ${inRange("created_at", ctx.cur)}`).catch(() => null);
  p.rows.news = news ? int(news[0]?.n) : null;
  if (audits) p.kpis.push(kpi(ctx, "Articles audited", int(audits[0]?.n), null, "int"), kpi(ctx, "Average audit score", num(audits[0]?.avg), num(prevAudits?.[0]?.avg), "float", "up"), kpi(ctx, "Articles scoring under 60", int(audits[0]?.low), null, "int", "down"));
  if (flags) p.kpis.push(kpi(ctx, "Fact-check errors in AI drafts", int(flags[0]?.errors), null, "int", "down"));
  if (opts) p.kpis.push(kpi(ctx, "Optimisations accepted", int(opts[0]?.accepted), null, "int", "up"), kpi(ctx, "Optimisations rejected", int(opts[0]?.rejected), null, "int"));
  if (news) p.kpis.push(kpi(ctx, "Content flow articles failing quality gates", int(news[0]?.failed_quality), null, "int", "down"));
  const low = await q(ctx, sql`select coalesce(p.title, a.article_id::text) as title, a.score from seo_content_audits a left join post p on p.id = a.article_id where ${inRange("a.audited_at", ctx.cur)} order by a.score asc limit 10`).catch(() => []);
  if (low.length) p.tables.push(table(ctx, "Lowest audit scores", [{ key: "title", label: "Article", width: 0.7 }, { key: "score", label: "Score", format: "float" }], low.map((l) => ({ title: String(l.title), score: num(l.score) }))));
  const reasons = await q(ctx, sql`select coalesce(reject_category, 'other') as category, count(*)::int as n from news_articles where ${inRange("created_at", ctx.cur)} and (review_outcome = 'rejected' or status = 'failed_quality') group by 1 order by 2 desc limit 8`).catch(() => []);
  if (reasons.length) p.tables.push(table(ctx, "Why content flow articles were rejected", [{ key: "category", label: "Reason" }, { key: "n", label: "Articles", format: "int" }], reasons.map((r) => ({ category: String(r.category), n: int(r.n) }))));
  if (flags && int(flags[0]?.errors) >= 3) p.findings.push({ severity: "medium", title: `AI drafts carry ${int(flags[0]?.errors)} fact-check errors`, detail: "Errors the SEO agent flagged in drafts it wrote; each blocks scheduling until fixed.", impact: "Review time, and a risk of publishing a wrong claim if a flag is dismissed.", evidence: [p.kpis.find((k) => k.label === "Fact-check errors in AI drafts")!.id], confirmed: true, owner: "Editorial crew" });
  if (audits && int(audits[0]?.low) >= 3) p.findings.push({ severity: "low", title: `${int(audits[0]?.low)} audited articles score under 60`, detail: "See the lowest scores.", impact: "Weak articles rank and convert worse.", evidence: [p.kpis[2]!.id], confirmed: true });
  if (!p.kpis.length) p.note = "No quality data for these dates.";
  return p;
};

// --- RAG and knowledge, technical health, operations, business -----------------------------------------------------------

export const rag: Builder = async (ctx) => {
  const p = empty();
  const chunks = await q(ctx, sql`select count(*)::int as chunks, count(distinct article_id)::int as articles, count(distinct model)::int as models, max(updated_at)::text as updated, string_agg(distinct model, ', ') as model_names from seo_article_chunks`).catch(() => null);
  p.rows.chunks = chunks ? int(chunks[0]?.chunks) : null;
  if (chunks) p.kpis.push(kpi(ctx, "Articles indexed", int(chunks[0]?.articles), null, "int"), kpi(ctx, "Chunks indexed", int(chunks[0]?.chunks), null, "int"));
  if (chunks && int(chunks[0]?.models) > 1) p.findings.push({ severity: "medium", title: `The article index mixes ${int(chunks[0]?.models)} embedding models`, detail: `Models: ${String(chunks[0]?.model_names ?? "")}. Vectors of different models are not comparable.`, impact: "Retrieval for Ask the Blog and the crews misses or misranks articles until everything is re-embedded (Reindex).", evidence: [p.kpis[1]!.id], confirmed: true, owner: "reindex_flow" });
  const ask = async (b: { from: string; to: string }) => (await q(ctx, sql`select count(*)::int as n, count(*) filter (where outcome = 'answered')::int as answered, count(*) filter (where cached)::int as cached, coalesce(sum(cost_usd), 0)::float8 as cost, count(*) filter (where feedback > 0)::int as up, count(*) filter (where feedback < 0)::int as down from seo_ask_log where ${inRange("at", b)}`).catch(() => [null]))[0];
  const [a, ap] = await Promise.all([ask(ctx.cur), ask(ctx.prev)]);
  p.rows.ask = a ? int(a.n) : null;
  if (a) {
    p.kpis.push(kpi(ctx, "Questions asked (Ask the Blog)", int(a.n), ap ? int(ap.n) : null, "int", "up"), kpi(ctx, "Answered share", ratio(int(a.answered), int(a.n) || null), ap ? ratio(int(ap.answered), int(ap.n) || null) : null, "pct", "up"), kpi(ctx, "Ask the Blog cost", num(a.cost), ap ? num(ap.cost) : null, "usd", "down"), kpi(ctx, "Helpful / not helpful", int(a.up), null, "int", "up", `${int(a.down)} marked not helpful`));
    const outcomes = await q(ctx, sql`select outcome, count(*)::int as n from seo_ask_log where ${inRange("at", ctx.cur)} group by 1 order by 2 desc`);
    if (outcomes.length) p.tables.push(table(ctx, "Ask the Blog outcomes", [{ key: "outcome", label: "Outcome" }, { key: "n", label: "Questions", format: "int" }], outcomes.map((o) => ({ outcome: String(o.outcome), n: int(o.n) }))));
    const share = ratio(int(a.answered), int(a.n) || null);
    if (int(a.n) >= 20 && share !== null && share < 0.7) p.findings.push({ severity: "medium", title: `Ask the Blog answered ${fmt(share, "pct")} of questions`, detail: `${int(a.n) - int(a.answered)} of ${int(a.n)} questions got no answer.`, impact: "Readers leave without an answer; those questions are article ideas (Ask the Blog gaps).", evidence: [p.kpis.find((k) => k.label === "Answered share")!.id], confirmed: false });
  }
  const gaps = await q(ctx, sql`select sample_question as question, asked, status from seo_ask_gaps where status <> 'dismissed' order by asked desc limit 10`).catch(() => []);
  if (gaps.length) p.tables.push(table(ctx, "Unanswered questions asked most", [{ key: "question", label: "Question", width: 0.7 }, { key: "asked", label: "Asked", format: "int" }, { key: "status", label: "Status" }], gaps.map((g) => ({ question: String(g.question), asked: int(g.asked), status: String(g.status) }))));
  const evalRun = await q(ctx, sql`select at::text as at, config, metrics from seo_rag_eval_runs order by at desc limit 1`).catch(() => null);
  p.rows.rag_eval = evalRun?.length ?? null;
  if (evalRun?.[0]) {
    const m = (typeof evalRun[0].metrics === "string" ? JSON.parse(String(evalRun[0].metrics)) : evalRun[0].metrics) as Record<string, unknown>;
    const rows = Object.entries(m ?? {}).filter(([, v]) => typeof v === "number").slice(0, 12).map(([k, v]) => ({ metric: k, value: v as number }));
    if (rows.length) p.tables.push(table(ctx, `Latest retrieval evaluation (${String(evalRun[0].at).slice(0, 10)}, ${String(evalRun[0].config)})`, [{ key: "metric", label: "Metric" }, { key: "value", label: "Value", format: "float" }], rows));
  }
  const models = await q(ctx, sql`select kind, version, trained_at::text as trained, beats_rule from seo_ml_models where active order by kind`).catch(() => null);
  p.rows.ml_models = models?.length ?? null;
  if (models?.length) p.tables.push(table(ctx, "Active ML models", [{ key: "kind", label: "Model" }, { key: "version", label: "Version" }, { key: "trained", label: "Trained" }, { key: "beats", label: "Beats the rules" }], models.map((m) => ({ kind: String(m.kind), version: String(m.version), trained: String(m.trained).slice(0, 10), beats: m.beats_rule === null ? "–" : m.beats_rule ? "yes" : "no" }))));
  return p;
};

export const technical: Builder = async (ctx) => {
  const p = empty();
  const [scan] = await q(ctx, sql`select id, started_at::text as at, pages_crawled from seo_technical_scans where status = 'succeeded' and started_at < ${ctx.cur.to} order by started_at desc limit 1`).catch(() => [undefined]);
  p.rows.tech_scans = scan ? 1 : 0;
  if (scan) {
    const inPeriod = String(scan.at) >= ctx.cur.from.slice(0, 10);
    const issues = await q(ctx, sql`select check_key, severity, count(*)::int as n from seo_technical_issues where scan_id = ${String(scan.id)} group by 1, 2 order by (severity = 'error') desc, 3 desc limit 15`);
    const errors = issues.filter((i) => i.severity === "error").reduce((n, i) => n + int(i.n), 0);
    const warnings = issues.filter((i) => i.severity === "warning").reduce((n, i) => n + int(i.n), 0);
    p.kpis.push(kpi(ctx, "Pages crawled (latest crawl)", int(scan.pages_crawled), null, "int"), kpi(ctx, "Crawl errors", errors, null, "int", "down"), kpi(ctx, "Crawl warnings", warnings, null, "int", "down"));
    const it = table(ctx, `Issues in the crawl of ${String(scan.at).slice(0, 10)}`, [{ key: "check", label: "Check", width: 0.5 }, { key: "severity", label: "Severity" }, { key: "n", label: "Pages", format: "int" }], issues.map((i) => ({ check: String(i.check_key), severity: String(i.severity), n: int(i.n) })), inPeriod ? undefined : "The latest crawl is older than this report's dates.");
    p.tables.push(it);
    if (errors) p.findings.push({ severity: errors >= 10 ? "high" : "medium", title: `The latest crawl found ${errors} error(s)`, detail: `Most frequent: ${issues.filter((i) => i.severity === "error").slice(0, 3).map((i) => `${String(i.check_key)} (${int(i.n)})`).join(", ")}.`, impact: "Errors such as broken pages, missing canonicals or noindex mistakes stop pages from ranking.", evidence: [it.id], confirmed: true, owner: "AI & SEO → Technical" });
  } else p.note = "No technical crawl has finished yet.";
  const links = await q(ctx, sql`select count(*) filter (where status in ('broken', 'error'))::int as broken, count(*)::int as total from seo_link_checks`).catch(() => null);
  p.rows.links = links ? int(links[0]?.total) : null;
  if (links) {
    p.kpis.push(kpi(ctx, "Broken links (now)", int(links[0]?.broken), null, "int", "down"));
    if (int(links[0]?.broken)) {
      const list = await q(ctx, sql`select url, http_status, failures from seo_link_checks where status in ('broken', 'error') order by failures desc limit 10`);
      const lt = table(ctx, "Broken links", [{ key: "url", label: "URL", width: 0.7 }, { key: "http_status", label: "HTTP" }, { key: "failures", label: "Failures", format: "int" }], list.map((l) => ({ url: String(l.url), http_status: num(l.http_status), failures: int(l.failures) })));
      p.tables.push(lt);
      p.findings.push({ severity: "medium", title: `${int(links[0]?.broken)} broken link(s)`, detail: "Links in articles that answer with an error.", impact: "Readers and crawlers hit dead ends.", evidence: [lt.id], confirmed: true, owner: "AI & SEO → Links" });
    }
  }
  const subs = await q(ctx, sql`select engine, status, count(*)::int as n from seo_search_submissions where ${inRange("requested_at", ctx.cur)} group by 1, 2 order by 1, 3 desc`).catch(() => null);
  p.rows.submissions = subs?.reduce((n, s) => n + int(s.n), 0) ?? null;
  if (subs?.length) p.tables.push(table(ctx, "Search-engine submissions", [{ key: "engine", label: "Engine" }, { key: "status", label: "Status" }, { key: "n", label: "URLs", format: "int" }], subs.map((s) => ({ engine: String(s.engine), status: String(s.status), n: int(s.n) }))));
  return p;
};

export const operations: Builder = async (ctx) => {
  const p = empty();
  const [queue] = await q(ctx, sql`select count(*) filter (where status = 'queued')::int as queued, (extract(epoch from now() - min(created_at) filter (where status = 'queued')) / 60)::int as oldest, count(*) filter (where status = 'failed' and ${inRange("created_at", ctx.cur)})::int as failed, count(*) filter (where ${inRange("created_at", ctx.cur)})::int as total from job`).catch(() => [undefined]);
  p.rows.jobs = queue ? int(queue.total) : null;
  if (queue) p.kpis.push(kpi(ctx, "Background jobs run", int(queue.total), null, "int"), kpi(ctx, "Background jobs failed", int(queue.failed), null, "int", "down"), kpi(ctx, "Jobs waiting (now)", int(queue.queued), null, "int", "down", queue.oldest ? `oldest waiting ${int(queue.oldest)} min` : undefined));
  const syncs = await q(ctx, sql`select job_type as type, count(*)::int as n, count(*) filter (where status = 'succeeded')::int as ok, max(finished_at) filter (where status = 'succeeded')::text as last_ok from seo_sync_jobs where ${inRange("started_at", ctx.cur)} group by 1 order by 1`).catch(() => null);
  p.rows.sync_jobs = syncs?.reduce((n, s) => n + int(s.n), 0) ?? null;
  if (syncs?.length) p.tables.push(table(ctx, "Data syncs", [{ key: "type", label: "Sync" }, { key: "n", label: "Runs", format: "int" }, { key: "ok", label: "Succeeded", format: "int" }, { key: "last_ok", label: "Last success" }], syncs.map((s) => ({ type: String(s.type), n: int(s.n), ok: int(s.ok), last_ok: s.last_ok ? String(s.last_ok).slice(0, 16) : "–" }))));
  const backups = await q(ctx, sql`select status, count(*)::int as n, max(started_at)::text as last from backup_run where operation = 'backup' and ${inRange("started_at", ctx.cur)} group by 1`).catch(() => null);
  p.rows.backups = backups?.reduce((n, b) => n + int(b.n), 0) ?? null;
  if (backups) {
    const ok = backups.filter((b) => ["succeeded", "success", "done", "completed"].includes(String(b.status))).reduce((n, b) => n + int(b.n), 0);
    const all = backups.reduce((n, b) => n + int(b.n), 0);
    p.kpis.push(kpi(ctx, "Backups that succeeded", ok, null, "int", "up", `${all} backup run(s) in the period`));
    if (ctx.range.days >= 7 && ok === 0) p.findings.push({ severity: "medium", title: "No successful backup in the period", detail: `${all} backup run(s), none succeeded.`, impact: "A data loss now could not be restored from a recent copy.", evidence: [p.kpis.at(-1)!.id], confirmed: true, owner: "Tools → Backups" });
  }
  // The live system checks (Site health), as they are when the report is built.
  try {
    const { systemChecks } = await import("../health");
    const { checks } = await Promise.race([systemChecks(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timed out")), 20_000))]);
    p.rows.health = checks.length;
    const ct = table(ctx, "System checks when the report was built", [{ key: "name", label: "Check", width: 0.28 }, { key: "group", label: "Group" }, { key: "status", label: "Status" }, { key: "detail", label: "Detail", width: 0.42 }], checks.map((c) => ({ name: c.name, group: c.group, status: c.status, detail: c.detail })));
    p.tables.push(ct);
    const bad = checks.filter((c) => c.status === "down" || c.status === "degraded");
    p.kpis.push(kpi(ctx, "System checks down or degraded (now)", bad.length, null, "int", "down"));
    for (const c of bad) {
      const eid = ctx.untrusted("log", `system check ${c.name}: ${c.status}: ${c.detail}`);
      p.findings.push({ severity: c.status === "down" ? "high" : "medium", title: `System check “${c.name}” is ${c.status}`, detail: `As reported: ${eid}.`, impact: c.status === "down" ? "That part of the site does not work." : "That part of the site works with problems.", evidence: [ct.id, eid], confirmed: true, owner: c.href ?? c.env ?? null });
    }
  } catch (e) {
    p.rows.health = null;
    p.note = `System checks could not run: ${(e as Error).message}`;
  }
  return p;
};

export const business: Builder = async (ctx) => {
  const p = empty();
  const count = async (query: SQL) => (await q<{ n: number }>(ctx, query).catch(() => null))?.[0]?.n ?? null;
  const users = await count(sql`select count(*)::int as n from "user" where ${inRange("created_at", ctx.cur)}`);
  const usersPrev = await count(sql`select count(*)::int as n from "user" where ${inRange("created_at", ctx.prev)}`);
  const comments = await count(sql`select count(*)::int as n from comment where deleted_at is null and ${inRange("created_at", ctx.cur)}`);
  const messages = await count(sql`select count(*)::int as n from contact_message where ${inRange("created_at", ctx.cur)}`);
  const bookings = await count(sql`select count(*)::int as n from cal_booking where ${inRange("created_at", ctx.cur)}`);
  Object.assign(p.rows, { users, comments, messages, bookings });
  p.kpis.push(kpi(ctx, "New users", users, usersPrev, "int", "up"), kpi(ctx, "Comments", comments, null, "int", "up"), kpi(ctx, "Contact messages", messages, null, "int", "up"), kpi(ctx, "Bookings", bookings, null, "int", "up"));
  const money = await q(ctx, sql`
    select currency, count(*) filter (where ${inRange("created_at", ctx.cur)})::int as issued, count(*) filter (where ${inRange("paid_at", ctx.cur)})::int as paid, coalesce(sum(total) filter (where ${inRange("paid_at", ctx.cur)}), 0)::float8 as paid_minor
    from invoice where voided_at is null group by 1
    union all
    select currency, 0, count(*) filter (where status = 'paid' and ${inRange("paid_at", ctx.cur)})::int, coalesce(sum(amount) filter (where status = 'paid' and ${inRange("paid_at", ctx.cur)}), 0)::float8 from hire_payment group by 1`).catch(() => null);
  p.rows.invoices = money?.reduce((n, m) => n + int(m.issued) + int(m.paid), 0) ?? null;
  const paid = (money ?? []).filter((m) => int(m.paid) || int(m.issued));
  if (paid.length) p.tables.push(table(ctx, "Invoices and payments", [{ key: "currency", label: "Currency" }, { key: "issued", label: "Invoices issued", format: "int" }, { key: "paid", label: "Paid", format: "int" }, { key: "amount", label: "Amount paid", format: "float" }], paid.map((m) => ({ currency: String(m.currency), issued: int(m.issued), paid: int(m.paid), amount: (num(m.paid_minor) ?? 0) / 100 })), "Amounts in each currency (not converted)."));
  return p;
};

export const BUILDERS: Record<string, Builder> = { crewai, seo, traffic, search, content, editorial, quality, ai_usage: aiUsage, llm_cost: llmCost, reliability, agents, rag, technical, operations, business };
