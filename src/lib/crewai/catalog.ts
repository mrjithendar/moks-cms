import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/posts";
import { AgentError, crewAsSpec, validateCustomSpec, type AgentCrew, type AgentDeps, type AgentFlow } from "@/lib/seo-agent/client";
import { CatalogError, filterQuery, parseFilter, type CatalogFilter, type CatalogItem, type CatalogKind, type CatalogPage, type Category } from "./catalog-shared";

export { CatalogError, filterQuery, parseFilter };
export type { CatalogFilter, CatalogItem, CatalogKind, CatalogPage, Category };

/**
 * The one catalogue of crews and flows (migration 0041, D-100). Every crew and every flow is a row with the same
 * lifecycle: create, edit, duplicate, switch off, delete (kept, restorable) and restore; categories and tags organise
 * them. Nothing here, or in the agent, decides how a crew or flow runs from its categories.
 *
 * Where a row's work is defined (`definition`) decides only how it is edited and run, never whether it can be:
 * - crews: "code" (the agent's own crews: their prompts, models and tools are versions in seo_crew_configs, lib/crewai/crews.ts),
 *   "spec" (made or duplicated here: the spec is checked by the agent, POST /custom/validate, before every save);
 * - flows: "code" (a flow of the agent: switched off here, the agent refuses to start it, GET /flow-switches), "spec" (steps
 *   run by the agent's flow engine, custom_flow), "content" (a content flow: settings in news_jobs, synced by a trigger).
 * Run statistics come from seo_flow_runs: a code flow's runs by name, a spec flow's custom_flow runs by their target
 * (custom:<key>), a content flow's news_job_flow runs by theirs (job:<id>); a crew's are the runs of the flows that run it.
 */

const TABLE = { crew: sql.raw('"crewai_crews"'), flow: sql.raw('"crewai_flows"') } as const;
const KEY = /^[a-z][a-z0-9_]{1,39}$/;
const RESERVED = new Set(["new", "categories", "content", "custom", "validate", "test"]);
/** Agent flows that run other rows (each spec and content flow is its own row) or are started from a crew's page. */
export const RUNNER_FLOWS: readonly string[] = ["custom_flow", "news_job_flow", "crew_test_flow"];
const TAG = /^[a-z0-9][a-z0-9 ._-]{0,39}$/;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const asObject = (v: unknown): Record<string, unknown> | null => (v == null ? null : typeof v === "string" ? (JSON.parse(v) as Record<string, unknown>) : (v as Record<string, unknown>));
const asArray = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.replace(/^\{|\}$/g, "").split(",").filter(Boolean).map((x) => x.replace(/^"|"$/g, "")) : []);
const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));
const pgArray = (list: string[]) => sql`${`{${list.map((x) => `"${x.replace(/["\\]/g, "")}"`).join(",")}}`}::text[]`;

function toItem(kind: CatalogKind, r: Record<string, unknown>): CatalogItem {
  const last = asObject(r.last_run);
  return {
    kind,
    key: String(r.key),
    label: String(r.label),
    description: String(r.description ?? ""),
    objective: String(r.objective ?? ""),
    categories: asArray(r.categories),
    tags: asArray(r.tags),
    enabled: Boolean(r.enabled),
    disabledReason: (r.disabled_reason as string | null) ?? null,
    definition: String(r.definition) as CatalogItem["definition"],
    flowName: (r.flow_name as string | null) ?? null,
    start: (r.start as string | null) ?? null,
    contentJobId: r.content_job_id ? String(r.content_job_id) : null,
    spec: asObject(r.spec),
    crews: asArray(r.crews),
    version: Number(r.version ?? 1),
    createdAt: iso(r.created_at) ?? "",
    createdBy: (r.created_by as string | null) ?? null,
    updatedAt: iso(r.updated_at) ?? "",
    updatedBy: (r.updated_by as string | null) ?? null,
    deletedAt: iso(r.deleted_at),
    runs: {
      total: Number(r.runs_total ?? 0),
      running: Number(r.runs_running ?? 0),
      last: last && last.runId ? { runId: String(last.runId), status: String(last.status), number: last.number == null ? null : Number(last.number), startedAt: String(last.startedAt) } : null,
    },
  };
}

// --- run statistics ----------------------------------------------------------------------------------------------------

/** Per flow key: runs, runs active now, and the last run. One pass over seo_flow_runs. */
const FLOW_RUNS = sql`
  flow_runs as (
    select f.key,
      count(x.run_id)::int as runs_total,
      (count(x.run_id) filter (where x.status in ('queued', 'running')))::int as runs_running,
      (array_agg(json_build_object('runId', x.run_id, 'status', x.status, 'number', x.run_number, 'startedAt', x.started_at) order by x.started_at desc) filter (where x.run_id is not null))[1] as last_run
    from crewai_flows f
    left join seo_flow_runs x on (
      (f.definition = 'code' and x.flow_name = f.flow_name)
      or (f.definition = 'spec' and x.flow_name = 'custom_flow' and x.target_id = 'custom:' || f.key)
      or (f.definition = 'content' and x.flow_name = 'news_job_flow' and x.target_id = 'job:' || f.content_job_id::text))
    group by f.key)`;

