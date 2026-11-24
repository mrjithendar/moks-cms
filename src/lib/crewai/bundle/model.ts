import { z } from "zod";

/**
 * The CrewAI configuration bundle (format 2, D-101, docs/seo/CREWCONFIG.md): every crew, agent, task, flow, skill,
 * schedule, content source, category, tool, guardrail and provider of a site, as plain files a person can review in Git.
 * Pure and client-safe: the exporter (runtime.ts), the importer (plan.ts, apply.ts), the repository editor and the
 * site repository's own check (jithendar.com scripts/crewconfig.py, through schemas/*.schema.json) read the same
 * definitions.
 *
 * Field names in the files are snake_case, like CrewAI's own agents.yaml and tasks.yaml (role, goal, backstory,
 * expected_output, context, tools), so the files read like any CrewAI project.
 *
 * Editable or read-only:
 * - categories, crews, agents, tasks, flows, skills, schedules and sources are imported;
 * - tools, guardrails and providers are read-only: they are listed so a reviewer sees everything a crew runs with, and an
 *   import only checks references against them. Tools and guardrails are code in the SEO agent; providers need keys,
 *   which are never in a bundle (Settings → LLM providers);
 * - in a crew or flow defined in code, the `code` / `runtime` block and a task's `contract`, `variables` and
 *   `output_editable` are read-only too: they describe the code, an import never changes the code.
 * Nothing in a bundle is code: no file is executed, and every crew and flow spec is checked again by the SEO agent
 * before it is saved.
 */

export const BUNDLE_KIND = "moks-crewai-bundle";
export const BUNDLE_FORMAT = 2;
/** The one-file export of the CrewAI console before format 2 (schedules, crew versions, changed skills). Still imported. */
export const LEGACY_KIND = "moks-crewai-config";

export const KEY = /^[a-z][a-z0-9_]{1,39}$/;
export const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const TAG = /^[a-z0-9][a-z0-9 ._-]{0,39}$/;

const trimmed = (min: number, max: number) => z.string().trim().min(min).max(max);
const plain = (max: number) => z.string().trim().max(max).default("");
const key = z.string().regex(KEY, "a key is 2–40 lower-case letters, digits or _ and starts with a letter");
const keys = (max: number) => z.array(key).max(max);
const slugs = z.array(z.string().regex(SLUG).max(40)).max(10).default([]);
const tags = z.array(z.string().trim().toLowerCase().regex(TAG)).max(20).default([]);
const record = z.record(z.string(), z.unknown());

export const categorySchema = z
  .object({ slug: z.string().regex(SLUG).max(40), label: trimmed(1, 60), description: plain(300), position: z.number().int().default(0) })
  .strict();

/** What a crew defined in code says about its code (read-only). */
const crewCode = z.object({ prompt_version: z.string().max(100), default_hash: z.string().max(64), allowed_tools: z.array(z.string().max(60)).max(40), replay_flows: z.array(z.string().max(60)).max(40) }).strict();

export const crewSchema = z
  .object({
    key,
    label: trimmed(2, 120),
    description: plain(1000),
    objective: plain(1500),
    categories: slugs,
    tags,
    enabled: z.boolean().default(true),
    /** code: the SEO agent's own crew (agents and tasks edited as a version on top of its code); spec: made in the admin. */
    definition: z.enum(["code", "spec"]),
    /** The crew's agents (agents/<crew>/<key>.md), and its tasks in the order they run (tasks/<crew>/<key>.md). */
    agents: keys(12).min(1),
    tasks: keys(12).min(1),
    /** spec crews: the inputs its instructions may use, its output schema and its default model. */
    inputs: z.array(z.union([z.string(), record])).max(12).optional(),
    output: record.nullable().optional(),
    model: z.string().max(100).nullable().optional(),
    code: crewCode.optional(),
  })
  .strict();

