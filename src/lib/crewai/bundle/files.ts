import { createHash } from "node:crypto";
import { parse as parseYaml, stringify as yamlStringify } from "yaml";
import { z } from "zod";
import {
  agentSchema,
  BUNDLE_FORMAT,
  BUNDLE_KIND,
  categorySchema,
  crewSchema,
  editable,
  emptyConfig,
  flowSchema,
  guardrailSchema,
  idOf,
  IMPORTABLE,
  KINDS,
  providerSchema,
  ref,
  scheduleSchema,
  skillSchema,
  sourceSchema,
  stable,
  taskSchema,
  toolSchema,
  type CrewConfig,
  type Kind,
} from "./model";

/**
 * The bundle as files (crewconfig/ in the site's repository) and back. Layout:
 *
 *   manifest.json                 format, inventory, dependencies, checksums (written by the export; see verifyManifest)
 *   README.md                     what is here and how it is used (generated)
 *   categories/categories.yaml    crews/<key>.yaml              agents/<crew>/<agent>.md     tasks/<crew>/<task>.md
 *   flows/<key>.yaml              skills/<name>/SKILL.md         schedules/schedules.yaml     sources/sources.yaml
 *   tools/tools.yaml (read-only)  prompts/guardrails.yaml (read-only)  providers/providers.yaml (read-only)
 *   schemas/<kind>.schema.json    JSON Schema of every file kind, for editors and the repository's own check
 *
 * Agents, tasks and skills are Markdown with YAML front matter: the long text (an agent's backstory, a task's
 * instructions, a skill's instructions) is the body, so it reads and diffs as prose. Parsing is data only: YAML's core
 * schema (no custom tags, no merge keys), a cap on aliases, unique keys, and every item through its zod schema.
 */

export type Files = Record<string, string>;
/** `ref` ("crews:editorial"): the item it is about, when there is one (an import can then leave that item out). */
export type Issue = { path: string; severity: "error" | "warning"; message: string; ref?: string };

export const LIMITS = { files: 2000, fileBytes: 256 * 1024, totalBytes: 8 * 1024 * 1024 } as const;

const COLLECTIONS: Partial<Record<Kind, string>> = {
  categories: "categories/categories.yaml",
  schedules: "schedules/schedules.yaml",
  sources: "sources/sources.yaml",
  tools: "tools/tools.yaml",
  guardrails: "prompts/guardrails.yaml",
  providers: "providers/providers.yaml",
};
const BY_COLLECTION = new Map(Object.entries(COLLECTIONS).map(([k, p]) => [p, k as Kind]));

const PATTERNS: { kind: Kind; re: RegExp; ids: (m: RegExpMatchArray) => Record<string, string> }[] = [
  { kind: "crews", re: /^crews\/([a-z][a-z0-9_]{1,39})\.yaml$/, ids: (m) => ({ key: m[1]! }) },
  { kind: "flows", re: /^flows\/([a-z][a-z0-9_]{1,39})\.yaml$/, ids: (m) => ({ key: m[1]! }) },
  { kind: "agents", re: /^agents\/([a-z][a-z0-9_]{1,39})\/([a-z][a-z0-9_]{1,39})\.md$/, ids: (m) => ({ crew: m[1]!, key: m[2]! }) },
  { kind: "tasks", re: /^tasks\/([a-z][a-z0-9_]{1,39})\/([a-z][a-z0-9_]{1,39})\.md$/, ids: (m) => ({ crew: m[1]!, key: m[2]! }) },
  { kind: "skills", re: /^skills\/([a-z0-9]+(?:-[a-z0-9]+)*)\/SKILL\.md$/, ids: (m) => ({ name: m[1]! }) },
];

/** The file an item lives in. */
export function pathOf(kind: Kind, item: Record<string, unknown>): string {
  const c = COLLECTIONS[kind];
  if (c) return c;
  if (kind === "crews") return `crews/${item.key}.yaml`;
  if (kind === "flows") return `flows/${item.key}.yaml`;
  if (kind === "agents") return `agents/${item.crew}/${item.key}.md`;
  if (kind === "tasks") return `tasks/${item.crew}/${item.key}.md`;
  return `skills/${item.name}/SKILL.md`;
}

/** Which kind a path holds, or null (manifest, README, schemas and anything else). */
export function kindOfPath(path: string): Kind | null {
  const c = BY_COLLECTION.get(path);
  if (c) return c;
  return PATTERNS.find((p) => p.re.test(path))?.kind ?? null;
}