/** Per crew key: the runs of the flows that run it. */
const CREW_RUNS = sql`
  crew_runs as (
    select c.key,
      coalesce(sum(fr.runs_total), 0)::int as runs_total,
      coalesce(sum(fr.runs_running), 0)::int as runs_running,
      (array_agg(fr.last_run order by (fr.last_run->>'startedAt') desc nulls last) filter (where fr.last_run is not null))[1] as last_run
    from crewai_crews c
    left join crewai_flows f on c.key = any(f.crews) and f.deleted_at is null
    left join flow_runs fr on fr.key = f.key
    group by c.key)`;

// --- listing -------------------------------------------------------------------------------------------------------------

const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

function where(kind: CatalogKind, f: CatalogFilter, opts: { facets?: boolean } = {}): SQL {
  const parts: SQL[] = [];
  const status = f.status ?? "active";
  if (status === "deleted") parts.push(sql`t.deleted_at is not null`);
  else if (status !== "all") parts.push(sql`t.deleted_at is null`);
  if (status === "enabled") parts.push(sql`t.enabled`);
  if (status === "disabled") parts.push(sql`not t.enabled`);
  if (f.q) {
    const q = like(f.q.trim());
    parts.push(sql`(t.label ilike ${q} or t.description ilike ${q} or t.key ilike ${q} or array_to_string(t.tags, ' ') ilike ${q}${kind === "crew" ? sql` or t.objective ilike ${q}` : sql``})`);
  }
  if (!opts.facets && f.categories?.length) parts.push(sql`t.categories && ${pgArray(f.categories)}`);
  if (!opts.facets && f.tags?.length) parts.push(sql`t.tags && ${pgArray(f.tags)}`);
  if (f.definition) parts.push(sql`t.definition = ${f.definition}`);
  if (f.recent) {
    const [field, days] = f.recent.split("_") as ["created" | "updated", string];
    const col = field === "created" ? sql`t.created_at` : sql`t.updated_at`;
    parts.push(sql`${col} > now() - ${`${Number.parseInt(days, 10)} days`}::interval`);
  }
  if (f.run === "never") parts.push(sql`coalesce(s.runs_total, 0) = 0`);
  if (f.run === "running") parts.push(sql`coalesce(s.runs_running, 0) > 0`);
  if (f.run === "succeeded" || f.run === "failed") parts.push(sql`s.last_run->>'status' = ${f.run}`);
  return parts.length ? sql.join(parts, sql` and `) : sql`true`;
}

const ORDER: Record<NonNullable<CatalogFilter["sort"]>, SQL> = {
  name: sql`lower(t.label)`,
  created: sql`t.created_at`,
  updated: sql`t.updated_at`,
  runs: sql`coalesce(s.runs_total, 0)`,
};

/** One page of crews or flows matching `f`, the total, and how many match each category and tag. */
export async function listCatalog(kind: CatalogKind, f: CatalogFilter = {}, db?: Db): Promise<CatalogPage> {
  const d = db ?? (await getDb());
  const page = Math.max(1, f.page ?? 1);
  const size = Math.min(100, Math.max(1, f.pageSize ?? 25));
  const stats = kind === "crew" ? sql`with ${FLOW_RUNS}, ${CREW_RUNS}` : sql`with ${FLOW_RUNS}`;
  const join = kind === "crew" ? sql`left join crew_runs s on s.key = t.key` : sql`left join flow_runs s on s.key = t.key`;
  const dir = f.dir === "asc" || (f.dir == null && (f.sort ?? "name") === "name") ? sql`asc` : sql`desc`;
  const order = ORDER[f.sort ?? "name"];
  const rows = rowsOf<Record<string, unknown>>(
    await d.execute(sql`${stats}
      select t.*, s.runs_total, s.runs_running, s.last_run, count(*) over () as total_rows
      from ${TABLE[kind]} t ${join}
      where ${where(kind, f)}
      order by ${order} ${dir}, t.key asc
      limit ${size} offset ${(page - 1) * size}`),
  );
  let total = Number(rows[0]?.total_rows ?? 0);
  if (rows.length === 0 && page > 1) {
    const [n] = rowsOf<{ n: number }>(await d.execute(sql`${stats} select count(*)::int as n from ${TABLE[kind]} t ${join} where ${where(kind, f)}`));
    total = Number(n?.n ?? 0);
  }
  const facetRows = rowsOf<{ kind: string; value: string; n: number }>(
    await d.execute(sql`${stats}
      select 'category' as kind, c as value, count(*)::int as n from ${TABLE[kind]} t ${join}, unnest(t.categories) c where ${where(kind, f, { facets: true })} group by c
      union all
      select 'tag' as kind, g as value, count(*)::int as n from ${TABLE[kind]} t ${join}, unnest(t.tags) g where ${where(kind, f, { facets: true })} group by g`),
  );
  return {
    items: rows.map((r) => toItem(kind, r)),
    total,
    page,
    pageSize: size,
    facets: {
      categories: facetRows.filter((r) => r.kind === "category").map((r) => ({ value: r.value, n: Number(r.n) })),
      tags: facetRows.filter((r) => r.kind === "tag").map((r) => ({ value: r.value, n: Number(r.n) })).sort((a, b) => b.n - a.n || a.value.localeCompare(b.value)),
    },
  };
}

