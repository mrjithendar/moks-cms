import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { siteUrl } from "@/config/site";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { broadcastInvalidate, onInvalidate } from "@/lib/cache-bus";
import type { Actor } from "@/lib/posts";
import { seal, unseal, type Sealed } from "@/lib/secrets";
import { configChecksum, fromFiles, itemChecksums, kindOfPath, rewriteManifest, toFiles, type Files } from "./files";
import { exportRuntime } from "./runtime";
import { forgetStatus, recordSync } from "./sync";

/**
 * The site repository's crewconfig/ folder on GitHub (D-101): the CrewAI configuration's source of truth in Git.
 * The admin reads it, edits files (a commit on the branch, or a pull request when the repository asks for reviews),
 * shows a file's history and an earlier version, reverts, writes the running configuration to it, and imports it.
 *
 * Access: one fine-grained GitHub token with Contents (read and write) and Pull requests (read and write) on that one
 * repository, saved here (sealed with SETTINGS_ENCRYPTION_KEY, never sent back) or given to the deployment as
 * CREWAI_CONFIG_GITHUB_TOKEN from a Kubernetes Secret. Repository, branch and folder: saved here, else
 * CREWAI_CONFIG_REPO / CREWAI_CONFIG_BRANCH / CREWAI_CONFIG_PATH. Nothing here runs code from the repository: the files
 * are text, read through the bundle parser like any import.
 *
 * Concurrency: every save names the commit it was based on and the blob each file had; a file changed in Git since
 * (by anyone) is a conflict (409), and the branch moves only fast-forward.
 */

const KEY = "crewai-repository";
const API = "https://api.github.com";
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const BRANCH_RE = /^(?!.*\.\.)(?!\/)[A-Za-z0-9._\/-]{1,200}(?<!\/)$/;
const DIR_RE = /^(?!.*\.\.)[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

export type RepoMode = "commit" | "pull_request";
type Stored = { repo: string; branch: string; path: string; mode: RepoMode; token: Sealed | null; updatedAt: string; updatedBy: string };
export type RepoSettings = { repo: string; branch: string; path: string; mode: RepoMode; token: string | null; source: "admin" | "env" | "none" };
export type RepoSummary = Omit<RepoSettings, "token"> & { hasToken: boolean; tokenSource: "admin" | "env" | "none"; webUrl: string | null; configured: boolean };

export class RepoError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly issues: string[] = [],
  ) {
    super(message);
  }
}

let cached: Promise<Stored | null> | null = null;
// The repository is an integration: its settings follow the integrations' invalidation across replicas.
onInvalidate("integrations", () => {
  cached = null;
});

async function readStored(): Promise<Stored | null> {
  cached ??= (async () => {
    const db = await getDb();
    const [row] = await db.select().from(schema.setting).where(eq(schema.setting.key, KEY));
    return (row?.value as Stored | undefined) ?? null;
  })().catch((e) => {
    cached = null;
    throw e;
  });
  return cached;
}

export async function repoSettings(env: Record<string, string | undefined> = process.env): Promise<RepoSettings> {
  const s = await readStored().catch(() => null);
  const envToken = env.CREWAI_CONFIG_GITHUB_TOKEN?.trim() || null;
  if (s) return { repo: s.repo, branch: s.branch, path: s.path, mode: s.mode, token: s.token ? unseal(s.token) : envToken, source: "admin" };
  if (env.CREWAI_CONFIG_REPO) return { repo: env.CREWAI_CONFIG_REPO.trim(), branch: env.CREWAI_CONFIG_BRANCH?.trim() || "master", path: env.CREWAI_CONFIG_PATH?.trim() || "crewconfig", mode: env.CREWAI_CONFIG_MODE === "commit" ? "commit" : "pull_request", token: envToken, source: "env" };
  return { repo: "", branch: "master", path: "crewconfig", mode: "pull_request", token: envToken, source: "none" };
}

export async function repoSummary(env: Record<string, string | undefined> = process.env): Promise<RepoSummary> {
  const s = await repoSettings(env);
  const stored = await readStored().catch(() => null);
  const { token, ...rest } = s;
  return { ...rest, hasToken: Boolean(token), tokenSource: stored?.token ? "admin" : env.CREWAI_CONFIG_GITHUB_TOKEN ? "env" : "none", webUrl: s.repo ? `https://github.com/${s.repo}/tree/${encodeURIComponent(s.branch)}/${s.path}` : null, configured: Boolean(s.repo && token) };
}