// --- writing ------------------------------------------------------------------------------------------------------------

const YAML_OPTS = { lineWidth: 0, minContentWidth: 0, indentSeq: true } as const;
const toYaml = (v: unknown) => yamlStringify(v, YAML_OPTS);

const HEADER: Partial<Record<Kind, string>> = {
  categories: "Categories crews and flows are filed under (organisation only: nothing decides how a crew or flow runs from them).",
  schedules: "When flows start: cron in the schedule's time zone. A schedule's flow cannot change on import (rename it instead).",
  sources: "Content sources the content flows read, matched by URL on import.",
  tools: "Read-only: the tools an agent can be given, defined in code by the SEO agent. An import only checks agents' tools against this list.",
  guardrails: "Read-only: rules the SEO agent's code puts into every crew agent's system prompt. Nothing in a bundle can change them.",
  providers: "Read-only: the model providers and models the SEO agent knows. Keys are never here: they stay in Settings → LLM providers or the deployment's Secrets.",
};

function crewHeader(c: CrewConfig["crews"][number]): string {
  return c.definition === "code"
    ? `# Crew ${c.label}: defined in code by the SEO agent. Its agents and tasks are a version on top of the code; \`code\` is read-only.\n`
    : `# Crew ${c.label}: made in the admin (a spec). The SEO agent checks it before every save and every run.\n`;
}

function flowHeader(f: CrewConfig["flows"][number]): string {
  if (f.definition === "code") return `# Flow ${f.label}: defined in code by the SEO agent (${f.flow_name}). Its name, categories, tags and switch are editable; \`runtime\` is read-only.\n`;
  if (f.definition === "content") return `# Content flow ${f.label}: finds stories or ideas in its sources and drafts them for review (runs news_job_flow).\n`;
  return `# Flow ${f.label}: steps run by the SEO agent's flow engine (custom_flow). The agent checks the steps before every save and every run.\n`;
}

/** Markdown with front matter: `meta` as YAML, then the body. */
function markdown(meta: Record<string, unknown>, body: string): string {
  return `---\n${toYaml(meta)}---\n\n${body.trimEnd()}\n`;
}

const omit = <T extends Record<string, unknown>>(o: T, ...keys: string[]) => Object.fromEntries(Object.entries(o).filter(([k, v]) => !keys.includes(k) && v !== undefined));

/** One file's text for one item (or a whole collection). */
function itemFiles(config: CrewConfig): Files {
  const out: Files = {};
  for (const [kind, path] of Object.entries(COLLECTIONS) as [Kind, string][]) {
    const list = config[kind] as unknown[];
    if (!list.length && (kind === "providers" || kind === "sources")) continue;
    out[path] = `# ${HEADER[kind]}\n${toYaml({ [kind]: list })}`;
  }
  for (const c of config.crews) out[pathOf("crews", c)] = crewHeader(c) + toYaml(omit(c));
  for (const f of config.flows) out[pathOf("flows", f)] = flowHeader(f) + toYaml(omit(f));
  for (const a of config.agents) out[pathOf("agents", a)] = markdown(omit(a, "backstory"), a.backstory);
  for (const t of config.tasks) out[pathOf("tasks", t)] = markdown(omit(t, "instructions"), t.instructions);
  for (const s of config.skills) out[pathOf("skills", s)] = markdown(omit(s, "instructions"), s.instructions);
  return out;
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** The checksum of what an import compares for one item (read-only fields left out, see model.ts `editable`). */
export const itemChecksum = (kind: Kind, item: unknown) => sha256(stable(editable(kind, item)));

/** "kind:id" → checksum of every importable item: what drift detection compares. */
export function itemChecksums(config: CrewConfig): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kind of IMPORTABLE) for (const item of config[kind] as unknown[]) out[ref(kind, idOf(kind, item))] = itemChecksum(kind, item);
  return out;
}

/** One checksum for the whole importable configuration: the "configuration version" the console shows. */
export function configChecksum(config: CrewConfig): string {
  const sums = itemChecksums(config);
  return sha256(
    Object.keys(sums)
      .sort()
      .map((k) => `${k}=${sums[k]}`)
      .join("\n"),
  );
}

export type ManifestMeta = {
  source: string;
  exportedAt: string;
  cmsVersion: string;
  agentVersion: string | null;
  unsupported: { component: string; reason: string }[];
};