/** One crew or flow (deleted ones too), with its run statistics. */
export async function getItem(kind: CatalogKind, key: string, db?: Db): Promise<CatalogItem | null> {
  if (!KEY.test(key)) return null;
  const d = db ?? (await getDb());
  const stats = kind === "crew" ? sql`with ${FLOW_RUNS}, ${CREW_RUNS}` : sql`with ${FLOW_RUNS}`;
  const join = kind === "crew" ? sql`left join crew_runs s on s.key = t.key` : sql`left join flow_runs s on s.key = t.key`;
  const [r] = rowsOf<Record<string, unknown>>(await d.execute(sql`${stats} select t.*, s.runs_total, s.runs_running, s.last_run from ${TABLE[kind]} t ${join} where t.key = ${key}`));
  return r ? toItem(kind, r) : null;
}

/** Every crew or flow that is not deleted (no statistics): pickers, the agent's callbacks. */
export async function allItems(kind: CatalogKind, db?: Db): Promise<CatalogItem[]> {
  const d = db ?? (await getDb());
  return rowsOf<Record<string, unknown>>(await d.execute(sql`select t.* from ${TABLE[kind]} t where t.deleted_at is null order by lower(t.label), t.key`)).map((r) => toItem(kind, r));
}

/** The content flow row of a news_jobs row. */
export async function contentFlowOf(jobId: string, db?: Db): Promise<CatalogItem | null> {
  const d = db ?? (await getDb());
  const [r] = rowsOf<Record<string, unknown>>(await d.execute(sql`select * from crewai_flows where content_job_id = ${jobId}::uuid`));
  return r ? toItem("flow", r) : null;
}

// --- checks ----------------------------------------------------------------------------------------------------------------

async function cleanCategories(d: Db, list: unknown): Promise<string[]> {
  if (list == null) return [];
  if (!Array.isArray(list)) throw new CatalogError("Categories are a list.", 400);
  const slugs = [...new Set(list.map((x) => String(x).trim()).filter(Boolean))];
  if (slugs.length > 10) throw new CatalogError("At most 10 categories.", 400);
  if (slugs.length === 0) return [];
  const known = new Set(rowsOf<{ slug: string }>(await d.execute(sql`select slug from crewai_categories where slug = any(${pgArray(slugs)})`)).map((r) => r.slug));
  const unknown = slugs.filter((s) => !known.has(s));
  if (unknown.length) throw new CatalogError(`Unknown categories: ${unknown.join(", ")}. Add them under Categories first.`, 400);
  return slugs;
}

export function cleanTags(list: unknown): string[] {
  if (list == null) return [];
  if (!Array.isArray(list)) throw new CatalogError("Tags are a list.", 400);
  const tags = [...new Set(list.map((x) => String(x).trim().toLowerCase()).filter(Boolean))];
  const bad = tags.filter((t) => !TAG.test(t));
  if (bad.length) throw new CatalogError(`A tag is 1–40 lower-case letters, digits, spaces or . _ -: ${bad.join(", ")}`, 400);
  if (tags.length > 20) throw new CatalogError("At most 20 tags.", 400);
  return tags;
}

const text = (v: unknown, max: number, what: string): string => {
  const s = v == null ? "" : String(v).trim();
  if (s.length > max) throw new CatalogError(`${what} is at most ${max} characters.`, 400);
  return s;
};

function label(v: unknown): string {
  const s = text(v, 120, "The name");
  if (s.length < 2) throw new CatalogError("The name is 2–120 characters.", 400);
  return s;
}

function newKey(v: unknown): string {
  const key = String(v ?? "").trim();
  if (!KEY.test(key)) throw new CatalogError("The key is 2–40 lower-case letters, digits or _ and starts with a letter.", 400);
  if (RESERVED.has(key)) throw new CatalogError(`${key} is reserved; pick another key.`, 400);
  return key;
}

/** The crews a spec flow's steps run. */
export function crewsOfSpec(spec: Record<string, unknown> | null): string[] {
  const steps = (spec?.steps as { kind?: string; crew?: string }[] | undefined) ?? [];
  return [...new Set(steps.filter((s) => s.kind === "crew" && s.crew).map((s) => String(s.crew)))];
}

/** The agent checks a spec; its refusals come back as issues (422), its absence as 503. `extraCrews`: crews a flow may
 * name besides the spec crews that are on (a crew draft under test). Crews defined in code are always known to it. */
async function check(kind: CatalogKind, spec: Record<string, unknown>, d: Db, deps: AgentDeps, extraCrews: string[] = []): Promise<Record<string, unknown>> {
  const crews = kind === "flow" ? [...(await allItems("crew", d)).filter((c) => c.enabled && c.definition === "spec").map((c) => c.key), ...extraCrews] : undefined;
  try {
    return (await validateCustomSpec(kind, spec, crews, deps)).spec;
  } catch (e) {
    if (e instanceof AgentError && e.status === 422) throw new CatalogError("The SEO agent refused this spec.", 422, e.issues);
    if (e instanceof AgentError) throw new CatalogError(`${e.message} A ${kind} spec is checked by the SEO agent before it is saved.`, 503);
    throw e;
  }
}