const settingsInput = z
  .object({
    repo: z.string().trim().regex(REPO_RE, "owner/name, as in github.com/owner/name"),
    branch: z.string().trim().regex(BRANCH_RE, "a branch name").default("master"),
    path: z.string().trim().regex(DIR_RE, "a folder of the repository, such as crewconfig").default("crewconfig"),
    mode: z.enum(["commit", "pull_request"]).default("pull_request"),
    /** Left out: keep the saved token. "": remove it (the deployment's CREWAI_CONFIG_GITHUB_TOKEN applies, if any). */
    token: z.string().trim().max(400).optional(),
  })
  .strict();

export async function saveRepoSettings(actor: Actor, raw: unknown): Promise<RepoSummary> {
  if (actor.role !== "admin") throw new RepoError("Only admins can change the configuration repository.", 403);
  const r = settingsInput.safeParse(raw);
  if (!r.success) throw new RepoError("Check the repository settings.", 400, r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  const cur = await readStored();
  const token = r.data.token === undefined ? (cur?.token ?? null) : r.data.token === "" ? null : seal(r.data.token);
  const next: Stored = { repo: r.data.repo, branch: r.data.branch, path: r.data.path.replace(/\/+$/, ""), mode: r.data.mode, token, updatedAt: new Date().toISOString(), updatedBy: actor.label };
  const db = await getDb();
  await db.insert(schema.setting).values({ key: KEY, value: next, updatedBy: actor.id }).onConflictDoUpdate({ target: schema.setting.key, set: { value: next, updatedBy: actor.id, updatedAt: new Date() } });
  cached = null;
  broadcastInvalidate("integrations");
  await audit(actor, "crewai.config.repository", next.repo, { branch: next.branch, path: next.path, mode: next.mode, tokenChanged: r.data.token !== undefined });
  return repoSummary();
}

// --- GitHub -------------------------------------------------------------------------------------------------------------

export type GitDeps = { fetchImpl?: typeof fetch; env?: Record<string, string | undefined> };

type Ctx = { s: RepoSettings; owner: string; name: string; f: typeof fetch };

async function ctxOf(deps: GitDeps = {}): Promise<Ctx> {
  const s = await repoSettings(deps.env);
  if (!s.repo) throw new RepoError("No configuration repository yet: set it under AI & SEO → Configuration → Repository.", 409);
  if (!s.token) throw new RepoError("No GitHub token for the configuration repository: save one under Repository, or give the deployment CREWAI_CONFIG_GITHUB_TOKEN.", 409);
  const [owner, name] = s.repo.split("/") as [string, string];
  return { s, owner, name, f: deps.fetchImpl ?? fetch };
}

async function gh<T>(c: Ctx, method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await c.f(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${c.s.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "moks-cms", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    });
  } catch {
    throw new RepoError("GitHub did not answer. Try again.", 503);
  }
  const text = await res.text();
  const data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) {
    const msg = String(data.message ?? `GitHub error ${res.status}`).slice(0, 300);
    if (res.status === 401) throw new RepoError("GitHub refused the token (expired or revoked): save a new one.", 502);
    if (res.status === 403) throw new RepoError(`GitHub refused: ${msg}. The token needs Contents and Pull requests (read and write) on ${c.s.repo}.`, 502);
    if (res.status === 404) throw new RepoError(`Not found on GitHub: ${msg} (${c.s.repo}, branch ${c.s.branch}). Check the repository and the token's access.`, 404);
    if (res.status === 409 || res.status === 422) throw new RepoError(`GitHub: ${msg}`, 409);
    throw new RepoError(`GitHub error ${res.status}: ${msg}`, 502);
  }
  return data as T;
}

const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");

export async function headOf(c: Ctx, branch = c.s.branch): Promise<string> {
  const r = await gh<{ commit: { sha: string } }>(c, "GET", `/repos/${c.owner}/${c.name}/branches/${encodeURIComponent(branch)}`);
  return r.commit.sha;
}