export const manifestSchema = z
  .object({
    kind: z.literal(BUNDLE_KIND),
    format: z.number().int().min(1),
    min_format: z.number().int().min(1).optional(),
    generator: z.string().max(100).optional(),
    exported_at: z.string().max(40).optional(),
    source: z.string().max(200).optional(),
    app: z.object({ cms: z.string().max(100), agent: z.string().max(100).nullable() }).partial().optional(),
    checksum: z.string().max(64).optional(),
    counts: z.record(z.string(), z.number()).optional(),
    inventory: z.record(z.string(), z.array(z.string())).optional(),
    dependencies: z.record(z.string(), z.unknown()).optional(),
    compatibility: z.record(z.string(), z.unknown()).optional(),
    items: z.record(z.string(), z.string()).optional(),
    files: z.array(z.object({ path: z.string().max(300), sha256: z.string().max(64) }).strict()).optional(),
    unsupported: z.array(z.object({ component: z.string().max(200), reason: z.string().max(1000) }).strict()).optional(),
  })
  .strict();
export type Manifest = z.output<typeof manifestSchema>;

function dependencies(config: CrewConfig) {
  const flowsUsing = (crew: string) => config.flows.filter((f) => f.crews.includes(crew)).map((f) => f.key);
  const toolsOf = (crew: string) => [...new Set(config.agents.filter((a) => a.crew === crew).flatMap((a) => a.tools))].sort();
  return {
    crews: Object.fromEntries(config.crews.map((c) => [c.key, { agents: c.agents.map((a) => `${c.key}.${a}`), tasks: c.tasks.map((t) => `${c.key}.${t}`), tools: toolsOf(c.key), flows: flowsUsing(c.key), categories: c.categories }])),
    flows: Object.fromEntries(config.flows.map((f) => [f.key, { crews: f.crews, schedules: config.schedules.filter((s) => s.flow === f.flow_name && (f.definition !== "spec" || s.inputs.flow === f.key)).map((s) => s.name), sources: f.content?.sources ?? [], categories: f.categories }])),
    schedules: Object.fromEntries(config.schedules.map((s) => [s.name, { flow: s.flow, ...(s.flow === "custom_flow" && typeof s.inputs.flow === "string" ? { step_flow: s.inputs.flow } : {}) }])),
    skills: Object.fromEntries(config.skills.map((s) => [s.name, { agents: s.agents }])),
  };
}

function readme(config: CrewConfig, meta: ManifestMeta, counts: Record<string, number>): string {
  const row = (k: (typeof KINDS)[number]) => `| \`${dirOf(k.kind)}\` | ${k.label} | ${counts[k.kind] ?? 0} | ${k.importable ? "imported" : "read-only"} |`;
  const code = config.crews.filter((c) => c.definition === "code").map((c) => c.key);
  return [
    "# CrewAI configuration",
    "",
    `The CrewAI setup of ${meta.source} as files: every crew with its agents and tasks, every flow, skill, schedule and`,
    "content source, and, read-only, the tools, prompt guardrails and model providers they run with. This folder is the",
    "source the site's configuration is restored from after a deployment, and every change to it is a reviewed commit.",
    "",
    "Written by the CMS (AI & SEO → Configuration → Export, or Write to repository). Edit the files here or in the admin's",
    "repository editor; `manifest.json` is rewritten by both (an import only warns when a checksum in it is stale).",
    "",
    "| Folder | What | Items | On import |",
    "|---|---|---|---|",
    ...KINDS.map(row),
    "",
    "## Editing",
    "",
    "- **Agents, tasks and skills** are Markdown: the front matter holds the fields, the body the long text (an agent's",
    "  backstory, a task's instructions with its `{placeholders}`, a skill's instructions).",
    `- **Crews defined in code** (${code.length ? code.map((c) => `\`${c}\``).join(", ") : "none"}) keep their structure in the SEO agent's code: change their`,
    "  agents' role, goal, backstory, model, limits and tools (from the crew's `code.allowed_tools`) and their tasks'",
    "  instructions and editable expected outputs. An import saves the difference from the code as a new crew version. Adding",
    "  or removing one of their agents or tasks is refused: duplicate the crew in the admin to change its structure.",
    "- **Crews and flows made in the admin** (`definition: spec`) are complete here and can be added, changed and removed.",
    "- **Removing a file** removes nothing on the site, unless the import is run with removal switched on",
    "  (it never removes what is defined in code or shipped with the CMS).",
    "- **No secrets**: keys and tokens never belong here. Providers list where a key is (`key_ref`), never the key; an export",
    "  redacts anything that looks like a credential and says so.",
    "",
    "## Checks",
    "",
    "`schemas/` has the JSON Schema of every file kind. Every import checks the files' schemas, that every reference",
    "resolves (a crew's agents and tasks, a flow's crews, a schedule's flow, a skill's agents, categories and sources), that",
    "no id is used twice, and then asks the SEO agent to check every crew and flow it would save. An import is a plan first",
    "(added, changed, unchanged, in conflict, removed), applied in one transaction, and verified afterwards.",
    "",
    `Format ${BUNDLE_FORMAT} (\`${BUNDLE_KIND}\`); the CMS also imports the one-file export of earlier versions (\`moks-crewai-config\`).`,
    "",
  ].join("\n");
}