/** The agent's check of a spec, without saving it (Check, and a test run of a draft). */
export async function checkSpec(kind: CatalogKind, spec: Record<string, unknown>, extraCrews: string[] = [], deps: AgentDeps = {}): Promise<Record<string, unknown>> {
  return check(kind, spec, await getDb(), deps, extraCrews);
}

async function addVersion(d: Db, kind: CatalogKind, key: string, version: number, spec: Record<string, unknown>, actor: Actor, note: string) {
  await d.execute(sql`insert into crewai_spec_versions (kind, key, version, spec, note, created_by) values (${kind}, ${key}, ${version}, ${JSON.stringify(spec)}::jsonb, ${note.slice(0, 500)}, ${actor.label})
    on conflict (kind, key, version) do update set spec = excluded.spec, note = excluded.note, created_at = now(), created_by = excluded.created_by`);
}

/** Flows (not deleted) that run this crew; `enabledOnly`: only those switched on. */
export async function flowsUsing(crew: string, opts: { enabledOnly?: boolean } = {}, db?: Db): Promise<CatalogItem[]> {
  return (await allItems("flow", db)).filter((f) => f.crews.includes(crew) && (!opts.enabledOnly || f.enabled));
}

// --- create, edit, switch, delete, restore, duplicate ---------------------------------------------------------------------

export type ItemInput = { key?: unknown; label?: unknown; description?: unknown; objective?: unknown; categories?: unknown; tags?: unknown; enabled?: unknown; spec?: unknown; note?: unknown };

/** A new crew or flow defined by a spec (checked by the agent). The key is new for good: deleted rows keep theirs. */
export async function createItem(kind: CatalogKind, actor: Actor, input: ItemInput, deps: AgentDeps = {}): Promise<CatalogItem> {
  const d = await getDb();
  const key = newKey(input.key ?? (input.spec as { key?: unknown } | undefined)?.key);
  const name = label(input.label ?? (input.spec as { label?: unknown } | undefined)?.label);
  const description = text(input.description ?? (input.spec as { description?: unknown } | undefined)?.description, 1000, "The description");
  const objective = kind === "crew" ? text(input.objective, 1500, "The objective") : "";
  const categories = await cleanCategories(d, input.categories);
  const tags = cleanTags(input.tags);
  const raw = asObject(input.spec) ?? {};
  const [exists] = rowsOf<{ deleted: boolean }>(await d.execute(sql`select deleted_at is not null as deleted from ${TABLE[kind]} where key = ${key}`));
  if (exists) throw new CatalogError(exists.deleted ? `A deleted ${kind} used the key ${key}: restore it, or pick another key (its run history keeps the name).` : `There is already a ${kind} ${key}.`, 409);
  const spec = await check(kind, { ...raw, key, label: name, description }, d, deps);
  const enabled = input.enabled === undefined ? true : Boolean(input.enabled);
  if (kind === "crew") {
    await d.execute(sql`insert into crewai_crews (key, label, description, objective, categories, tags, enabled, definition, spec, version, created_by, updated_by)
      values (${key}, ${name}, ${description}, ${objective}, ${pgArray(categories)}, ${pgArray(tags)}, ${enabled}, 'spec', ${JSON.stringify(spec)}::jsonb, 1, ${actor.label}, ${actor.label})`);
  } else {
    await d.execute(sql`insert into crewai_flows (key, label, description, categories, tags, enabled, definition, flow_name, start, spec, crews, version, created_by, updated_by)
      values (${key}, ${name}, ${description}, ${pgArray(categories)}, ${pgArray(tags)}, ${enabled}, 'spec', 'custom_flow', 'manual', ${JSON.stringify(spec)}::jsonb, ${pgArray(crewsOfSpec(spec))}, 1, ${actor.label}, ${actor.label})`);
  }
  await addVersion(d, kind, key, 1, spec, actor, text(input.note, 500, "The note") || "created");
  await audit(actor, `crewai.${kind}.create`, key, { categories, tags });
  return (await getItem(kind, key, d))!;
}

/**
 * Edit any crew or flow: its name, description, objective (crews), categories and tags; and, for one defined by a spec,
 * the spec (checked by the agent; a new version). A code crew's prompts are versions (lib/crewai/crews.ts); a content
 * flow's settings are its own page: their name and description follow to news_jobs.
 */
