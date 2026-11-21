"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, Button, Input, Select, Textarea } from "@/components/ui/form";
import { api } from "./api";
import { Field } from "./Fld";

type S = Record<string, unknown> & { quality: Record<string, number>; paywalled_hosts: string[]; primary_source_hosts: string[] };

/** The news desk switch, global caps, providers/models, retention and quality thresholds. */
export type DeskView = { on: boolean; by: "deployment_off" | "admin" | "deployment_legacy" | "default"; envValue: string; text: string };

export function NewsSettingsForm({ initial, desk, envProvider }: { initial: S; desk: DeskView; envProvider: string | null }) {
  const router = useRouter();
  const [s, setS] = useState<S>(initial);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: unknown) => setS((x) => ({ ...x, [k]: v }));
  // What the box shows: the saved switch once there is one, else the state the desk is in now (so saving keeps it).
  const on = typeof s.enabled === "boolean" ? s.enabled && !s.paused : desk.by === "deployment_off" ? false : desk.on;
  const num = (k: string, label: string, step = 1, hint?: string) => <Field label={label} hint={hint}><Input type="number" step={step} value={Number(s[k] ?? 0)} onChange={(e) => set(k, Number(e.target.value))} /></Field>;
  const q = (k: string, label: string, step = 0.01) => <Field label={label}><Input type="number" step={step} value={Number(s.quality[k] ?? 0)} onChange={(e) => setS((x) => ({ ...x, quality: { ...x.quality, [k]: Number(e.target.value) } }))} /></Field>;
  return (
    <div className="space-y-8">
      <section className="rounded-xl border border-line p-4 text-sm">
        <h2 id="news-desk-switch" className="scroll-mt-24 font-semibold">News desk</h2>
        <p className="mt-1 text-fg-muted" role="status">{desk.text}</p>
        <label className="mt-3 flex min-h-11 items-center gap-2">
          <input type="checkbox" disabled={desk.by === "deployment_off"} checked={on} onChange={(e) => setS((x) => ({ ...x, enabled: e.target.checked, paused: false }))} /> News desk on (jobs run on their schedules)
        </label>
        <p className="mt-1 text-fg-muted">Off: no job runs and the dispatcher skips everything. Sources, jobs and profiles stay as they are.{desk.by !== "deployment_off" && on !== desk.on ? " Not saved yet." : ""}</p>
      </section>
      <section className="space-y-4">
        <h2 className="text-sm font-semibold">Global caps</h2>
        <p className="text-sm text-fg-muted">News LLM spend has no cap of its own: it counts in the one LLM budget under <Link className="underline" href="/admin/automation?section=llm-budget">AI &amp; SEO → Settings → LLM budget</Link>. Image spend keeps the caps below.</p>
        <div className="grid gap-4 sm:grid-cols-3">
          {num("image_daily_usd", "Images per day (USD)", 0.05)}
          {num("image_monthly_usd", "Images per month (USD)", 0.5)}
          {num("max_drafts_per_day", "Drafts per day (all jobs)")}
          {num("draft_concurrency", "Drafts in parallel", 1, "1–4; each draft is one crew run")}
        </div>
      </section>
      <section className="space-y-4">
        <h2 className="text-sm font-semibold">Providers and models</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Default image provider" hint={envProvider ? `NEWS_IMAGE_PROVIDER=${envProvider} in the environment overrides this.` : "Template is free. Gemini uses Admin → Integrations; OpenAI needs OPENAI_API_KEY for the seo-agent."}>
            <Select value={String(s.image_provider)} onChange={(e) => set("image_provider", e.target.value)}><option value="template">Template</option><option value="gemini">Gemini</option><option value="openai">OpenAI</option></Select>
          </Field>
          <Field label="Writer model"><Input value={String(s.writer_model)} onChange={(e) => set("writer_model", e.target.value)} /></Field>
          <Field label="Fast model (classification fallback)"><Input value={String(s.fast_model)} onChange={(e) => set("fast_model", e.target.value)} /></Field>
          <Field label="Vision model (image safety, alt text)"><Input value={String(s.vision_model)} onChange={(e) => set("vision_model", e.target.value)} /></Field>
          {num("classifier_threshold", "Classifier confidence threshold", 0.01, "Below this, Claude is asked")}
          {num("ranker_min_feedback", "Labelled decisions before training the ranker")}
        </div>
      </section>
      <section className="space-y-4">
        <h2 className="text-sm font-semibold">Quality gates</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          {q("max_ngram_overlap", "Max 8-gram overlap per paragraph")}
          {q("max_shared_run_words", "Max verbatim run (words)", 1)}
          {q("max_paragraph_cosine", "Max paragraph similarity (cosine)")}
          {q("max_quote_words", "Max quote length (words)", 1)}
          {q("min_analysis_share", "Min share of original analysis")}
          {q("readability_min", "Readability min (Flesch)", 1)}
          {q("readability_max", "Readability max (Flesch)", 1)}
          {q("title_max", "Title max (chars)", 1)}
          {q("max_internal_links", "Max internal links", 1)}
        </div>
      </section>
      <section className="space-y-4">
        <h2 className="text-sm font-semibold">Hosts and retention</h2>
        <Field label="Paywalled hosts (never fetched; one per line)"><Textarea rows={3} value={s.paywalled_hosts.join("\n")} onChange={(e) => set("paywalled_hosts", e.target.value.split("\n").map((x) => x.trim().toLowerCase()).filter(Boolean))} /></Field>
        <Field label="Extra primary-source hosts the researcher may fetch (one per line)"><Textarea rows={3} value={s.primary_source_hosts.join("\n")} onChange={(e) => set("primary_source_hosts", e.target.value.split("\n").map((x) => x.trim().toLowerCase()).filter(Boolean))} /></Field>
        <div className="grid gap-4 sm:grid-cols-3">
          {num("log_retention_days", "Keep run logs (days)")}
          {num("item_retention_days", "Keep unused feed items (days)")}
          {num("max_items_per_source", "Items per source per fetch")}
        </div>
      </section>
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={busy} onClick={async () => { setBusy(true); try { await api("/api/admin/news/settings", "PUT", desk.by === "deployment_off" ? s : { ...s, enabled: on, paused: false }); setMsg({ ok: true, text: "Saved." }); router.refresh(); } catch (e) { setMsg({ ok: false, text: (e as Error).message }); } finally { setBusy(false); } }}>Save settings</Button>
        <Button variant="ghost" disabled={busy} onClick={async () => { try { await api("/api/admin/news/settings", "POST", { action: "style_review" }); setMsg({ ok: true, text: "Style review started; a proposed profile version appears under Profiles when it finds consistent edits." }); } catch (e) { setMsg({ ok: false, text: (e as Error).message }); } }}>Run style review now</Button>
      </div>
      {msg && <Alert tone={msg.ok ? "success" : "error"}>{msg.text}</Alert>}
    </div>
  );
}
