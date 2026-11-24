import "server-only";
import { sql } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
import { jobConfigSchema } from "@/lib/news/schema";
import { AgentError, configCatalogue, crewCatalogue, flowCatalogue, getLlmProviders, type AgentConfigCatalogue, type AgentDeps, type AgentLlmProvidersView } from "@/lib/seo-agent/client";
import { listSkills } from "@/lib/seo-agent/skills";
import { allItems, listCategories, RUNNER_FLOWS, syncFromAgent } from "../catalog";
import { activeVersions } from "../crews";
import { exportable, listSchedules } from "../schedules";
import { emptyConfig, findSecrets, idOf, KINDS, redactSecrets, type CrewConfig, type Kind } from "./model";

/**
 * The site's CrewAI configuration as it runs now, discovered at export time (never a list written here): every crew and
 * flow of the catalogue (after adding what the agent reports and the catalogue lacks, as its pages do), each code crew's
 * agents and tasks as they run (the agent's code defaults plus the active version), each spec crew's and flow's spec,
 * each content flow's settings and sources, every skill (shipped ones too), schedule and category, and the agent's tools,
 * guardrails and providers (read-only). What cannot be exported is reported with the reason, never left out silently.
 */

export type AgentSide = { catalogue: AgentConfigCatalogue | null; providers: AgentLlmProvidersView | null; error: string | null; legacy: boolean };

/** What the agent defines in code. An agent older than GET /config-catalogue still gives its crews and flows. */
export async function loadAgentSide(deps: AgentDeps = {}): Promise<AgentSide> {
  const providers = await getLlmProviders(deps).catch(() => null);
  try {
    return { catalogue: await configCatalogue(deps), providers, error: null, legacy: false };
  } catch (e) {
    if (e instanceof AgentError && e.status === 404) {
      try {
        const [crews, flows] = await Promise.all([crewCatalogue(deps), flowCatalogue(deps)]);
        return { catalogue: { format: 0, service: "moks-seo-agent", version: "", crews: crews.items, flows: flows.items, tools: [], custom_tools: [], guardrails: [], models: [] }, providers, error: null, legacy: true };
      } catch (e2) {
        return { catalogue: null, providers, error: (e2 as Error).message, legacy: false };
      }
    }
    return { catalogue: null, providers, error: (e as Error).message, legacy: false };
  }
}

export type ExportReport = {
  /** false when something that exists could not be exported (the agent did not answer, so code crews are missing). */
  complete: boolean;
  counts: Record<Kind, number>;
  /** Components the bundle does not cover, or could not cover this time, with the reason (also in manifest.json). */
  unsupported: { component: string; reason: string }[];
  /** Items not exported on purpose (deleted, runners), with the reason. */
  skipped: { kind: Kind; id: string; reason: string }[];
  /** Text that looked like a credential, replaced by [redacted]. */
  redacted: { item: string; path: string; pattern: string }[];
  warnings: string[];
  agent: { reachable: boolean; version: string | null };
};

const NOT_COVERED = [
  { component: "content profiles (writing and image)", reason: "Content flows name them by key (writing_profile_key, image_profile_key); they are edited under AI & SEO → Content → Profiles and are not part of the bundle yet. An import refuses a content flow whose profile this site lacks." },
  { component: "LLM provider keys, budgets and the agent's settings", reason: "Credentials and runtime limits: set per site in Settings (providers are listed read-only, with where their key is)." },
  { component: "run history, drafts and model state", reason: "Runtime data, not configuration." },
];

type Row = Record<string, unknown>;
const asObj = (v: unknown): Row => (v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : typeof v === "string" ? (JSON.parse(v) as Row) : {});
const arr = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : []);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.replace(/^\{|\}$/g, "").split(",").filter(Boolean).map((x) => x.replace(/^"|"$/g, "")) : []);
const num = (v: unknown): number | null => (v == null || v === "" ? null : Number(v));

/** A content flow's key from its news_jobs id (migration 0041's trigger), and an id that gives that key back. */
export const contentKeyOf = (jobId: string) => `content_${jobId.replace(/-/g, "").slice(0, 12)}`;