export async function updateItem(kind: CatalogKind, actor: Actor, key: string, patch: ItemInput, deps: AgentDeps = {}): Promise<CatalogItem> {
  const d = await getDb();
  const cur = await getItem(kind, key, d);
  if (!cur) throw new CatalogError(`No ${kind} ${key}.`, 404);
  if (cur.deletedAt) throw new CatalogError(`The ${kind} ${cur.label} is deleted: restore it first.`, 409);
  const next = {
    label: patch.label === undefined ? cur.label : label(patch.label),
    description: patch.description === undefined ? cur.description : text(patch.description, 1000, "The description"),
    objective: kind === "crew" && patch.objective !== undefined ? text(patch.objective, 1500, "The objective") : cur.objective,
    categories: patch.categories === undefined ? cur.categories : await cleanCategories(d, patch.categories),
    tags: patch.tags === undefined ? cur.tags : cleanTags(patch.tags),
  };
  let spec = cur.spec;
  let version = cur.version;
  if (patch.spec !== undefined) {
    if (cur.definition !== "spec") throw new CatalogError(cur.definition === "code" ? (kind === "crew" ? "This crew's agents and tasks are defined in code: change them as a version in the crew editor." : "This flow's steps are defined in code: duplicate it to build your own steps around it.") : "A content flow's settings are on its settings page.", 400);
    spec = await check(kind, { ...(asObject(patch.spec) ?? {}), key, label: next.label, description: next.description }, d, deps);
    version = cur.version + 1;
    await addVersion(d, kind, key, version, spec, actor, text(patch.note, 500, "The note"));
  } else if (cur.definition === "spec" && spec && (next.label !== cur.label || next.description !== cur.description)) {
    spec = { ...spec, label: next.label, description: next.description }; // the spec carries its name; no new version for a rename
  }
  if (kind === "crew") {
    await d.execute(sql`update crewai_crews set label = ${next.label}, description = ${next.description}, objective = ${next.objective}, categories = ${pgArray(next.categories)}, tags = ${pgArray(next.tags)},
      spec = ${spec ? sql`${JSON.stringify(spec)}::jsonb` : sql`spec`}, version = ${version}, updated_at = now(), updated_by = ${actor.label} where key = ${key}`);
  } else {
    await d.execute(sql`update crewai_flows set label = ${next.label}, description = ${next.description}, categories = ${pgArray(next.categories)}, tags = ${pgArray(next.tags)},
      spec = ${spec ? sql`${JSON.stringify(spec)}::jsonb` : sql`spec`}, crews = ${cur.definition === "spec" ? pgArray(crewsOfSpec(spec)) : sql`crews`}, version = ${version}, updated_at = now(), updated_by = ${actor.label} where key = ${key}`);
    if (cur.definition === "content" && cur.contentJobId && (next.label !== cur.label || next.description !== cur.description)) {
      await d.execute(sql`update news_jobs set name = ${next.label}, description = ${next.description}, updated_at = now() where id = ${cur.contentJobId}::uuid`);
    }
  }
  await audit(actor, `crewai.${kind}.update`, key, { version, spec: patch.spec !== undefined, fields: Object.keys(patch).filter((k) => k !== "spec") });
  return (await getItem(kind, key, d))!;
}

/**
 * Switch a crew or flow on or off. A crew run by a flow that is on cannot be switched off (switch those flows off
 * first); a flow whose crews are off cannot be switched on. A code flow switched off is refused by the agent, whoever
 * starts it (`reason` is what it says); a content flow's switch is its news_jobs switch.
 */
export async function setEnabled(kind: CatalogKind, actor: Actor, key: string, enabled: boolean, reason: string | null = null): Promise<CatalogItem> {
  const d = await getDb();
  const cur = await getItem(kind, key, d);
  if (!cur) throw new CatalogError(`No ${kind} ${key}.`, 404);
  if (cur.deletedAt) throw new CatalogError(`The ${kind} ${cur.label} is deleted: restore it first.`, 409);
  if (kind === "crew" && !enabled) {
    const users = await flowsUsing(key, { enabledOnly: true }, d);
    if (users.length) throw new CatalogError(`Run by ${users.map((f) => f.label).join(", ")}: switch those flows off first.`, 409);
  }
  if (kind === "flow" && enabled && cur.crews.length) {
    const off = (await allItems("crew", d)).filter((c) => cur.crews.includes(c.key) && !c.enabled);
    if (off.length) throw new CatalogError(`It runs ${off.map((c) => c.label).join(", ")}, which ${off.length === 1 ? "is" : "are"} off: switch ${off.length === 1 ? "it" : "them"} on first.`, 409);
  }
  const why = enabled ? null : text(reason, 300, "The reason") || null;
  await d.execute(sql`update ${TABLE[kind]} set enabled = ${enabled}, ${kind === "flow" ? sql`disabled_reason = ${why},` : sql``} updated_at = now(), updated_by = ${actor.label} where key = ${key}`);
  if (kind === "flow" && cur.definition === "content" && cur.contentJobId) {
    await d.execute(sql`update news_jobs set enabled = ${enabled}, updated_at = now() where id = ${cur.contentJobId}::uuid`);
  }
  await audit(actor, `crewai.${kind}.${enabled ? "enable" : "disable"}`, key, { reason: why });
  return (await getItem(kind, key, d))!;
}

/**
 * Delete a crew or flow. The row stays (its run history names it) and can be restored. A crew a flow still runs is
 * refused. A spec flow's own schedules are removed; a code flow's schedules are paused (restore and resume them); a
 * content flow is deleted in news_jobs as well.
 */