type TreeEntry = { path: string; type: string; sha: string; size?: number };

/** The folder's blobs at a commit: {path inside the folder → blob sha}. Empty when the folder does not exist yet. */
async function folderTree(c: Ctx, commit: string): Promise<Map<string, { sha: string; size: number }>> {
  const out = new Map<string, { sha: string; size: number }>();
  let tree = (await gh<{ tree: { sha: string } }>(c, "GET", `/repos/${c.owner}/${c.name}/git/commits/${commit}`)).tree.sha;
  for (const part of c.s.path.split("/")) {
    const t = await gh<{ tree: TreeEntry[] }>(c, "GET", `/repos/${c.owner}/${c.name}/git/trees/${tree}`);
    const e = t.tree.find((x) => x.path === part && x.type === "tree");
    if (!e) return out;
    tree = e.sha;
  }
  const all = await gh<{ tree: TreeEntry[]; truncated?: boolean }>(c, "GET", `/repos/${c.owner}/${c.name}/git/trees/${tree}?recursive=1`);
  if (all.truncated) throw new RepoError(`The folder ${c.s.path} has too many files for GitHub to list at once.`, 413);
  for (const e of all.tree) if (e.type === "blob") out.set(e.path, { sha: e.sha, size: e.size ?? 0 });
  return out;
}

/** Blob texts, 100 per GraphQL request. */
async function blobs(c: Ctx, shas: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < shas.length; i += 100) {
    const part = shas.slice(i, i + 100);
    const fields = part.map((s, j) => `b${j}: object(oid: "${s}") { ... on Blob { text isBinary } }`).join("\n");
    const r = await gh<{ data?: { repository?: Record<string, { text: string | null; isBinary: boolean } | null> }; errors?: { message: string }[] }>(c, "POST", "/graphql", { query: `query($o: String!, $n: String!) { repository(owner: $o, name: $n) { ${fields} } }`, variables: { o: c.owner, n: c.name } });
    if (r.errors?.length) throw new RepoError(`GitHub: ${r.errors[0]!.message}`, 502);
    part.forEach((s, j) => {
      const b = r.data?.repository?.[`b${j}`];
      if (b && !b.isBinary && b.text != null) out.set(s, b.text);
    });
  }
  return out;
}

export type RepoFile = { path: string; sha: string; size: number; kind: string | null };
export type RepoTree = { repo: string; branch: string; dir: string; commit: string; files: RepoFile[] };

export async function repoTree(deps: GitDeps = {}, ref?: string): Promise<RepoTree> {
  const c = await ctxOf(deps);
  const commit = ref && /^[0-9a-f]{40}$/.test(ref) ? ref : await headOf(c, ref);
  const tree = await folderTree(c, commit);
  return { repo: c.s.repo, branch: c.s.branch, dir: c.s.path, commit, files: [...tree].sort(([a], [b]) => a.localeCompare(b)).map(([path, v]) => ({ path, sha: v.sha, size: v.size, kind: kindOfPath(path) })) };
}

/** Every text file of the folder at a commit (the branch head by default). */
export async function repoFiles(deps: GitDeps = {}, ref?: string): Promise<{ commit: string; files: Files; shas: Record<string, string> }> {
  const c = await ctxOf(deps);
  const commit = ref && /^[0-9a-f]{40}$/.test(ref) ? ref : await headOf(c, ref);
  const tree = await folderTree(c, commit);
  const texts = await blobs(c, [...new Set([...tree.values()].map((v) => v.sha))]);
  const files: Files = {};
  const shas: Record<string, string> = {};
  for (const [p, v] of tree) {
    const t = texts.get(v.sha);
    if (t !== undefined) files[p] = t;
    shas[p] = v.sha;
  }
  return { commit, files, shas };
}

/** One file at a commit (null: it did not exist there). */
export async function repoFileAt(path: string, ref: string, deps: GitDeps = {}): Promise<{ text: string; sha: string } | null> {
  const c = await ctxOf(deps);
  try {
    const r = await gh<{ content?: string; encoding?: string; sha: string; type: string }>(c, "GET", `/repos/${c.owner}/${c.name}/contents/${enc(`${c.s.path}/${path}`)}?ref=${encodeURIComponent(ref)}`);
    if (r.type !== "file" || r.encoding !== "base64" || r.content == null) return null;
    return { text: Buffer.from(r.content, "base64").toString("utf8"), sha: r.sha };
  } catch (e) {
    if (e instanceof RepoError && e.status === 404) return null;
    throw e;
  }
}