const dirOf = (kind: Kind) => (COLLECTIONS[kind] ? COLLECTIONS[kind]! : PATTERNS.find((p) => p.kind === kind)!.re.source.replace(/^\^/, "").split("\\/")[0] + "/");

/** JSON Schema of every file kind (front matter for the Markdown ones). */
export function jsonSchemas(): Files {
  const id = (name: string) => `https://moks.dev/schemas/crewconfig/${BUNDLE_FORMAT}/${name}.schema.json`;
  const doc = (name: string, schema: z.ZodType, description: string) => JSON.stringify({ $id: id(name), title: name, description, ...(z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as object) }, null, 2) + "\n";
  const list = (kind: Kind, item: z.ZodType) => z.object({ [kind]: z.array(item) }).strict();
  return {
    "schemas/manifest.schema.json": doc("manifest", manifestSchema, "manifest.json"),
    "schemas/categories.schema.json": doc("categories", list("categories", categorySchema), COLLECTIONS.categories!),
    "schemas/crew.schema.json": doc("crew", crewSchema, "crews/<key>.yaml"),
    "schemas/agent.schema.json": doc("agent", agentSchema.omit({ backstory: true }), "Front matter of agents/<crew>/<agent>.md; the body is the backstory."),
    "schemas/task.schema.json": doc("task", taskSchema.omit({ instructions: true }), "Front matter of tasks/<crew>/<task>.md; the body is the instructions."),
    "schemas/flow.schema.json": doc("flow", flowSchema, "flows/<key>.yaml"),
    "schemas/skill.schema.json": doc("skill", skillSchema.omit({ instructions: true }), "Front matter of skills/<name>/SKILL.md; the body is the instructions."),
    "schemas/schedules.schema.json": doc("schedules", list("schedules", scheduleSchema), COLLECTIONS.schedules!),
    "schemas/sources.schema.json": doc("sources", list("sources", sourceSchema), COLLECTIONS.sources!),
    "schemas/tools.schema.json": doc("tools", list("tools", toolSchema), COLLECTIONS.tools!),
    "schemas/guardrails.schema.json": doc("guardrails", list("guardrails", guardrailSchema), COLLECTIONS.guardrails!),
    "schemas/providers.schema.json": doc("providers", list("providers", providerSchema), COLLECTIONS.providers!),
  };
}

/** Every file of the bundle: the items, the schemas, README.md and manifest.json. */
export function toFiles(config: CrewConfig, meta: ManifestMeta): Files {
  const counts = Object.fromEntries(KINDS.map((k) => [k.kind, (config[k.kind] as unknown[]).length]));
  const body: Files = { ...itemFiles(config), ...jsonSchemas() };
  body["README.md"] = readme(config, meta, counts);
  const manifest: Manifest = {
    kind: BUNDLE_KIND,
    format: BUNDLE_FORMAT,
    min_format: 1,
    generator: "moks-cms",
    exported_at: meta.exportedAt,
    source: meta.source,
    app: { cms: meta.cmsVersion, agent: meta.agentVersion },
    checksum: configChecksum(config),
    counts,
    inventory: Object.fromEntries(KINDS.map((k) => [k.kind, (config[k.kind] as unknown[]).map((i) => idOf(k.kind, i))])),
    dependencies: dependencies(config),
    compatibility: { crews: Object.fromEntries(config.crews.filter((c) => c.code).map((c) => [c.key, { prompt_version: c.code!.prompt_version, default_hash: c.code!.default_hash }])) },
    items: itemChecksums(config),
    files: Object.keys(body)
      .sort()
      .map((path) => ({ path, sha256: sha256(body[path]!) })),
    unsupported: meta.unsupported,
  };
  return sortFiles({ ...body, "manifest.json": JSON.stringify(manifest, null, 2) + "\n" });
}