export async function deleteItem(kind: CatalogKind, actor: Actor, key: string): Promise<{ schedulesRemoved: number; schedulesPaused: number }> {
  const d = await getDb();
  const cur = await getItem(kind, key, d);
  if (!cur || cur.deletedAt) throw new CatalogError(`No ${kind} ${key}.`, 404);
  if (kind === "crew") {
    const users = await flowsUsing(key, {}, d);
    if (users.length) throw new CatalogError(`Run by ${users.map((f) => f.label).join(", ")}: change or delete those flows first.`, 409);
  }
  let removed = 0;
  let paused = 0;
  if (kind === "flow" && cur.definition === "spec") {
    removed = rowsOf<{ id: string }>(await d.execute(sql`delete from seo_flow_schedules where flow_name = 'custom_flow' and not builtin and inputs->>'flow' = ${key} returning id`)).length;
  }
  if (kind === "flow" && cur.definition === "code" && cur.flowName) {
    paused = rowsOf<{ id: string }>(await d.execute(sql`update seo_flow_schedules set enabled = false, armed_at = now(), updated_at = now(), updated_by = ${actor.label} where flow_name = ${cur.flowName} and enabled returning id`)).length;
  }
  if (kind === "flow" && cur.definition === "content" && cur.contentJobId) {
    await d.execute(sql`update news_jobs set deleted_at = now(), enabled = false, updated_at = now() where id = ${cur.contentJobId}::uuid and deleted_at is null`);
  }
  await d.execute(sql`update ${TABLE[kind]} set deleted_at = now(), enabled = false, updated_at = now(), updated_by = ${actor.label} where key = ${key}`);
  await audit(actor, `crewai.${kind}.delete`, key, { schedulesRemoved: removed, schedulesPaused: paused });
  return { schedulesRemoved: removed, schedulesPaused: paused };
}

/** Bring a deleted crew or flow back, switched off (switch it on when it is ready). */
export async function restoreItem(kind: CatalogKind, actor: Actor, key: string): Promise<CatalogItem> {
  const d = await getDb();
  const cur = await getItem(kind, key, d);
  if (!cur) throw new CatalogError(`No ${kind} ${key}.`, 404);
  if (!cur.deletedAt) return cur;
  if (kind === "flow" && cur.definition === "content" && cur.contentJobId) {
    await d.execute(sql`update news_jobs set deleted_at = null, enabled = false, updated_at = now() where id = ${cur.contentJobId}::uuid`);
  }
  await d.execute(sql`update ${TABLE[kind]} set deleted_at = null, enabled = false, updated_at = now(), updated_by = ${actor.label} where key = ${key}`);
  await audit(actor, `crewai.${kind}.restore`, key, {});
  return (await getItem(kind, key, d))!;
}

/** The overlay of a code crew's active version (seo_crew_configs), or null for the code's defaults. */
async function activeOverlay(d: Db, crew: string): Promise<Record<string, unknown> | null> {
  try {
    const [r] = rowsOf<{ config: unknown }>(await d.execute(sql`select config from seo_crew_configs where crew = ${crew} and active`));
    return r ? asObject(r.config) : null;
  } catch {
    return null;
  }
}

/**
 * Duplicate any crew or flow under a new key, switched off until it is checked. The copy is defined by a spec, so all
 * of it can be edited: a code crew becomes a spec with its agents and tasks as its active version has them (the agent
 * materializes it, leaving out tools that need a fixed article); a code flow becomes a step flow whose one step starts
 * it (add your steps around it); a content flow becomes a new content flow with the same settings.
 */
export async function duplicateItem(kind: CatalogKind, actor: Actor, key: string, input: { key?: unknown; label?: unknown } = {}, deps: AgentDeps = {}): Promise<{ item: CatalogItem; notes: string[] }> {
  const d = await getDb();
  const cur = await getItem(kind, key, d);
  if (!cur) throw new CatalogError(`No ${kind} ${key}.`, 404);
  const name = label(input.label ?? `${cur.label} (copy)`.slice(0, 120));
  const notes: string[] = [];
  if (kind === "flow" && cur.definition === "content" && cur.contentJobId) {
    const { cloneJob } = await import("@/lib/news/service");
    const job = (await cloneJob(actor, cur.contentJobId)) as { id?: string; job?: { id?: string } };
    const jobId = String(job?.id ?? job?.job?.id ?? "");
    const row = jobId ? await contentFlowOf(jobId, d) : null;
    if (!row) throw new CatalogError("The content flow was copied, but its catalogue row is missing.", 500);
    await d.execute(sql`update crewai_flows set label = ${name}, categories = ${pgArray(cur.categories)}, tags = ${pgArray(cur.tags)}, updated_by = ${actor.label} where key = ${row.key}`);
    await d.execute(sql`update news_jobs set name = ${name} where id = ${jobId}::uuid`);
    await audit(actor, "crewai.flow.duplicate", row.key, { from: key });
    return { item: (await getItem("flow", row.key, d))!, notes };
  }
  const to = newKey(input.key ?? `${key.replace(/_flow$/, "")}_copy`.slice(0, 40));
  let spec: Record<string, unknown>;
  if (cur.definition === "spec" && cur.spec) {
    spec = { ...cur.spec, key: to, label: name };
  } else if (kind === "crew") {
    try {
      const r = await crewAsSpec(key, { key: to, label: name, config: await activeOverlay(d, key) }, deps);
      spec = r.spec;
      if (r.dropped_tools.length) notes.push(`Left out tools that need a fixed article or a news run: ${r.dropped_tools.join(", ")}.`);
    } catch (e) {
      if (e instanceof AgentError) throw new CatalogError(`${e.message} Copying a crew defined in code needs the SEO agent.`, e.status === 422 ? 422 : 503, e.issues);
      throw e;
    }
  } else {
    spec = { key: to, label: name, description: cur.description, inputs: [], steps: [{ kind: "flow", flow: cur.flowName, inputs: {}, save_as: "result", label: cur.label }] };
    notes.push(`The copy starts ${cur.label} as its one step; add inputs and steps around it.`);
  }
  const item = await createItem(kind, actor, { key: to, label: name, description: cur.description, objective: cur.objective, categories: cur.categories, tags: cur.tags, enabled: false, spec, note: `duplicated from ${key}` }, deps);
  await audit(actor, `crewai.${kind}.duplicate`, to, { from: key });
  return { item, notes };
}

