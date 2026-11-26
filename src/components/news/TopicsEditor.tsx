"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, Button, Input, Select } from "@/components/ui/form";
import { api } from "./api";

type Topic = { slug: string; label: string; category_slug: string | null; keywords: string[]; tags: string[]; enabled: boolean };
type Acc = Record<string, { precision?: number; recall?: number; f1?: number; support?: number; note?: string }>;

/** Topic taxonomy mapped to CMS categories, keywords for the rules fallback, suggested tags, classifier accuracy. */
export function TopicsEditor({ topics, categories, accuracy, model }: { topics: Topic[]; categories: { slug: string; label: string }[]; accuracy: Acc; model: { version: string; macro_f1: number | null; n: number } | null }) {
  const router = useRouter();
  const [rows, setRows] = useState(topics);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const upd = (i: number, patch: Partial<Topic>) => setRows((r) => r.map((t, k) => (k === i ? { ...t, ...patch } : t)));
  const csv = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
  async function save(t: Topic) {
    setBusy(true);
    try {
      await api("/api/admin/news/topics", "PUT", t);
      setMsg({ ok: true, text: `Saved ${t.slug}.` });
      router.refresh();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }
  async function train(bootstrap: boolean) {
    if (bootstrap && !window.confirm("Bootstrap: Claude (Haiku) labels up to 1,000 recent items once (≈ $0.10–0.30), then the classifier trains. Continue?")) return;
    setBusy(true);
    try {
      const r = await api<{ run_id: string }>("/api/admin/news/topics", "POST", { retrain: true, bootstrap });
      setMsg({ ok: true, text: `Training started (run ${r.run_id.slice(0, 8)}…). The new model is used only if its macro F1 is not worse.` });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span>{model ? <>Active classifier <code>{model.version}</code> · macro F1 {model.macro_f1 ?? "—"} · {model.n} labelled items</> : "No classifier yet: keyword rules are used until one is trained."}</span>
        <Button size="sm" disabled={busy} onClick={() => train(false)}>Retrain now</Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => train(true)}>Bootstrap labels with Claude</Button>
      </div>
      {msg && <Alert tone={msg.ok ? "success" : "error"}>{msg.text}</Alert>}
      <ul className="space-y-3">
        {rows.map((t, i) => {
          const a = accuracy[t.slug];
          return (
            <li key={t.slug} className="grid gap-3 rounded-xl border border-line p-4 text-sm xl:grid-cols-[10rem_minmax(0,1fr)_minmax(0,1fr)_10rem_auto] xl:items-end">
              <label className="block space-y-1"><span className="text-xs text-fg-subtle">Label ({t.slug})</span><Input value={t.label} onChange={(e) => upd(i, { label: e.target.value })} /></label>
              <label className="block space-y-1"><span className="text-xs text-fg-subtle">Keywords (comma separated)</span><Input value={t.keywords.join(", ")} onChange={(e) => upd(i, { keywords: csv(e.target.value) })} /></label>
              <label className="block space-y-1"><span className="text-xs text-fg-subtle">Suggested tags</span><Input value={t.tags.join(", ")} onChange={(e) => upd(i, { tags: csv(e.target.value) })} /></label>
              <label className="block space-y-1"><span className="text-xs text-fg-subtle">CMS category</span><Select value={t.category_slug ?? ""} onChange={(e) => upd(i, { category_slug: e.target.value || null })}><option value="">—</option>{categories.map((c) => <option key={c.slug} value={c.slug}>{c.label}</option>)}</Select></label>
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex min-h-11 items-center gap-1 text-xs"><input type="checkbox" checked={t.enabled} onChange={(e) => upd(i, { enabled: e.target.checked })} /> on</label>
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => save(t)}>Save</Button>
              </div>
              <p className="text-xs text-fg-subtle xl:col-span-5">{a ? (a.f1 !== undefined ? `Classifier: precision ${a.precision}, recall ${a.recall}, F1 ${a.f1} (${a.support} labels)` : a.note ?? "") : "No accuracy data yet."}</p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