export const agentSchema = z
  .object({
    crew: key,
    key,
    role: trimmed(1, 300),
    goal: trimmed(1, 2000),
    /** The Markdown body of the agent's file. */
    backstory: trimmed(1, 4000),
    tools: z.array(z.string().max(60)).max(12).default([]),
    model: z.string().max(100).nullable().default(null),
    max_tokens: z.number().int().min(256).max(64_000).nullable().default(null),
    max_iter: z.number().int().min(1).max(25).nullable().default(null),
  })
  .strict();

export const taskSchema = z
  .object({
    crew: key,
    key,
    agent: key,
    label: trimmed(1, 120),
    /** The Markdown body of the task's file: the prompt template, with {placeholders}. */
    instructions: trimmed(1, 12_000),
    expected_output: trimmed(1, 2000),
    /** spec crews: the earlier tasks whose output this one reads (none: the task before it). */
    context: keys(12).optional(),
    /** code crews, read-only: the placeholders the instructions may use, the code-owned text the crew always adds, and
     * whether the expected output may change (false: the code parses the answer). */
    variables: z.array(z.string().max(60)).max(30).optional(),
    contract: z.string().max(8000).optional(),
    output_editable: z.boolean().optional(),
  })
  .strict();

const START = ["manual", "review", "approval", "schedule", "internal"] as const;

export const flowSchema = z
  .object({
    key,
    label: trimmed(2, 120),
    description: plain(1000),
    categories: slugs,
    tags,
    enabled: z.boolean().default(true),
    disabled_reason: z.string().trim().max(300).nullable().default(null),
    /** code: a flow of the SEO agent; spec: steps run by its flow engine; content: a content flow (sources → drafts). */
    definition: z.enum(["code", "spec", "content"]),
    /** The agent flow that runs it (its own name for code flows, custom_flow, news_job_flow). */
    flow_name: z.string().max(60),
    start: z.enum(START).default("manual"),
    /** The crews it runs. */
    crews: z.array(z.string().max(60)).max(30).default([]),
    /** spec flows: inputs and steps (crew, flow, condition, draft; needs, when, retry, timeout_seconds, on_failure). */
    spec: record.optional(),
    /** code flows, read-only: its input schema and who may start it. */
    runtime: z.object({ inputs_schema: record, schedulable: z.boolean(), approval_only: z.boolean(), mcp: z.boolean(), flow_step: z.boolean() }).partial().optional(),
    /** content flows: their settings. `sources` are the content sources by URL (sources/sources.yaml). */
    content: z
      .object({
        cron: z.string().max(100),
        timezone: z.string().max(60),
        mode: z.enum(["single_stories", "daily_digest", "both"]),
        writing_profile_key: z.string().max(41),
        image_profile_key: z.string().max(41),
        review_priority: z.number().int().min(0).max(100),
        sources: z.array(z.string().url().max(2000)).max(200).default([]),
        config: record.default({}),
      })
      .strict()
      .optional(),
  })
  .strict();

export const skillSchema = z
  .object({
    name: z.string().regex(SLUG).max(64),
    description: trimmed(1, 1024),
    agents: z.array(z.string().trim().max(80)).min(1).max(20),
    tags: z.array(z.string().trim().toLowerCase().max(80)).max(20).default([]),
    enabled: z.boolean().default(true),
    /** Shipped with the CMS (edited or not). Read-only: a built-in skill is updated, never created by an import. */
    builtin: z.boolean().default(false),
    /** The Markdown body of SKILL.md. */
    instructions: trimmed(1, 8000),
  })
  .strict();

export const scheduleSchema = z
  .object({
    name: z.string().regex(SLUG).max(64),
    flow: z.string().max(60),
    description: plain(300),
    cron: z.string().trim().max(120),
    timezone: z.string().trim().max(64).default("Etc/UTC"),
    inputs: record.default({}),
    enabled: z.boolean().default(true),
  })
  .strict();