export type SpecVersion = { version: number; spec: Record<string, unknown>; note: string; createdAt: string; createdBy: string | null };

export async function specVersions(kind: CatalogKind, key: string, db?: Db): Promise<SpecVersion[]> {
  const d = db ?? (await getDb());
  return rowsOf<Record<string, unknown>>(await d.execute(sql`select * from crewai_spec_versions where kind = ${kind} and key = ${key} order by version desc limit 100`)).map((r) => ({
    version: Number(r.version),
    spec: asObject(r.spec) ?? {},
    note: String(r.note ?? ""),
    createdAt: iso(r.created_at) ?? "",
    createdBy: (r.created_by as string | null) ?? null,
  }));
}

/** Save an earlier version's spec as the newest version (checked again, as on any save). */
export async function restoreVersion(kind: CatalogKind, actor: Actor, key: string, version: number, deps: AgentDeps = {}): Promise<CatalogItem> {
  const v = (await specVersions(kind, key)).find((x) => x.version === version);
  if (!v) throw new CatalogError(`No version ${version}.`, 404);
  return updateItem(kind, actor, key, { spec: v.spec, note: `restored v${version}` }, deps);
}

// --- what the agent reads (internal-server.ts) -------------------------------------------------------------------------

/** GET /custom-crews | /custom-flows: the spec crews or flows that are on ({key, version, spec}). */
export async function servedSpecs(kind: CatalogKind) {
  const d = await getDb();
  const rows = rowsOf<Record<string, unknown>>(await d.execute(sql`select key, version, spec from ${TABLE[kind]} where definition = 'spec' and enabled and deleted_at is null order by key`));
  return { items: rows.map((r) => ({ key: String(r.key), version: Number(r.version), spec: asObject(r.spec) ?? {} })) };
}

/** GET /flow-switches: the agent's flows switched off or deleted here, which it refuses to start. */
export async function flowSwitches() {
  const d = await getDb();
  const rows = rowsOf<{ flow_name: string; reason: string | null; deleted: boolean }>(
    await d.execute(sql`select flow_name, disabled_reason as reason, deleted_at is not null as deleted from crewai_flows where definition = 'code' and (not enabled or deleted_at is not null) order by flow_name`),
  );
  return { disabled: rows.map((r) => ({ flow: r.flow_name, reason: r.deleted ? "deleted in the admin" : (r.reason ?? "") })) };
}

/**
 * New crews and flows the agent reports (a newer agent) are added with its names, descriptions and categories; a code
 * row's facts that come from the code (which crews a flow runs, how it may be started) follow the agent. What an admin
 * changed (names, categories, tags, switches) is never overwritten.
 */
export async function syncFromAgent(flows: AgentFlow[] | null, crews: AgentCrew[] | null, db?: Db): Promise<number> {
  const d = db ?? (await getDb());
  let added = 0;
  try {
    for (const f of flows ?? []) {
      if (RUNNER_FLOWS.includes(f.name) || !/^[a-z][a-z0-9_]{2,39}_flow$/.test(f.name)) continue;
      const start = ["manual", "review", "approval", "schedule", "internal"].includes(String(f.start)) ? String(f.start) : "manual";
      const cats = (f.categories ?? []).filter((c) => SLUG.test(c)).slice(0, 10);
      const r = rowsOf<{ inserted: boolean }>(
        await d.execute(sql`insert into crewai_flows (key, label, description, categories, definition, flow_name, start, crews, created_by, updated_by)
          select ${f.name}, ${(f.label ?? f.name).slice(0, 120)}, ${(f.description ?? "").slice(0, 1000)}, array(select slug from crewai_categories where slug = any(${pgArray(cats)})), 'code', ${f.name}, ${start}, ${pgArray(f.crews ?? [])}, 'seo-agent', 'seo-agent'
          on conflict (key) do update set crews = excluded.crews, start = excluded.start
            where crewai_flows.definition = 'code' and (crewai_flows.crews is distinct from excluded.crews or crewai_flows.start is distinct from excluded.start)
          returning (xmax = 0) as inserted`),
      );
      if (r[0]?.inserted) added++;
    }
    for (const c of crews ?? []) {
      if (!KEY.test(c.crew)) continue;
      const cats = (c.categories ?? []).filter((x) => SLUG.test(x)).slice(0, 10);
      const r = rowsOf<{ key: string }>(
        await d.execute(sql`insert into crewai_crews (key, label, description, categories, definition, created_by, updated_by)
          select ${c.crew}, ${(c.label || c.crew).slice(0, 120)}, ${(c.description ?? "").slice(0, 1000)}, array(select slug from crewai_categories where slug = any(${pgArray(cats)})), 'code', 'seo-agent', 'seo-agent'
          on conflict (key) do nothing returning key`),
      );
      added += r.length;
    }
  } catch {
    return added; // the catalogue still lists what it has
  }
  return added;
}

