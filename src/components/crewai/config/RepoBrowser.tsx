"use client";

import { diffLines } from "diff";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ConfirmDialog } from "@/components/crewai/ConfirmDialog";
import { Alert, Button, Input } from "@/components/ui/form";
import type { Issue } from "@/lib/crewai/bundle/files";
import type { RepoCommit, RepoTree, SaveResult } from "@/lib/crewai/bundle/repo";
import { BASE, call } from "./api";
import { ConfigEditor } from "./ConfigEditor";

/**
 * crewconfig/ in the site repository: browse and search every file, open one in the editor, check it, save it (a commit
 * or a pull request, with the base commit and the file's blob so a change made in Git meanwhile is a conflict, never
 * overwritten), delete it, see its history, compare a version with the editor's text and put an older version back.
 * New crews, flows and skills start from a template. What is saved reaches the site when the folder is imported (the
 * site repository's crewconfig workflow on merge, a deployment, or Import from repository on the Overview).
 */

const GROUPS: { dir: string; label: string }[] = [
  { dir: "crews", label: "Crews" },
  { dir: "agents", label: "Agents" },
  { dir: "tasks", label: "Tasks" },
  { dir: "flows", label: "Flows" },
  { dir: "skills", label: "Skills" },
  { dir: "schedules", label: "Schedules" },
  { dir: "sources", label: "Content sources" },
  { dir: "categories", label: "Categories" },
  { dir: "tools", label: "Tools (read-only)" },
  { dir: "prompts", label: "Prompt guardrails (read-only)" },
  { dir: "providers", label: "Providers (read-only)" },
  { dir: "schemas", label: "Schemas (generated)" },
  { dir: "", label: "Manifest and README (generated)" },
];
const READ_ONLY = /^(tools|prompts|providers|schemas)\/|^manifest\.json$|^README\.md$/;

type Open = { path: string; text: string; sha: string | null; base: string; original: string };

const KEY = /^[a-z][a-z0-9_]{1,39}$/;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function templates(kind: "crew" | "flow" | "skill", key: string): Record<string, string> {
  if (kind === "crew")
    return {
      [`crews/${key}.yaml`]: `key: ${key}\nlabel: ${key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())} crew\ndescription: ''\ndefinition: spec\ncategories: [custom]\ntags: []\nenabled: false\nagents: [writer]\ntasks: [draft]\ninputs: [topic]\noutput: null\nmodel: null\n`,
      [`agents/${key}/writer.md`]: `---\nrole: Writer\ngoal: Write a short, accurate draft about the topic\ntools: [vector_search, read_article]\nmodel: null\nmax_tokens: null\nmax_iter: null\n---\n\nYou write for this site's readers. You only state what the sources say.\n`,
      [`tasks/${key}/draft.md`]: `---\nagent: writer\nlabel: Draft\nexpected_output: The draft in Markdown.\ncontext: []\n---\n\nWrite a draft about {topic}, using this site's related articles.\n`,
    };
  if (kind === "flow") return { [`flows/${key}.yaml`]: `key: ${key}\nlabel: ${key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())}\ndescription: ''\ndefinition: spec\nflow_name: custom_flow\ncategories: [custom]\ntags: []\nenabled: false\nspec:\n  inputs: [topic]\n  steps:\n    - kind: crew\n      crew: CHANGE_ME\n      inputs: {topic: '{topic}'}\n      save_as: draft\n` };
  return { [`skills/${key}/SKILL.md`]: `---\nname: ${key}\ndescription: When and why the agents should follow this skill.\nagents: [editorial.writer]\ntags: []\nenabled: true\nbuiltin: false\n---\n\nThe guidance, as short rules.\n` };
}