export type RepoCommit = { sha: string; message: string; author: string; date: string; url: string };

/** Commits that changed the folder (or one file of it), newest first. */
export async function repoHistory(path: string | null, deps: GitDeps = {}, limit = 30): Promise<RepoCommit[]> {
  const c = await ctxOf(deps);
  const p = path ? `${c.s.path}/${path}` : c.s.path;
  type Row = { sha: string; html_url: string; commit: { message: string; author: { name: string; date: string } | null } };
  const list = await gh<Row[]>(c, "GET", `/repos/${c.owner}/${c.name}/commits?sha=${encodeURIComponent(c.s.branch)}&path=${encodeURIComponent(p)}&per_page=${Math.min(100, Math.max(1, limit))}`);
  return list.map((x) => ({ sha: x.sha, message: x.commit.message, author: x.commit.author?.name ?? "", date: x.commit.author?.date ?? "", url: x.html_url }));
}

export type SaveResult = { commit: string; branch: string; pullRequest: { number: number; url: string } | null; files: string[] };
export type Author = { name: string; email: string };

/**
 * Write files to the folder as one commit: on the branch (mode commit) or on a new branch with a pull request (mode
 * pull_request). `base` is the commit the editor started from; `expected` the blob each changed file had then (null: it
 * did not exist). The full folder after the change must read as a bundle without errors; the manifest, README and
 * schemas are rewritten to match.
 */
export async function saveRepoFiles(
  input: { changes: Record<string, string | null>; base: string; expected?: Record<string, string | null>; message: string; author: Author; mode?: RepoMode },
  actor: Actor,
  deps: GitDeps = {},
): Promise<SaveResult> {
  if (actor.role !== "admin") throw new RepoError("Only admins can change the configuration.", 403);
  const c = await ctxOf(deps);
  const paths = Object.keys(input.changes);
  if (!paths.length) throw new RepoError("Nothing to save.", 400);
  for (const p of paths) if (!/^(?!.*\.\.)[A-Za-z0-9_./-]{1,300}$/.test(p) || p.startsWith("/")) throw new RepoError(`Not a safe path: ${p}`, 400);
  const head = await headOf(c);
  const current = await repoFiles(deps, head);
  // Conflicts: a file this save changes that changed in Git since the editor read it (its blob then, or at `base`).
  const atBase = head !== input.base && paths.some((p) => !input.expected || !(p in input.expected)) ? await folderTree(c, input.base) : null;
  const stale = paths.filter((p) => {
    const then = input.expected && p in input.expected ? (input.expected[p] ?? null) : atBase ? (atBase.get(p)?.sha ?? null) : (current.shas[p] ?? null);
    return (current.shas[p] ?? null) !== then;
  });
  if (stale.length) {
    const who = await repoHistory(stale[0]!, deps, 1).catch(() => []);
    throw new RepoError(`Changed in Git since you opened it${who[0] ? ` (${who[0].author}, ${who[0].sha.slice(0, 7)}: ${who[0].message.split("\n")[0]})` : ""}: reload and apply your change again.`, 409, stale);
  }
  const next: Files = { ...current.files };
  for (const [p, t] of Object.entries(input.changes)) {
    if (t === null) delete next[p];
    else next[p] = t.endsWith("\n") ? t : `${t}\n`;
  }
  const parsed = fromFiles(next);
  const errors = parsed.issues.filter((i) => i.severity === "error");
  if (errors.length) throw new RepoError("The configuration would not read after this change: nothing was saved.", 422, errors.map((i) => `${i.path}: ${i.message}`).slice(0, 30));
  const rewritten = rewriteManifest(next, { source: new URL(siteUrl()).host, exportedAt: new Date().toISOString(), cmsVersion: process.env.GIT_SHA ?? "dev", agentVersion: null });
  const changes: Record<string, string | null> = {};
  for (const [p, t] of Object.entries(rewritten)) if (current.files[p] !== t) changes[p] = t;
  for (const p of Object.keys(current.files)) if (!(p in rewritten)) changes[p] = null;
  // Only manifest.json differs (its time): nothing to commit.
  if (Object.keys(changes).every((p) => p === "manifest.json") && configChecksum(fromFiles(current.files).config) === configChecksum(parsed.config)) {
    return { commit: head, branch: c.s.branch, pullRequest: null, files: [] };
  }
  const result = await commit(c, head, changes, input.message, input.author, input.mode ?? c.s.mode);
  await audit(actor, "crewai.config.repository.commit", c.s.repo, { commit: result.commit, pullRequest: result.pullRequest?.number ?? null, files: result.files.slice(0, 50) });
  return result;
}