// --- categories --------------------------------------------------------------------------------------------------------

export async function listCategories(db?: Db): Promise<Category[]> {
  const d = db ?? (await getDb());
  const rows = rowsOf<Record<string, unknown>>(
    await d.execute(sql`select c.*,
      (select count(*)::int from crewai_crews x where x.deleted_at is null and c.slug = any(x.categories)) as crews,
      (select count(*)::int from crewai_flows x where x.deleted_at is null and c.slug = any(x.categories)) as flows
      from crewai_categories c order by c.position, lower(c.label)`),
  );
  return rows.map((r) => ({ slug: String(r.slug), label: String(r.label), description: String(r.description ?? ""), position: Number(r.position ?? 0), crews: Number(r.crews ?? 0), flows: Number(r.flows ?? 0) }));
}

const slugify = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");

export async function createCategory(actor: Actor, input: { slug?: unknown; label?: unknown; description?: unknown; position?: unknown }): Promise<Category> {
  const d = await getDb();
  const name = text(input.label, 60, "The name");
  if (!name) throw new CatalogError("A category needs a name.", 400);
  const slug = String(input.slug ?? "").trim() || slugify(name);
  if (!SLUG.test(slug) || slug.length > 40) throw new CatalogError("The slug is lower-case letters and digits with single dashes, at most 40 characters.", 400);
  const position = Number.isInteger(input.position) ? Number(input.position) : Number((rowsOf<{ p: number }>(await d.execute(sql`select coalesce(max(position), 0)::int + 10 as p from crewai_categories`))[0]?.p ?? 10));
  const r = rowsOf<{ slug: string }>(await d.execute(sql`insert into crewai_categories (slug, label, description, position, updated_by) values (${slug}, ${name}, ${text(input.description, 300, "The description")}, ${position}, ${actor.label}) on conflict (slug) do nothing returning slug`));
  if (!r.length) throw new CatalogError(`There is already a category ${slug}.`, 409);
  await audit(actor, "crewai.category.create", slug, { label: name });
  return (await listCategories(d)).find((c) => c.slug === slug)!;
}

/** Rename (the slug stays, so every crew and flow keeps it), describe or reorder a category. */
export async function updateCategory(actor: Actor, slug: string, patch: { label?: unknown; description?: unknown; position?: unknown }): Promise<Category> {
  const d = await getDb();
  const cur = (await listCategories(d)).find((c) => c.slug === slug);
  if (!cur) throw new CatalogError(`No category ${slug}.`, 404);
  const name = patch.label === undefined ? cur.label : text(patch.label, 60, "The name");
  if (!name) throw new CatalogError("A category needs a name.", 400);
  const description = patch.description === undefined ? cur.description : text(patch.description, 300, "The description");
  const position = Number.isInteger(patch.position) ? Number(patch.position) : cur.position;
  await d.execute(sql`update crewai_categories set label = ${name}, description = ${description}, position = ${position}, updated_at = now(), updated_by = ${actor.label} where slug = ${slug}`);
  await audit(actor, "crewai.category.update", slug, { label: name });
  return (await listCategories(d)).find((c) => c.slug === slug)!;
}

/** Remove a category: it is taken off every crew and flow (they stay as they are otherwise). */
export async function deleteCategory(actor: Actor, slug: string): Promise<{ crews: number; flows: number }> {
  const d = await getDb();
  const cur = (await listCategories(d)).find((c) => c.slug === slug);
  if (!cur) throw new CatalogError(`No category ${slug}.`, 404);
  const crews = rowsOf<{ key: string }>(await d.execute(sql`update crewai_crews set categories = array_remove(categories, ${slug}) where ${slug} = any(categories) returning key`)).length;
  const flows = rowsOf<{ key: string }>(await d.execute(sql`update crewai_flows set categories = array_remove(categories, ${slug}) where ${slug} = any(categories) returning key`)).length;
  await d.execute(sql`delete from crewai_categories where slug = ${slug}`);
  await audit(actor, "crewai.category.delete", slug, { crews, flows });
  return { crews, flows };
}
