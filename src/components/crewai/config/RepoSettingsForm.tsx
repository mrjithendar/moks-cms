"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, Button, Field, Input, Select } from "@/components/ui/form";
import type { RepoSummary } from "@/lib/crewai/bundle/repo";
import { BASE, call } from "./api";

/** Which repository, branch and folder hold crewconfig/, how changes land, and the GitHub token (never shown back). */
export function RepoSettingsForm({ summary }: { summary: RepoSummary }) {
  const router = useRouter();
  const [repo, setRepo] = useState(summary.repo);
  const [branch, setBranch] = useState(summary.branch);
  const [path, setPath] = useState(summary.path);
  const [mode, setMode] = useState(summary.mode);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "error" | "success"; text: string } | null>(null);

  const save = async (removeToken = false) => {
    setBusy("save");
    setMsg(null);
    try {
      await call(`${BASE}/repo`, { method: "PUT", body: { repo, branch, path, mode, ...(removeToken ? { token: "" } : token ? { token } : {}) } });
      setToken("");
      setMsg({ tone: "success", text: "Saved." });
      router.refresh();
    } catch (e) {
      setMsg({ tone: "error", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };
  const test = async () => {
    setBusy("test");
    setMsg(null);
    try {
      const r = await call<{ canPush: boolean; commit: string; files: number }>(`${BASE}/repo`, { method: "POST", body: { action: "test" } });
      setMsg({ tone: r.canPush ? "success" : "error", text: `${summary.repo} answers: ${summary.branch} is at ${r.commit.slice(0, 7)}, ${r.files} files in ${summary.path}/. ${r.canPush ? "The token can push." : "The token cannot push: give it Contents (read and write) and Pull requests (read and write)."}` });
    } catch (e) {
      setMsg({ tone: "error", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };
  return (
    <form className="space-y-4" onSubmit={(e) => (e.preventDefault(), save())}>
      {summary.source === "env" && <Alert tone="info">These come from the deployment (CREWAI_CONFIG_REPO…). Saving here overrides them.</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Repository" htmlFor="repo" hint="owner/name on GitHub, the site's own repository"><Input id="repo" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="mrjithendar/jithendar.com" required /></Field>
        <Field label="Branch" htmlFor="branch"><Input id="branch" value={branch} onChange={(e) => setBranch(e.target.value)} required /></Field>
        <Field label="Folder" htmlFor="path" hint="Where the configuration lives in the repository"><Input id="path" value={path} onChange={(e) => setPath(e.target.value)} required /></Field>
        <Field label="Changes from the admin" htmlFor="mode" hint="A pull request when the branch is protected or changes are reviewed">
          <Select id="mode" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
            <option value="pull_request">Open a pull request</option>
            <option value="commit">Commit to the branch</option>
          </Select>
        </Field>
        <Field label="GitHub token" htmlFor="token" hint={summary.tokenSource === "admin" ? "Saved (sealed). Leave empty to keep it." : summary.tokenSource === "env" ? "The deployment's CREWAI_CONFIG_GITHUB_TOKEN is used. A token saved here wins." : "A fine-grained token for this one repository: Contents and Pull requests, read and write."}>
          <Input id="token" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder={summary.hasToken ? "••••••••" : "github_pat_…"} />
        </Field>
      </div>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy !== null}>{busy === "save" ? "Saving…" : "Save"}</Button>
        <Button type="button" variant="secondary" onClick={test} disabled={busy !== null || !summary.configured}>{busy === "test" ? "Testing…" : "Test connection"}</Button>
        {summary.tokenSource === "admin" && <Button type="button" variant="ghost" onClick={() => save(true)} disabled={busy !== null}>Remove the saved token</Button>}
      </div>
    </form>
  );
}