async function commit(c: Ctx, head: string, changes: Record<string, string | null>, message: string, author: Author, mode: RepoMode): Promise<SaveResult> {
  const base = await gh<{ tree: { sha: string } }>(c, "GET", `/repos/${c.owner}/${c.name}/git/commits/${head}`);
  const tree = await gh<{ sha: string }>(c, "POST", `/repos/${c.owner}/${c.name}/git/trees`, {
    base_tree: base.tree.sha,
    tree: Object.entries(changes).map(([p, t]) => (t === null ? { path: `${c.s.path}/${p}`, mode: "100644", type: "blob", sha: null } : { path: `${c.s.path}/${p}`, mode: "100644", type: "blob", content: t })),
  });
  const made = await gh<{ sha: string }>(c, "POST", `/repos/${c.owner}/${c.name}/git/commits`, { message, tree: tree.sha, parents: [head], author: { name: author.name.slice(0, 100) || "CMS admin", email: author.email.slice(0, 200) } });
  const files = Object.keys(changes).sort();
  if (mode === "commit") {
    try {
      await gh(c, "PATCH", `/repos/${c.owner}/${c.name}/git/refs/heads/${enc(c.s.branch)}`, { sha: made.sha, force: false });
    } catch (e) {
      if (e instanceof RepoError && e.status === 409) throw new RepoError(`${c.s.branch} moved while saving (someone pushed): reload and save again.`, 409);
      throw e;
    }
    return { commit: made.sha, branch: c.s.branch, pullRequest: null, files };
  }
  const branch = `crewconfig/${new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-")}-${made.sha.slice(0, 7)}`;
  await gh(c, "POST", `/repos/${c.owner}/${c.name}/git/refs`, { ref: `refs/heads/${branch}`, sha: made.sha });
  const pr = await gh<{ number: number; html_url: string }>(c, "POST", `/repos/${c.owner}/${c.name}/pulls`, { title: message.split("\n")[0]!.slice(0, 200), head: branch, base: c.s.branch, body: `${message}\n\nFiles:\n${files.map((f) => `- \`${c.s.path}/${f}\``).join("\n")}\n\nOpened from the CMS (AI & SEO → Configuration). Merging it imports the configuration on the next run of the site's crewconfig workflow.` });
  return { commit: made.sha, branch, pullRequest: { number: pr.number, url: pr.html_url }, files };
}

/** Put one file back as it was at an earlier commit (a new commit: history is never rewritten). */
export async function revertRepoFile(path: string, to: string, base: string, expected: string | null, actor: Actor, author: Author, deps: GitDeps = {}): Promise<SaveResult> {
  if (!/^[0-9a-f]{40}$/.test(to)) throw new RepoError("Name the commit to go back to.", 400);
  const old = await repoFileAt(path, to, deps);
  return saveRepoFiles({ changes: { [path]: old ? old.text : null }, base, expected: { [path]: expected }, message: `crewconfig: ${path} back to ${to.slice(0, 7)}`, author }, actor, deps);
}

/**
 * Write the configuration as it runs here to the repository (an export to Git): one commit or pull request with every
 * changed file, files of items that no longer exist removed. Refused while the export is incomplete (the agent down), so
 * a partial export never deletes a crew's files. In commit mode the export is the new baseline at once; in pull request
 * mode it becomes one when the merged configuration is imported.
 */