const sortFiles = (f: Files): Files => Object.fromEntries(Object.keys(f).sort().map((k) => [k, f[k]!]));

// --- reading ------------------------------------------------------------------------------------------------------------

const SAFE_PATH = /^(?!.*\.\.)(?!\/)[A-Za-z0-9_.\/-]{1,300}$/;

function yaml(text: string): unknown {
  return parseYaml(text, { schema: "core", merge: false, maxAliasCount: 100, uniqueKeys: true, prettyErrors: true, strict: true });
}

function frontMatter(text: string): { meta: unknown; body: string } {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!m) throw new Error("starts with front matter between --- lines");
  return { meta: yaml(m[1]!) ?? {}, body: m[2]!.replace(/^\s*\n/, "").trimEnd() };
}

const zodIssues = (path: string, e: z.ZodError, prefix = ""): Issue[] => e.issues.slice(0, 20).map((i) => ({ path, severity: "error" as const, message: `${prefix}${i.path.map(String).join(".") || "file"}: ${i.message}` }));

export type Parsed = { config: CrewConfig; manifest: Manifest | null; issues: Issue[]; paths: Map<string, string> };

/**
 * Files → configuration. Every problem is an issue with its file; a file with an error contributes nothing (so the
 * import refuses rather than applying half a crew). `paths` maps "kind:id" to the file it came from.
 */
export function fromFiles(files: Files): Parsed {
  const config = emptyConfig();
  const issues: Issue[] = [];
  const paths = new Map<string, string>();
  const entries = Object.entries(files);
  if (entries.length > LIMITS.files) issues.push({ path: "", severity: "error", message: `At most ${LIMITS.files} files (this bundle has ${entries.length}).` });
  const total = entries.reduce((n, [, t]) => n + Buffer.byteLength(t), 0);
  if (total > LIMITS.totalBytes) issues.push({ path: "", severity: "error", message: `At most ${LIMITS.totalBytes / 1024 / 1024} MB of files (this bundle has ${(total / 1024 / 1024).toFixed(1)} MB).` });
  let manifest: Manifest | null = null;

  const add = (kind: Kind, path: string, raw: unknown, prefix = "") => {
    const info = KINDS.find((k) => k.kind === kind)!;
    const r = info.schema.safeParse(raw);
    if (!r.success) return void issues.push(...zodIssues(path, r.error, prefix));
    const id = idOf(kind, r.data);
    const k = ref(kind, id);
    if (paths.has(k)) return void issues.push({ path, severity: "error", message: `${prefix}${info.one} ${id} is also defined in ${paths.get(k)}` });
    paths.set(k, path);
    (config[kind] as unknown[]).push(r.data);
  };

  for (const [path, text] of entries.sort(([a], [b]) => a.localeCompare(b))) {
    if (!SAFE_PATH.test(path)) {
      issues.push({ path, severity: "error", message: "Not a safe relative path (letters, digits, . _ - / only, no ..)." });
      continue;
    }
    if (Buffer.byteLength(text) > LIMITS.fileBytes) {
      issues.push({ path, severity: "error", message: `Larger than ${LIMITS.fileBytes / 1024} KB.` });
      continue;
    }
    try {
      if (path === "manifest.json") {
        const r = manifestSchema.safeParse(JSON.parse(text));
        if (r.success) manifest = r.data;
        else issues.push(...zodIssues(path, r.error));
        continue;
      }
      if (/(^|\/)README\.md$/.test(path) || /^schemas\/[a-z-]+\.schema\.json$/.test(path)) continue;
      const collection = BY_COLLECTION.get(path);
      if (collection) {
        const doc = yaml(text) as Record<string, unknown> | null;
        if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error(`holds an object with a "${collection}" list`);
        const extra = Object.keys(doc).filter((k) => k !== collection);
        if (extra.length) issues.push({ path, severity: "error", message: `Unknown top-level ${extra.length === 1 ? "key" : "keys"}: ${extra.join(", ")} (only ${collection}).` });
        const list = doc[collection] ?? [];
        if (!Array.isArray(list)) throw new Error(`"${collection}" is a list`);
        list.forEach((item, i) => add(collection, path, item, `${collection}[${i}].`));
        continue;
      }
      const pattern = PATTERNS.find((p) => p.re.test(path));
      if (!pattern) {
        issues.push({ path, severity: "warning", message: "Not part of the bundle layout: ignored." });
        continue;
      }
      const ids = pattern.ids(path.match(pattern.re)!);
      let raw: Record<string, unknown>;
      if (path.endsWith(".md")) {
        const { meta, body } = frontMatter(text);
        if (!meta || typeof meta !== "object" || Array.isArray(meta)) throw new Error("front matter is a YAML object");
        const bodyField = pattern.kind === "agents" ? "backstory" : "instructions";
        raw = { ...ids, ...(meta as Record<string, unknown>), [bodyField]: body };
      } else {
        const doc = yaml(text);
        if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("holds a YAML object");
        raw = { ...ids, ...(doc as Record<string, unknown>) };
      }
      const mismatch = Object.entries(ids).filter(([k, v]) => raw[k] !== v);
      if (mismatch.length) {
        issues.push({ path, severity: "error", message: `${mismatch.map(([k]) => `${k} ${String(raw[k])}`).join(", ")} differs from the file's name (${Object.values(ids).join("/")}): rename the file or fix the field.` });
        continue;
      }
      add(pattern.kind, path, raw);
    } catch (e) {
      issues.push({ path, severity: "error", message: `Cannot read it: ${String((e as Error).message ?? e).split("\n")[0]!.slice(0, 300)}` });
    }
  }
  return { config, manifest, issues, paths };
}