export const SOURCE_TYPES = ["rss", "atom", "json_api", "github_releases", "sitemap", "html_allowlisted"] as const;
export const sourceSchema = z
  .object({
    name: trimmed(2, 120),
    type: z.enum(SOURCE_TYPES),
    url: z.string().trim().url().max(2000).refine((u) => u.startsWith("https://"), "https only"),
    topic_hints: z.array(z.string().max(60)).max(20).default([]),
    credibility: z.number().min(0).max(1).default(0.7),
    fetch_interval_minutes: z.number().int().min(5).max(10080).default(60),
    enabled: z.boolean().default(false),
    terms_note: z.string().max(2000).nullable().default(null),
  })
  .strict();

export const toolSchema = z
  .object({ name: z.string().max(60), description: z.string().max(2000), groups: z.array(z.string().max(20)).max(5), read_only: z.boolean(), custom: z.boolean(), crews: z.array(z.string().max(60)).max(30), agents: z.array(z.string().max(80)).max(60) })
  .strict();

export const guardrailSchema = z.object({ id: z.string().regex(SLUG).max(60), title: z.string().max(120), applies_to: z.string().max(200), text: z.string().max(4000) }).strict();

export const providerSchema = z
  .object({
    id: z.string().max(60),
    kind: z.string().max(60),
    name: z.string().max(120),
    enabled: z.boolean(),
    base_url: z.string().max(500),
    region: z.string().max(60),
    deployment: z.string().max(120),
    api_version: z.string().max(60),
    /** Where the key is: never the key itself. */
    key: z.enum(["saved", "env", "none", "not_needed"]),
    key_ref: z.string().max(200),
    models: z.array(z.object({ model_id: z.string().max(120), label: z.string().max(120), enabled: z.boolean(), free: z.boolean(), price_state: z.string().max(20), context_window: z.number().nullable(), max_output: z.number().nullable() }).strict()).max(200),
  })
  .strict();

export type Category = z.output<typeof categorySchema>;
export type Crew = z.output<typeof crewSchema>;
export type Agent = z.output<typeof agentSchema>;
export type Task = z.output<typeof taskSchema>;
export type Flow = z.output<typeof flowSchema>;
export type Skill = z.output<typeof skillSchema>;
export type Schedule = z.output<typeof scheduleSchema>;
export type Source = z.output<typeof sourceSchema>;
export type Tool = z.output<typeof toolSchema>;
export type Guardrail = z.output<typeof guardrailSchema>;
export type Provider = z.output<typeof providerSchema>;

export type CrewConfig = {
  categories: Category[];
  crews: Crew[];
  agents: Agent[];
  tasks: Task[];
  flows: Flow[];
  skills: Skill[];
  schedules: Schedule[];
  sources: Source[];
  tools: Tool[];
  guardrails: Guardrail[];
  providers: Provider[];
};
export type Kind = keyof CrewConfig;

export const emptyConfig = (): CrewConfig => ({ categories: [], crews: [], agents: [], tasks: [], flows: [], skills: [], schedules: [], sources: [], tools: [], guardrails: [], providers: [] });

type KindInfo = { kind: Kind; label: string; one: string; importable: boolean; schema: z.ZodType; id: (item: never) => string };