export type RuntimeOptions = { db?: Db; deps?: AgentDeps; agent?: AgentSide; source?: string; sync?: boolean };
export type Runtime = { config: CrewConfig; report: ExportReport; agent: AgentSide; sourceIds: Map<string, string>; jobIds: Map<string, string> };

export async function exportRuntime(opts: RuntimeOptions = {}): Promise<Runtime> {
  const d = opts.db ?? (await getDb());
  const agent = opts.agent ?? (await loadAgentSide(opts.deps));
  const cat = agent.catalogue;
  const config = emptyConfig();
  const report: ExportReport = { complete: true, counts: {} as Record<Kind, number>, unsupported: [...NOT_COVERED], skipped: [], redacted: [], warnings: [], agent: { reachable: Boolean(cat), version: cat?.version || null } };
  if (!cat) {
    report.complete = false;
    report.unsupported.push({ component: "crews defined in code, tools and guardrails", reason: `The SEO agent did not answer (${agent.error ?? "unreachable"}): their agents and tasks are its code. Export again when it is online.` });
  } else if (agent.legacy) {
    report.unsupported.push({ component: "tools and guardrails", reason: "This SEO agent is older than GET /config-catalogue; update it to export them." });
  }
  if (opts.sync !== false && cat) await syncFromAgent(cat.flows, cat.crews, d);

  const push = <K extends Kind>(kind: K, raw: unknown, label: string) => {
    const info = KINDS.find((k) => k.kind === kind)!;
    const r = info.schema.safeParse(raw);
    if (!r.success) {
      report.complete = false;
      report.unsupported.push({ component: `${info.one} ${label}`, reason: `does not fit the bundle format: ${r.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` });
      return false;
    }
    (config[kind] as unknown[]).push(r.data);
    return true;
  };

  for (const c of await listCategories(d)) push("categories", { slug: c.slug, label: c.label, description: c.description, position: c.position }, c.slug);

  // Content sources: by URL (their ids differ per site). The first of two sources with one URL is the one exported.
  const sourceIds = new Map<string, string>();
  const urlOfSource = new Map<string, string>();
  const sourceRows = rowsOf<Row>(await d.execute(sql`select id, name, type, url, topic_hints, credibility, fetch_interval_minutes, enabled, terms_note, deleted_at from news_sources order by created_at, id`));
  for (const s of sourceRows) {
    urlOfSource.set(String(s.id), String(s.url));
    if (s.deleted_at) continue;
    if (sourceIds.has(String(s.url))) {
      report.skipped.push({ kind: "sources", id: String(s.url), reason: `a second source with this URL (${String(s.name)}); only the first is exported` });
      continue;
    }
    if (push("sources", { name: s.name, type: s.type, url: s.url, topic_hints: strs(s.topic_hints), credibility: Number(s.credibility), fetch_interval_minutes: Number(s.fetch_interval_minutes), enabled: Boolean(s.enabled), terms_note: (s.terms_note as string | null) ?? null }, String(s.url))) sourceIds.set(String(s.url), String(s.id));
  }

  // Crews: code crews as they run (defaults + active version), spec crews from their spec.
  const overlays = new Map((await activeVersions(d)).map((v) => [v.crew, v.config]));
  const codeCrews = new Map((cat?.crews ?? []).map((c) => [c.crew, c]));
  for (const row of await allItems("crew", d)) {
    const meta = { key: row.key, label: row.label, description: row.description, objective: row.objective, categories: row.categories, tags: row.tags, enabled: row.enabled };
    if (row.definition === "code") {
      const def = codeCrews.get(row.key);
      if (!def) {
        if (cat) report.skipped.push({ kind: "crews", id: row.key, reason: "defined in code, but the SEO agent has no such crew any more" });
        else report.skipped.push({ kind: "crews", id: row.key, reason: "defined in code: its agents and tasks need the SEO agent, which did not answer" });
        continue;
      }
      const ov = asObj(overlays.get(row.key));
      const oa = asObj(ov.agents);
      const ot = asObj(ov.tasks);
      const agents = def.agents.map((a) => {
        const o = asObj(oa[a.key]);
        return { crew: row.key, key: a.key, role: String(o.role ?? a.role), goal: String(o.goal ?? a.goal), backstory: String(o.backstory ?? a.backstory), tools: strs(o.tools ?? a.tools), model: (o.model as string | undefined) ?? null, max_tokens: num(o.max_tokens ?? a.max_tokens), max_iter: num(o.max_iter) };
      });
      const tasks = def.tasks.map((t) => {
        const o = asObj(ot[t.key]);
        return { crew: row.key, key: t.key, agent: t.agent, label: t.label, instructions: String(o.instructions ?? t.instructions), expected_output: String((t.output_editable ? o.expected_output : undefined) ?? t.expected_output), variables: t.variables, contract: t.contract, output_editable: t.output_editable };
      });
      if (!push("crews", { ...meta, definition: "code", agents: def.agents.map((a) => a.key), tasks: def.tasks.map((t) => t.key), code: { prompt_version: def.prompt_version, default_hash: def.default_hash, allowed_tools: def.tools, replay_flows: def.replay_flows } }, row.key)) continue;
      agents.forEach((a) => push("agents", a, `${row.key}.${a.key}`));
      tasks.forEach((t) => push("tasks", t, `${row.key}.${t.key}`));
      continue;
    }
    const spec = asObj(row.spec);
    const sa = arr(spec.agents);
    const st = arr(spec.tasks);
    if (!push("crews", { ...meta, definition: "spec", agents: sa.map((a) => String(a.key)), tasks: st.map((t) => String(t.key)), inputs: Array.isArray(spec.inputs) ? spec.inputs : [], output: (spec.output as Row | null | undefined) ?? null, model: (spec.model as string | null | undefined) ?? null }, row.key)) continue;
    sa.forEach((a) => push("agents", { crew: row.key, key: a.key, role: a.role, goal: a.goal, backstory: a.backstory, tools: strs(a.tools), model: a.model ?? null, max_tokens: num(a.max_tokens), max_iter: num(a.max_iter) }, `${row.key}.${String(a.key)}`));
    st.forEach((t) => push("tasks", { crew: row.key, key: t.key, agent: t.agent, label: t.label, instructions: t.instructions, expected_output: t.expected_output, context: strs(t.context) }, `${row.key}.${String(t.key)}`));
  }
  for (const r of rowsOf<{ key: string }>(await d.execute(sql`select key from crewai_crews where deleted_at is not null order by key`))) report.skipped.push({ kind: "crews", id: r.key, reason: "deleted in the admin (restorable there); not exported" });

  // Flows: code flows (their read-only runtime facts from the agent), spec flows, content flows with their settings.
  const agentFlows = new Map((cat?.flows ?? []).map((f) => [f.name, f]));
  const jobIds = new Map<string, string>();
  const listed = new Set<string>();
  for (const row of await allItems("flow", d)) {
    const meta = { key: row.key, label: row.label, description: row.description, categories: row.categories, tags: row.tags, enabled: row.enabled, flow_name: row.flowName ?? "", start: row.start ?? "manual", crews: row.crews };
    if (row.definition === "code") {
      listed.add(String(row.flowName));
      const f = agentFlows.get(String(row.flowName));
      if (cat && !f) {
        report.skipped.push({ kind: "flows", id: row.key, reason: "defined in code, but the SEO agent has no such flow any more" });
        continue;
      }
      if (!f) report.warnings.push(`Flow ${row.key}: its input schema needs the SEO agent (the read-only runtime block is left out).`);
      push("flows", { ...meta, disabled_reason: row.enabled ? null : row.disabledReason, definition: "code", ...(f ? { runtime: { inputs_schema: f.inputs_schema as Row, schedulable: f.schedulable, approval_only: f.approval_only, mcp: f.mcp, flow_step: f.flow_step ?? true } } : {}) }, row.key);
    } else if (row.definition === "spec") {
      const spec = { ...asObj(row.spec) };
      delete spec.key;
      delete spec.label;
      delete spec.description;
      push("flows", { ...meta, disabled_reason: row.enabled ? null : row.disabledReason, definition: "spec", spec }, row.key);
    } else {
      const [job] = row.contentJobId ? rowsOf<Row>(await d.execute(sql`select * from news_jobs where id = ${row.contentJobId}::uuid and deleted_at is null`)) : [];
      if (!job) {
        report.skipped.push({ kind: "flows", id: row.key, reason: "a content flow whose settings are missing" });
        continue;
      }
      jobIds.set(row.key, String(job.id));
      const cfg = { ...jobConfigSchema.parse(asObj(job.config)) } as Row;
      const urls: string[] = [];
      for (const id of strs(cfg.source_ids)) {
        const url = urlOfSource.get(id);
        if (url && sourceIds.has(url)) urls.push(url);
        else report.warnings.push(`Content flow ${row.key}: source ${id} is deleted, so it is left out of the flow's sources.`);
      }
      delete cfg.source_ids;
      push(
        "flows",
        {
          ...meta,
          label: String(job.name).trim().length >= 2 ? job.name : row.label,
          description: job.description ?? row.description,
          enabled: Boolean(job.enabled),
          disabled_reason: null,
          definition: "content",
          content: { cron: job.cron, timezone: job.timezone, mode: job.mode, writing_profile_key: job.writing_profile_key, image_profile_key: job.image_profile_key, review_priority: Number(job.review_priority), sources: [...new Set(urls)], config: cfg },
        },
        row.key,
      );
    }
  }
  for (const r of rowsOf<{ key: string }>(await d.execute(sql`select key from crewai_flows where deleted_at is not null order by key`))) report.skipped.push({ kind: "flows", id: r.key, reason: "deleted in the admin (restorable there); not exported" });
  for (const f of cat?.flows ?? []) {
    if (listed.has(f.name)) continue;
    report.skipped.push({ kind: "flows", id: f.name, reason: RUNNER_FLOWS.includes(f.name) ? "runs other flows: every spec flow, content flow and crew test is exported under its own key" : "the catalogue does not list it (a flow name it does not take)" });
  }

  for (const s of await listSkills(d)) push("skills", { name: s.name, description: s.description, agents: s.agents, tags: s.tags, enabled: s.enabled, builtin: s.builtin, instructions: s.instructions }, s.name);
  for (const s of await listSchedules(d)) push("schedules", exportable(s), s.name);

  for (const t of cat?.tools ?? []) push("tools", t, t.name);
  for (const g of cat?.guardrails ?? []) push("guardrails", g, g.id);
  if (agent.providers) {
    const kinds = new Map(agent.providers.kinds.map((k) => [k.id, k]));
    for (const p of agent.providers.providers) {
      const env = kinds.get(p.kind)?.env_key;
      const keyRef = p.key === "saved" ? "stored encrypted by the SEO agent (Settings → LLM providers)" : p.key === "env" ? `environment variable ${env || agent.providers.key_env || "of the deployment"}` : p.key === "not_needed" ? "no key needed" : "no key yet";
      push(
        "providers",
        { id: p.id, kind: p.kind, name: p.name, enabled: p.enabled, base_url: p.base_url, region: p.region, deployment: p.deployment, api_version: p.api_version, key: p.key, key_ref: keyRef, models: p.models.map((m) => ({ model_id: m.model_id, label: m.label, enabled: m.enabled, free: m.free, price_state: m.price_state, context_window: m.context_window, max_output: m.max_output })) },
        p.id,
      );
    }
  } else if (cat) report.unsupported.push({ component: "model providers", reason: "The SEO agent did not list its LLM providers (GET /llm-providers)." });

  // Nothing that looks like a credential leaves the site.
  for (const k of KINDS) {
    const list = config[k.kind] as unknown[];
    list.forEach((item, i) => {
      const hits = findSecrets(item);
      if (!hits.length) return;
      for (const h of hits) report.redacted.push({ item: `${k.kind}:${idOf(k.kind, item)}`, path: h.path, pattern: h.pattern });
      list[i] = redactSecrets(item);
    });
  }
  for (const k of KINDS) report.counts[k.kind] = (config[k.kind] as unknown[]).length;
  return { config, report, agent, sourceIds, jobIds };
}
