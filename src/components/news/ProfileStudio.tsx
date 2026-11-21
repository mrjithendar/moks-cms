"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Alert, Button, Input, Select, Textarea } from "@/components/ui/form";
import { api, usd, when } from "./api";
import { Field } from "./Fld";

type Profile = Record<string, unknown> & { key: string; version: number; name: string; status: string; created_at: string; created_by: string | null; explanation: string | null };
type Opt = { value: string; label: string };
type PlayResult = { a?: { version: number; title: string; body_mdx: string; dek: string; tokens: number; cost_usd: number; status: string; error?: string }; b?: PlayResult["a"]; error?: string };

const W_FIELDS = ["system_style", "structure_template", "tone", "audience"] as const;

/** Writing and image profiles: versions (active / proposed / archived), editor (always a new version), and the A/B playground. */
export function ProfileStudio({ writing, image, jobs, clusters }: { writing: Profile[]; image: Profile[]; jobs: Opt[]; clusters: Opt[] }) {
  const router = useRouter();
  const [kind, setKind] = useState<"writing" | "image">("writing");
  const rows = kind === "writing" ? writing : image;
  const keys = useMemo(() => [...new Set(rows.map((r) => r.key))], [rows]);
  const [key, setKey] = useState(keys[0] ?? "news-default");
  const versions = rows.filter((r) => r.key === key);
  const active = versions.find((v) => v.status === "active") ?? versions[0];
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [play, setPlay] = useState({ jobId: jobs[0]?.value ?? "", clusterId: clusters[0]?.value ?? "", versionA: active?.version ?? 1, versionB: 0 });
  const [result, setResult] = useState<PlayResult | null>(null);

  const start = (v: Profile | undefined) =>
    setDraft(v ? { ...v } : kind === "writing" ? { key: "", name: "", system_style: "", structure_template: "", tone: "", audience: "", banned_phrases: [], required_sections: ["Why it matters"], examples: [] } : { key: "", name: "", provider: "template", style_prompt: "", negative_prompt: "", template_fallback: true, variants: 2 });

  async function save(activate: boolean) {
    if (!draft) return;
    setBusy(true);
    setMsg(null);
    const pick = kind === "writing" ? ["key", "name", ...W_FIELDS, "banned_phrases", "required_sections", "examples", "temperature", "model"] : ["key", "name", "provider", "style_prompt", "negative_prompt", "aspect_ratios", "palette", "template_fallback", "variants", "safety_rules"];
    const profile = Object.fromEntries(pick.filter((k) => draft[k] !== undefined && draft[k] !== null).map((k) => [k, draft[k]]));
    try {
      const r = await api<{ key: string; version: number }>(`/api/admin/news/profiles/${kind}`, "POST", { profile, activate });
      setMsg({ ok: true, text: `Saved ${r.key} v${r.version}${activate ? " (active)" : ""}.` });
      setDraft(null);
      setKey(r.key);
      router.refresh();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function activate(v: Profile) {
    setBusy(true);
    try {
      await api(`/api/admin/news/profiles/${kind}`, "PUT", { key: v.key, version: v.version });
      setMsg({ ok: true, text: `${v.key} v${v.version} is now active.` });
      router.refresh();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function compare() {
    setBusy(true);
    setResult(null);
    setMsg(null);
    try {
      const r = await api<{ run_id: string }>("/api/admin/news/playground", "POST", { action: "compare", jobId: play.jobId, clusterId: play.clusterId, profileKey: key, versionA: play.versionA, versionB: play.versionB || null });
      for (let i = 0; i < 120; i++) {
        await new Promise((res) => setTimeout(res, 3000));
        const s = await api<{ status: string; result: PlayResult | null; error: string | null }>(`/api/admin/news/flow-runs/${r.run_id}`);
        if (!["queued", "running"].includes(s.status)) {
          setResult(s.result ?? { error: s.error ?? s.status });
          break;
        }
      }
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const list = (v: unknown) => (Array.isArray(v) ? v.join("\n") : "");
  const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end gap-3">
        <div role="tablist" className="flex gap-1">
          {(["writing", "image"] as const).map((k) => (
            <button key={k} role="tab" aria-selected={kind === k} type="button" onClick={() => { setKind(k); setDraft(null); setKey((k === "writing" ? writing : image)[0]?.key ?? ""); }} className={`min-h-11 rounded-lg px-3 text-sm font-medium ${kind === k ? "bg-accent text-white" : "bg-surface-muted text-fg-muted"}`}>
              {k === "writing" ? "Writing profiles" : "Image profiles"}
            </button>
          ))}
        </div>
        <Field label="Profile"><Select value={key} onChange={(e) => setKey(e.target.value)}>{keys.map((k) => <option key={k}>{k}</option>)}</Select></Field>
        <Button variant="secondary" onClick={() => start(active)}>Edit (new version)</Button>
        <Button variant="ghost" onClick={() => start(undefined)}>New profile</Button>
      </div>
      {msg && <Alert tone={msg.ok ? "success" : "error"}>{msg.text}</Alert>}

      {draft && (
        <section aria-labelledby="ed" className="space-y-4 rounded-xl border border-line p-4">
          <h2 id="ed" className="text-sm font-semibold">{draft.version ? `New version of ${String(draft.key)} (from v${String(draft.version)})` : "New profile"}</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Key" hint="lower-case, dashes"><Input value={String(draft.key ?? "")} disabled={Boolean(draft.version)} onChange={(e) => setDraft({ ...draft, key: e.target.value })} /></Field>
            <Field label="Name"><Input value={String(draft.name ?? "")} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field>
          </div>
          {kind === "writing" ? (
            <>
              {W_FIELDS.map((f) => (
                <Field key={f} label={f.replace(/_/g, " ")}><Textarea rows={f === "tone" || f === "audience" ? 2 : 5} value={String(draft[f] ?? "")} onChange={(e) => setDraft({ ...draft, [f]: e.target.value })} /></Field>
              ))}
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Banned phrases (one per line)"><Textarea rows={5} value={list(draft.banned_phrases)} onChange={(e) => setDraft({ ...draft, banned_phrases: lines(e.target.value) })} /></Field>
                <Field label="Required sections (one per line)"><Textarea rows={5} value={list(draft.required_sections)} onChange={(e) => setDraft({ ...draft, required_sections: lines(e.target.value) })} /></Field>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Model override"><Select value={String(draft.model ?? "")} onChange={(e) => setDraft({ ...draft, model: e.target.value || null })}><option value="">Default</option><option value="claude-sonnet-5-5">Claude Sonnet 5.5</option><option value="claude-haiku-5-5">Claude Haiku 5.5</option><option value="claude-opus-5-5">Claude Opus 5.5</option></Select></Field>
                <Field label="Temperature (optional)" hint="Kept for the record; the current Claude API does not take a temperature."><Input type="number" min={0} max={1} step={0.1} value={draft.temperature === null || draft.temperature === undefined ? "" : String(draft.temperature)} onChange={(e) => setDraft({ ...draft, temperature: e.target.value === "" ? null : Number(e.target.value) })} /></Field>
              </div>
            </>
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Provider"><Select value={String(draft.provider ?? "template")} onChange={(e) => setDraft({ ...draft, provider: e.target.value })}><option value="template">Template (free)</option><option value="gemini">Gemini</option><option value="openai">OpenAI</option></Select></Field>
                <Field label="Variants"><Input type="number" min={1} max={4} value={Number(draft.variants ?? 2)} onChange={(e) => setDraft({ ...draft, variants: Number(e.target.value) })} /></Field>
                <label className="flex min-h-11 items-center gap-2 self-end text-sm"><input type="checkbox" checked={Boolean(draft.template_fallback ?? true)} onChange={(e) => setDraft({ ...draft, template_fallback: e.target.checked })} /> Template fallback</label>
              </div>
              <Field label="Style prompt"><Textarea rows={3} value={String(draft.style_prompt ?? "")} onChange={(e) => setDraft({ ...draft, style_prompt: e.target.value })} /></Field>
              <Field label="Negative prompt" hint="People, faces, logos, trademarks and text are always excluded, whatever this says."><Textarea rows={2} value={String(draft.negative_prompt ?? "")} onChange={(e) => setDraft({ ...draft, negative_prompt: e.target.value })} /></Field>
            </>
          )}
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy} onClick={() => save(false)}>Save version</Button>
            <Button variant="secondary" disabled={busy} onClick={() => save(true)}>Save and activate</Button>
            <Button variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
          </div>
        </section>
      )}

      <section aria-labelledby="vers">
        <h2 id="vers" className="mb-3 text-sm font-semibold">Versions of {key}</h2>
        <ol className="space-y-3">
          {versions.map((v) => (
            <li key={v.version} className={`rounded-xl border p-4 text-sm ${v.status === "proposed" ? "border-violet-300 dark:border-violet-500/40" : "border-line"}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">v{v.version}</span>
                <span className={`rounded-full px-2 py-0.5 text-xs ${v.status === "active" ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-500/15 dark:text-emerald-200" : v.status === "proposed" ? "bg-violet-100 text-violet-900 dark:bg-violet-500/15 dark:text-violet-200" : "bg-surface-muted text-fg-muted"}`}>{v.status}</span>
                <span className="text-xs text-fg-subtle">{when(v.created_at)} · {v.created_by ?? "?"}</span>
                {v.status !== "active" && <Button size="sm" variant="secondary" className="ml-auto" disabled={busy} onClick={() => activate(v)}>{v.status === "proposed" ? "Approve & activate" : "Activate"}</Button>}
              </div>
              {v.explanation && <p className="mt-2 whitespace-pre-line text-fg-muted">{v.explanation}</p>}
              {Array.isArray(v.examples) && v.examples.length > 0 && (
                <details className="mt-2"><summary className="cursor-pointer text-xs">Before / after examples ({v.examples.length})</summary>
                  <ul className="mt-2 space-y-2 text-xs">{(v.examples as { before?: string; after?: string; why?: string }[]).map((x, i) => <li key={i} className="rounded border border-line p-2"><p><del>{x.before}</del></p><p><ins className="no-underline">{x.after}</ins></p>{x.why && <p className="text-fg-subtle">{x.why}</p>}</li>)}</ul>
                </details>
              )}
            </li>
          ))}
        </ol>
      </section>

      {kind === "writing" && (
        <section aria-labelledby="pg" className="space-y-4 rounded-xl border border-line p-4">
          <h2 id="pg" className="text-sm font-semibold">Playground (A/B)</h2>
          <p className="text-xs text-fg-subtle">Runs the News Desk Crew on a recent story with version A (and B). Costs tokens (shown) from the job&apos;s budget; nothing is saved to the review queue unless you click “Save as draft”.</p>
          <div className="grid gap-4 sm:grid-cols-4">
            <Field label="Job" hint="The trial writes the way this job does: a news story or a blog article, with the job's models. Its budget applies."><Select value={play.jobId} onChange={(e) => setPlay({ ...play, jobId: e.target.value })}>{jobs.map((j) => <option key={j.value} value={j.value}>{j.label}</option>)}</Select></Field>
            <Field label="Story"><Select value={play.clusterId} onChange={(e) => setPlay({ ...play, clusterId: e.target.value })}>{clusters.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</Select></Field>
            <Field label="Version A"><Select value={play.versionA} onChange={(e) => setPlay({ ...play, versionA: Number(e.target.value) })}>{versions.map((v) => <option key={v.version} value={v.version}>v{v.version} ({v.status})</option>)}</Select></Field>
            <Field label="Version B (optional)"><Select value={play.versionB} onChange={(e) => setPlay({ ...play, versionB: Number(e.target.value) })}><option value={0}>—</option>{versions.map((v) => <option key={v.version} value={v.version}>v{v.version} ({v.status})</option>)}</Select></Field>
          </div>
          <Button disabled={busy || !play.jobId || !play.clusterId} loading={busy} onClick={compare}>Run playground</Button>
          {result?.error && <Alert>{result.error}</Alert>}
          {result && (result.a || result.b) && (
            <div className="grid gap-4 lg:grid-cols-2">
              {(["a", "b"] as const).map((k) => {
                const r = result[k];
                if (!r) return null;
                return (
                  <article key={k} className="rounded-lg border border-line p-3 text-sm">
                    <p className="text-xs text-fg-subtle">{k.toUpperCase()} · v{r.version} · {r.status} · {r.tokens.toLocaleString("en")} tokens · {usd(r.cost_usd)}</p>
                    <h3 className="mt-1 font-semibold">{r.title}</h3>
                    {r.dek && <p className="text-fg-muted">{r.dek}</p>}
                    <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap text-xs">{r.body_mdx}</pre>
                    <Button size="sm" className="mt-2" variant="secondary" disabled={busy} onClick={async () => { try { await api("/api/admin/news/playground", "POST", { action: "save", jobId: play.jobId, clusterId: play.clusterId, version: r.version }); setMsg({ ok: true, text: "Drafting with this version; it goes through every quality gate before reaching the review queue." }); } catch (e) { setMsg({ ok: false, text: (e as Error).message }); } }}>Save as draft</Button>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