/** Every kind of item, in the order an import applies them (what another kind refers to comes first). */
export const KINDS: KindInfo[] = [
  { kind: "categories", label: "Categories", one: "category", importable: true, schema: categorySchema, id: (c: Category) => c.slug },
  { kind: "sources", label: "Content sources", one: "content source", importable: true, schema: sourceSchema, id: (s: Source) => s.url },
  { kind: "crews", label: "Crews", one: "crew", importable: true, schema: crewSchema, id: (c: Crew) => c.key },
  { kind: "agents", label: "Agents", one: "agent", importable: true, schema: agentSchema, id: (a: Agent) => `${a.crew}.${a.key}` },
  { kind: "tasks", label: "Tasks", one: "task", importable: true, schema: taskSchema, id: (t: Task) => `${t.crew}.${t.key}` },
  { kind: "skills", label: "Skills", one: "skill", importable: true, schema: skillSchema, id: (s: Skill) => s.name },
  { kind: "flows", label: "Flows", one: "flow", importable: true, schema: flowSchema, id: (f: Flow) => f.key },
  { kind: "schedules", label: "Schedules", one: "schedule", importable: true, schema: scheduleSchema, id: (s: Schedule) => s.name },
  { kind: "tools", label: "Tools", one: "tool", importable: false, schema: toolSchema, id: (t: Tool) => t.name },
  { kind: "guardrails", label: "Prompt guardrails", one: "guardrail", importable: false, schema: guardrailSchema, id: (g: Guardrail) => g.id },
  { kind: "providers", label: "Model providers", one: "provider", importable: false, schema: providerSchema, id: (p: Provider) => p.id },
];
export const KIND_INFO = new Map(KINDS.map((k) => [k.kind, k]));
export const IMPORTABLE: Kind[] = KINDS.filter((k) => k.importable).map((k) => k.kind);

export const idOf = (kind: Kind, item: unknown): string => KIND_INFO.get(kind)!.id(item as never);
/** "crews:editorial", "agents:editorial.writer": one item across kinds. */
export const ref = (kind: Kind, id: string) => `${kind}:${id}`;

/** JSON with sorted keys: the form checksums and comparisons use, so key order and YAML formatting never matter. */
export function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

/**
 * The part of an item an import compares and applies: read-only fields (a code crew's `code`, a code flow's `runtime`,
 * a code task's `contract`/`variables`/`output_editable`, a skill's `builtin`) are left out, so an agent upgrade that only
 * changes them is not a change of the configuration.
 */
export function editable(kind: Kind, item: unknown): unknown {
  const o = { ...(item as Record<string, unknown>) };
  if (kind === "crews") delete o.code;
  if (kind === "flows") {
    // The agent flow that runs it, how it starts and which crews it runs follow from its code or its spec.
    delete o.runtime;
    delete o.flow_name;
    delete o.start;
    delete o.crews;
    if (o.enabled !== false || o.definition === "content") o.disabled_reason = null;
  }
  if (kind === "tasks") {
    delete o.contract;
    delete o.variables;
    delete o.output_editable;
  }
  if (kind === "skills") delete o.builtin;
  return o;
}

/** Things that look like credentials. Every string of an export is checked; a match is redacted and reported. */
export const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "Anthropic or OpenAI key", re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/g },
  { name: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "Google token", re: /\bya29\.[\w-]{20,}/g },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "GitHub token", re: /\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}/g },
  { name: "site API key", re: /\bjk_[A-Za-z0-9_-]{20,}/g },
  { name: "Slack token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { name: "private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: "bearer token", re: /\bBearer\s+[A-Za-z0-9._~+/-]{24,}=*/g },
  { name: "password in a URL", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]{3,}@/gi },
];

/** Strings of `value` that look like credentials, with their path ("crews.editorial.description"). */
export function findSecrets(value: unknown, path = ""): { path: string; pattern: string }[] {
  if (typeof value === "string") {
    return SECRET_PATTERNS.filter((p) => {
      p.re.lastIndex = 0;
      return p.re.test(value);
    }).map((p) => ({ path, pattern: p.name }));
  }
  if (Array.isArray(value)) return value.flatMap((v, i) => findSecrets(v, `${path}[${i}]`));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => findSecrets(v, path ? `${path}.${k}` : k));
  return [];
}

/** `value` with every credential-looking substring replaced by "[redacted]". */
export function redactSecrets<T>(value: T): T {
  if (typeof value === "string") return SECRET_PATTERNS.reduce((s, p) => s.replace(p.re, "[redacted]"), value as string) as T;
  if (Array.isArray(value)) return value.map(redactSecrets) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactSecrets(v)])) as T;
  return value;
}