/**
 * The manifest against the files: a format this CMS reads, and checksums that match. A stale checksum is a warning
 * (someone edited a file by hand); a newer format is an error.
 */
export function verifyManifest(files: Files, parsed: Parsed): Issue[] {
  const m = parsed.manifest;
  if (!m) return [{ path: "manifest.json", severity: "warning", message: "No manifest.json: the files are imported as they are (an export writes one)." }];
  const out: Issue[] = [];
  if (m.format > BUNDLE_FORMAT) out.push({ path: "manifest.json", severity: "error", message: `Bundle format ${m.format} is newer than this CMS reads (${BUNDLE_FORMAT}): update the CMS first.` });
  const listed = new Map((m.files ?? []).map((f) => [f.path, f.sha256]));
  const stale = Object.keys(files).filter((p) => p !== "manifest.json" && listed.has(p) && listed.get(p) !== sha256(files[p]!));
  const unlisted = Object.keys(files).filter((p) => p !== "manifest.json" && kindOfPath(p) && m.files && !listed.has(p));
  const missing = [...listed.keys()].filter((p) => kindOfPath(p) && !(p in files));
  if (stale.length) out.push({ path: "manifest.json", severity: "warning", message: `Changed since the manifest was written: ${stale.slice(0, 10).join(", ")}${stale.length > 10 ? ` and ${stale.length - 10} more` : ""}.` });
  if (unlisted.length) out.push({ path: "manifest.json", severity: "warning", message: `Not in the manifest (added since): ${unlisted.slice(0, 10).join(", ")}.` });
  if (missing.length) out.push({ path: "manifest.json", severity: "warning", message: `In the manifest but not in the files (removed since): ${missing.slice(0, 10).join(", ")}. A removed file removes nothing unless the import removes.` });
  return out;
}

/** A new manifest for edited files (the repository editor rewrites it with every commit). */
export function rewriteManifest(files: Files, meta: Omit<ManifestMeta, "unsupported"> & { unsupported?: ManifestMeta["unsupported"] }): Files {
  const parsed = fromFiles(files);
  const old = parsed.manifest;
  const regenerated = toFiles(parsed.config, { ...meta, unsupported: meta.unsupported ?? old?.unsupported ?? [] });
  // Keep the files as they are (a person's formatting and comments); only the manifest and the generated parts change.
  const out: Files = { ...files };
  for (const p of Object.keys(regenerated)) if (p === "README.md" || p.startsWith("schemas/")) out[p] = regenerated[p]!;
  const m = JSON.parse(regenerated["manifest.json"]!) as Manifest;
  m.files = Object.keys(out)
    .filter((p) => p !== "manifest.json")
    .sort()
    .map((path) => ({ path, sha256: sha256(out[path]!) }));
  out["manifest.json"] = JSON.stringify(m, null, 2) + "\n";
  return sortFiles(out);
}