export function RepoBrowser({ webUrl }: { webUrl: string | null }) {
  const [tree, setTree] = useState<RepoTree | null>(null);
  const [q, setQ] = useState("");
  const [group, setGroup] = useState<string>("all");
  const [open, setOpen] = useState<Open | null>(null);
  const [extra, setExtra] = useState<Record<string, string>>({});
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SaveResult | null>(null);
  const [history, setHistory] = useState<RepoCommit[] | null>(null);
  const [compare, setCompare] = useState<{ sha: string; text: string | null } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [creating, setCreating] = useState<{ kind: "crew" | "flow" | "skill"; key: string } | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setTree(await call<RepoTree>(`${BASE}/repo/files`));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    let cancelled = false;
    call<RepoTree>(`${BASE}/repo/files`).then(
      (t) => !cancelled && setTree(t),
      (e: Error) => !cancelled && setError(e.message),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const files = useMemo(() => (tree?.files ?? []).filter((f) => (group === "all" || (group === "" ? !f.path.includes("/") : f.path.startsWith(`${group}/`))) && (!q || f.path.toLowerCase().includes(q.toLowerCase()))), [tree, q, group]);
  const dirty = open ? open.text !== open.original || Object.keys(extra).length > 0 : false;
  const readOnly = open ? READ_ONLY.test(open.path) : true;

  const openFile = async (path: string) => {
    if (dirty && !window.confirm("Discard your unsaved changes?")) return;
    setBusy("open");
    setError(null);
    setIssues(null);
    setSaved(null);
    setHistory(null);
    setCompare(null);
    setExtra({});
    try {
      const f = await call<{ text: string; sha: string }>(`${BASE}/repo/file?path=${encodeURIComponent(path)}&ref=${tree!.commit}`);
      setOpen({ path, text: f.text, sha: f.sha, base: tree!.commit, original: f.text });
      setMessage("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const startNew = () => {
    if (!creating || !tree) return;
    const ok = creating.kind === "skill" ? SLUG.test(creating.key) : KEY.test(creating.key);
    if (!ok) return setError(creating.kind === "skill" ? "A skill name is lower-case letters and digits with single dashes." : "A key is 2–40 lower-case letters, digits or _ and starts with a letter.");
    const t = templates(creating.kind, creating.key);
    const [first, ...rest] = Object.keys(t);
    if (tree.files.some((f) => f.path === first)) return setError(`${first} already exists.`);
    setOpen({ path: first!, text: t[first!]!, sha: null, base: tree.commit, original: "" });
    setExtra(Object.fromEntries(rest.map((p) => [p, t[p]!])));
    setMessage(`crewconfig: add ${creating.kind} ${creating.key}`);
    setCreating(null);
    setIssues(null);
    setSaved(null);
    setHistory(null);
  };

  const validate = async () => {
    if (!open) return;
    setBusy("validate");
    try {
      const r = await call<{ issues: Issue[]; context: boolean }>(`${BASE}/repo/validate`, { method: "POST", body: { path: open.path, text: open.text, more: extra } });
      setIssues(r.issues);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const save = async (text: string | null) => {
    if (!open) return;
    setBusy("save");
    setError(null);
    try {
      const r = await call<SaveResult>(`${BASE}/repo/file`, { method: "PUT", body: { path: open.path, text, base: open.base, expected: open.sha, message: message.trim() || undefined, ...(Object.keys(extra).length ? { more: extra } : {}) } });
      setSaved(r);
      setConfirmDelete(false);
      setExtra({});
      await load();
      if (text === null) setOpen(null);
      else if (r.pullRequest || r.files.length === 0) setOpen({ ...open, text, original: text }); // the branch is unchanged until the pull request merges
      else {
        // Committed: continue from the new commit and the file's new blob (the next save's conflict check).
        const f = await call<{ text: string; sha: string }>(`${BASE}/repo/file?path=${encodeURIComponent(open.path)}&ref=${r.commit}`);
        setOpen({ path: open.path, text: f.text, sha: f.sha, base: r.commit, original: f.text });
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const showHistory = async () => {
    if (!open) return;
    setBusy("history");
    try {
      setHistory((await call<{ items: RepoCommit[] }>(`${BASE}/repo/history?path=${encodeURIComponent(open.path)}`)).items);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const showCompare = async (sha: string) => {
    if (!open) return;
    setBusy("compare");
    try {
      const f = await call<{ text: string }>(`${BASE}/repo/file?path=${encodeURIComponent(open.path)}&ref=${sha}`).catch(() => ({ text: null as string | null }));
      setCompare({ sha, text: f.text });
    } finally {
      setBusy(null);
    }
  };

  const revert = async (sha: string) => {
    if (!open) return;
    setBusy("revert");
    setError(null);
    try {
      const r = await call<SaveResult>(`${BASE}/repo/revert`, { method: "POST", body: { path: open.path, to: sha, base: open.base, expected: open.sha } });
      setSaved(r);
      await load();
      setOpen(null);
      setHistory(null);
      setCompare(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <aside className="space-y-3">
        <Input aria-label="Search files" placeholder="Search files…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="Category" value={group} onChange={(e) => setGroup(e.target.value)} className="w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm">
          <option value="all">Everything</option>
          {GROUPS.map((g) => <option key={g.dir || "root"} value={g.dir}>{g.label}</option>)}
        </select>
        <div className="flex flex-wrap gap-2">
          {(["crew", "flow", "skill"] as const).map((k) => (
            <Button key={k} type="button" variant="secondary" size="sm" onClick={() => setCreating({ kind: k, key: "" })}>New {k}</Button>
          ))}
        </div>
        {creating && (
          <form className="space-y-2 rounded-lg border border-line p-3" onSubmit={(e) => (e.preventDefault(), startNew())}>
            <label className="block text-sm font-medium text-fg">New {creating.kind}: {creating.kind === "skill" ? "name" : "key"}</label>
            <Input autoFocus value={creating.key} onChange={(e) => setCreating({ ...creating, key: e.target.value.trim() })} placeholder={creating.kind === "skill" ? "kubernetes-upgrades" : "weekly_digest"} />
            <div className="flex gap-2"><Button type="submit" size="sm">Start from a template</Button><Button type="button" size="sm" variant="ghost" onClick={() => setCreating(null)}>Cancel</Button></div>
          </form>
        )}
        <nav aria-label="Configuration files" className="max-h-[60vh] overflow-auto rounded-lg border border-line">
          {!tree && !error && <p className="p-3 text-sm text-fg-muted">Loading…</p>}
          {tree && files.length === 0 && <p className="p-3 text-sm text-fg-muted">{tree.files.length ? "No file matches." : `crewconfig/ is empty in ${tree.repo}: write the running configuration to it from the Overview.`}</p>}
          <ul className="divide-y divide-line text-sm">
            {files.map((f) => (
              <li key={f.path}>
                <button type="button" onClick={() => openFile(f.path)} aria-current={open?.path === f.path ? "true" : undefined} className={`flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-xs hover:bg-surface-muted ${open?.path === f.path ? "bg-surface-muted text-fg" : "text-fg-muted"}`}>
                  <span className="min-w-0 flex-1 truncate" title={f.path}>{f.path}</span>
                  {READ_ONLY.test(f.path) && <span className="text-[10px] uppercase text-fg-subtle">read-only</span>}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        {tree && <p className="text-xs text-fg-subtle">{tree.repo} · {tree.branch} · <span className="font-mono">{tree.commit.slice(0, 7)}</span>{webUrl && <> · <a className="underline" href={webUrl} target="_blank" rel="noreferrer">GitHub</a></>}</p>}
      </aside>

      <section className="min-w-0 space-y-3">
        {error && <Alert>{error}</Alert>}
        {saved && (
          <Alert tone="success">
            {saved.files.length === 0 ? "Nothing changed." : saved.pullRequest ? <>Pull request <a className="underline" href={saved.pullRequest.url} target="_blank" rel="noreferrer">#{saved.pullRequest.number}</a> opened ({saved.files.length} files). Merging it imports the configuration.</> : <>Committed <span className="font-mono">{saved.commit.slice(0, 7)}</span> to {saved.branch} ({saved.files.length} files). The site imports it with the next run of the repository&apos;s crewconfig workflow.</>}
          </Alert>
        )}
        {!open ? (
          <p className="rounded-lg border border-dashed border-line p-6 text-sm text-fg-muted">Open a file to read or edit it. Crews, agents, tasks, flows, skills, schedules, sources and categories are editable; tools, guardrails and providers describe the code and the agent&apos;s settings and are read-only here.</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="min-w-0 flex-1 truncate font-mono text-sm text-fg">{open.path}{dirty && <span className="ml-2 text-amber-600">● unsaved</span>}{!open.sha && <span className="ml-2 text-emerald-600">new</span>}</h2>
              <Button type="button" size="sm" variant="secondary" onClick={validate} disabled={busy !== null}>Validate</Button>
              {open.sha && <Button type="button" size="sm" variant="secondary" onClick={showHistory} disabled={busy !== null}>History</Button>}
              {open.sha && !readOnly && <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmDelete(true)} disabled={busy !== null}>Delete</Button>}
            </div>
            {Object.keys(extra).length > 0 && <p className="text-xs text-fg-muted">Saved with it: {Object.keys(extra).map((p) => <code key={p} className="mr-2">{p}</code>)} (open them after saving to edit).</p>}
            <ConfigEditor path={open.path} value={open.text} readOnly={readOnly} onChange={(t) => setOpen((o) => (o ? { ...o, text: t } : o))} onSave={() => dirty && !readOnly && save(open.text)} />
            {issues && (
              issues.length === 0 ? <Alert tone="success">No problems found. The SEO agent checks crews, flows and schedules again when the folder is imported.</Alert> : (
                <Alert tone={issues.some((i) => i.severity === "error") ? "error" : "info"}>
                  <ul className="list-disc pl-5">{issues.slice(0, 30).map((i, n) => <li key={n}><span className="font-medium">{i.severity}</span> <code>{i.path}</code>: {i.message}</li>)}</ul>
                </Alert>
              )
            )}
            {!readOnly && (
              <div className="flex flex-wrap items-end gap-2">
                <label className="min-w-0 flex-1 text-sm">
                  <span className="mb-1 block text-xs font-medium text-fg-subtle">Commit message</span>
                  <Input value={message} onChange={(e) => setMessage(e.target.value)} placeholder={`crewconfig: ${open.sha ? "update" : "add"} ${open.path}`} />
                </label>
                <Button type="button" onClick={() => save(open.text)} disabled={busy !== null || !dirty}>{busy === "save" ? "Saving…" : "Save to Git"}</Button>
              </div>
            )}
            {history && (
              <div className="rounded-lg border border-line">
                <h3 className="border-b border-line px-3 py-2 text-sm font-semibold text-fg">History of {open.path}</h3>
                <ul className="divide-y divide-line text-sm">
                  {history.length === 0 && <li className="px-3 py-2 text-fg-muted">No commits yet.</li>}
                  {history.map((c) => (
                    <li key={c.sha} className="flex flex-wrap items-center gap-2 px-3 py-2">
                      <a href={c.url} target="_blank" rel="noreferrer" className="font-mono text-xs underline">{c.sha.slice(0, 7)}</a>
                      <span className="min-w-0 flex-1 truncate">{c.message.split("\n")[0]}</span>
                      <span className="text-xs text-fg-subtle">{c.author} · {c.date ? new Date(c.date).toLocaleString() : ""}</span>
                      <Button type="button" size="sm" variant="ghost" onClick={() => showCompare(c.sha)} disabled={busy !== null}>Compare</Button>
                      {!readOnly && <Button type="button" size="sm" variant="secondary" onClick={() => revert(c.sha)} disabled={busy !== null}>Revert to this</Button>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {compare && (
              <div className="rounded-lg border border-line">
                <h3 className="border-b border-line px-3 py-2 text-sm font-semibold text-fg">{open.path} at {compare.sha.slice(0, 7)} → the editor</h3>
                <pre className="max-h-96 overflow-auto p-3 font-mono text-xs leading-5">
                  {compare.text === null ? <span className="text-fg-muted">The file did not exist at that commit.</span> : diffLines(compare.text, open.text).map((part, i) => <span key={i} className={part.added ? "block bg-emerald-100 text-emerald-900 dark:bg-emerald-500/15 dark:text-emerald-200" : part.removed ? "block bg-red-100 text-red-900 dark:bg-red-500/15 dark:text-red-200" : "block text-fg-muted"}>{part.value.replace(/\n$/, "").split("\n").map((l) => `${part.added ? "+ " : part.removed ? "- " : "  "}${l}`).join("\n")}</span>)}
                </pre>
              </div>
            )}
          </>
        )}
      </section>
      <ConfirmDialog open={confirmDelete} title={`Delete ${open?.path ?? ""}?`} confirmLabel="Delete in Git" busy={busy === "save"} onCancel={() => setConfirmDelete(false)} onConfirm={() => save(null)}>
        <p>The file is removed from crewconfig/ in one {""}commit or pull request. The site keeps the item until an import runs with removal switched on; a crew&apos;s agent or task file cannot be removed while the crew lists it.</p>
      </ConfirmDialog>
    </div>
  );
}