export async function writeRuntimeToRepo(actor: Actor, author: Author, deps: GitDeps & { message?: string } = {}): Promise<SaveResult & { unchanged: boolean }> {
  if (actor.role !== "admin") throw new RepoError("Only admins can change the configuration.", 403);
  const c = await ctxOf(deps);
  const rt = await exportRuntime();
  if (!rt.report.complete) throw new RepoError("The export is incomplete, so it was not written to Git (it would remove what it could not read).", 409, rt.report.unsupported.map((u) => `${u.component}: ${u.reason}`));
  const host = new URL(siteUrl()).host;
  const head = await headOf(c);
  const current = await repoFiles(deps, head);
  const files = toFiles(rt.config, { source: host, exportedAt: new Date().toISOString(), cmsVersion: process.env.GIT_SHA ?? "dev", agentVersion: rt.report.agent.version, unsupported: rt.report.unsupported });
  const changes: Record<string, string | null> = {};
  for (const [p, t] of Object.entries(files)) if (current.files[p] !== t) changes[p] = t;
  for (const p of Object.keys(current.files)) if (!(p in files) && (kindOfPath(p) || p.startsWith("schemas/"))) changes[p] = null;
  const same = configChecksum(fromFiles(current.files).config) === configChecksum(rt.config) && Object.keys(changes).every((p) => p === "manifest.json" || p === "README.md");
  if (same) return { commit: head, branch: c.s.branch, pullRequest: null, files: [], unchanged: true };
  const counts = Object.entries(rt.report.counts).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(", ");
  const message = deps.message?.trim() || `crewconfig: configuration of ${host} as it runs (${counts})`;
  const result = await commit(c, head, changes, `${message}\n\nWritten by ${author.name} from the CMS (AI & SEO → Configuration → Write to repository).`, author, c.s.mode);
  await recordSync({
    direction: "export",
    mode: "apply",
    source: "repository",
    status: c.s.mode === "commit" ? "applied" : "planned",
    policy: null,
    revision: result.commit,
    ref: result.branch,
    url: result.pullRequest?.url ?? `https://github.com/${c.s.repo}/commit/${result.commit}`,
    bundleChecksum: configChecksum(rt.config),
    runtimeChecksum: configChecksum(rt.config),
    summary: { files: result.files.length, pullRequest: result.pullRequest?.number ?? null, counts: rt.report.counts },
    error: null,
    actor: actor.label,
    baseline: c.s.mode === "commit" ? itemChecksums(rt.config) : null,
  });
  forgetStatus();
  await audit(actor, "crewai.config.export.repository", c.s.repo, { commit: result.commit, pullRequest: result.pullRequest?.number ?? null, files: result.files.length });
  return { ...result, unchanged: false };
}

/** The repository against what runs: the head commit, whether its configuration equals this site's, and how far. */
export async function repoCompare(deps: GitDeps = {}): Promise<{ commit: string; repoChecksum: string; runtimeChecksum: string; same: boolean; differs: string[]; onlyRepo: string[]; onlySite: string[]; issues: number }> {
  const { commit: head, files } = await repoFiles(deps);
  const parsed = fromFiles(files);
  const rt = await exportRuntime({ sync: false });
  const a = itemChecksums(parsed.config);
  const b = itemChecksums(rt.config);
  return {
    commit: head,
    repoChecksum: configChecksum(parsed.config),
    runtimeChecksum: configChecksum(rt.config),
    same: configChecksum(parsed.config) === configChecksum(rt.config),
    differs: Object.keys(a).filter((k) => k in b && a[k] !== b[k]).sort(),
    onlyRepo: Object.keys(a).filter((k) => !(k in b)).sort(),
    onlySite: Object.keys(b).filter((k) => !(k in a)).sort(),
    issues: parsed.issues.filter((i) => i.severity === "error").length,
  };
}

/** Check the settings and the token: the repository answers, the token may push, the branch exists. */
export async function testRepo(deps: GitDeps = {}): Promise<{ ok: true; canPush: boolean; commit: string; files: number }> {
  const c = await ctxOf(deps);
  const r = await gh<{ permissions?: { push?: boolean } }>(c, "GET", `/repos/${c.owner}/${c.name}`);
  const head = await headOf(c);
  const tree = await folderTree(c, head);
  return { ok: true, canPush: Boolean(r.permissions?.push), commit: head, files: tree.size };
}
