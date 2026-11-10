"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, Button, Input, Select, Textarea } from "@/components/ui/form";
import { api, ago } from "./api";
import { Field } from "./Fld";

export type SourceRow = { id: string; name: string; type: string; url: string; topic_hints: string[]; credibility: number; fetch_interval_minutes: number; enabled: boolean; terms_note: string | null; last_fetch_at: string | null; last_success_at: string | null; last_status: string | null; error_count: number; consecutive_errors: number; fetch_count: number; avg_items: number; items_7d: number; approved_articles: number; inaccurate_articles: number };
type Suggestion = { id: string; name: string; current: number; suggested: number; basis: string };
const TYPES = ["rss", "atom", "json_api", "github_releases", "sitemap", "html_allowlisted"];
const blank = { name: "", type: "rss", url: "https://", topic_hints: [] as string[], credibility: 0.7, fetch_interval_minutes: 60, enabled: false, terms_note: "" };

/** Sources: health (last fetch, error rate, volume, contribution to approved articles), add/test, credibility. */
export function SourcesManager({ sources, suggestions }: { sources: SourceRow[]; suggestions: Suggestion[] }) {
  const router = useRouter();
  const [edit, setEdit] = useState<(typeof blank & { id?: string }) | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg({ ok: true, text: ok });
      router.refresh();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const save = (s: typeof blank & { id?: string }) => {
    const { id, ...body } = s;
    return run(() => api(id ? `/api/admin/news/sources/${id}` : "/api/admin/news/sources", id ? "PUT" : "POST", { ...body, terms_note: body.terms_note || null }), "Saved.").then(() => setEdit(null));
  };
  const toBody = (s: SourceRow) => ({ id: s.id, name: s.name, type: s.type, url: s.url, topic_hints: s.topic_hints, credibility: s.credibility, fetch_interval_minutes: s.fetch_interval_minutes, enabled: s.enabled, terms_note: s.terms_note ?? "" });
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => setEdit({ ...blank })}>Add source</Button>
        <Button variant="secondary" disabled={busy} onClick={() => run(() => api("/api/admin/news/sources", "POST", { action: "import_starters" }), "Starter sources imported (disabled). Review each one's terms, then enable it.")}>Import starter sources</Button>
      </div>
      {msg && <Alert tone={msg.ok ? "success" : "error"}>{msg.text}</Alert>}
      {suggestions.length > 0 && (
        <section aria-labelledby="sugg" className="rounded-xl border border-line p-4">
          <h2 id="sugg" className="text-sm font-semibold">Suggested credibility changes</h2>
          <p className="text-xs text-fg-subtle">From your approvals and “inaccurate” rejections. Nothing changes until you apply one.</p>
          <ul className="mt-2 space-y-2 text-sm">
            {suggestions.map((g) => {
              const s = sources.find((x) => x.id === g.id);
              return (
                <li key={g.id} className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{g.name}</span> {g.current.toFixed(2)} → <strong>{g.suggested.toFixed(2)}</strong> <span className="text-xs text-fg-subtle">({g.basis})</span>
                  {s && <Button size="sm" variant="secondary" disabled={busy} onClick={() => save({ ...toBody(s), credibility: g.suggested })}>Apply</Button>}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {edit && (
        <section aria-labelledby="edit" className="space-y-4 rounded-xl border border-line p-4">
          <h2 id="edit" className="text-sm font-semibold">{edit.id ? "Edit source" : "New source"}</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name"><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Type" hint="Prefer RSS/Atom or an official API. html_allowlisted reads one page and is for pages without a feed.">
              <Select value={edit.type} onChange={(e) => setEdit({ ...edit, type: e.target.value })}>{TYPES.map((t) => <option key={t}>{t}</option>)}</Select>
            </Field>
            <Field label="URL (https)"><Input value={edit.url} onChange={(e) => setEdit({ ...edit, url: e.target.value })} /></Field>
            <Field label="Topic hints"><Input value={edit.topic_hints.join(", ")} onChange={(e) => setEdit({ ...edit, topic_hints: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} /></Field>
            <Field label="Credibility (0–1)"><Input type="number" min={0} max={1} step={0.05} value={edit.credibility} onChange={(e) => setEdit({ ...edit, credibility: Number(e.target.value) })} /></Field>
            <Field label="Fetch interval (minutes)"><Input type="number" min={5} max={10080} value={edit.fetch_interval_minutes} onChange={(e) => setEdit({ ...edit, fetch_interval_minutes: Number(e.target.value) })} /></Field>
          </div>
          <Field label="Terms / licence note" hint="What the source's terms allow (docs/news/SOURCES.md). Paywalled hosts are refused."><Textarea rows={2} value={edit.terms_note} onChange={(e) => setEdit({ ...edit, terms_note: e.target.value })} /></Field>
          <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={edit.enabled} onChange={(e) => setEdit({ ...edit, enabled: e.target.checked })} /> Enabled</label>
          <div className="flex gap-2"><Button disabled={busy} onClick={() => save(edit)}>Save</Button><Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button></div>
        </section>
      )}
      <ul className="grid gap-3 lg:grid-cols-2">
        {sources.map((s) => {
          const errRate = s.fetch_count ? s.error_count / s.fetch_count : 0;
          const failing = s.consecutive_errors > 0;
          return (
            <li key={s.id} className={`rounded-xl border p-4 text-sm ${failing ? "border-red-300 dark:border-red-500/40" : "border-line"}`}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold text-fg">{s.name} {!s.enabled && <span className="text-xs font-normal text-fg-subtle">(disabled)</span>}</p>
                  <p className="truncate text-xs text-fg-subtle" title={s.url}>{s.type} · {s.url}</p>
                </div>
                <span className="text-xs tabular-nums">credibility {Number(s.credibility).toFixed(2)}</span>
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
                <div><dt className="text-fg-subtle">Last fetch</dt><dd>{ago(s.last_fetch_at)}</dd></div>
                <div><dt className="text-fg-subtle">Last success</dt><dd>{ago(s.last_success_at)}</dd></div>
                <div><dt className="text-fg-subtle">Error rate</dt><dd className={errRate > 0.2 ? "text-red-700 dark:text-red-300" : ""}>{(errRate * 100).toFixed(0)}% ({s.error_count}/{s.fetch_count})</dd></div>
                <div><dt className="text-fg-subtle">Items (7 d)</dt><dd className="tabular-nums">{s.items_7d} · avg {Number(s.avg_items).toFixed(1)}/fetch</dd></div>
                <div><dt className="text-fg-subtle">In approved articles</dt><dd className="tabular-nums">{s.approved_articles}</dd></div>
                <div><dt className="text-fg-subtle">“Inaccurate”</dt><dd className="tabular-nums">{s.inaccurate_articles}</dd></div>
              </dl>
              {s.last_status && s.last_status !== "ok" && <p className={`mt-2 text-xs ${failing ? "text-red-700 dark:text-red-300" : "text-fg-subtle"} [overflow-wrap:anywhere]`}>{s.last_status}</p>}
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" onClick={() => setEdit(toBody(s))}>Edit</Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => api(`/api/admin/news/sources/${s.id}`, "POST"), "Fetch started; see Run history.")}>Test now</Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => save({ ...toBody(s), enabled: !s.enabled })}>{s.enabled ? "Disable" : "Enable"}</Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => window.confirm(`Delete ${s.name}?`) && run(() => api(`/api/admin/news/sources/${s.id}`, "DELETE"), "Deleted.")}>Delete</Button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
