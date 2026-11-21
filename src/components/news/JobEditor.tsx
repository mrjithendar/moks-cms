"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Alert, Button, Input, Select, Textarea } from "@/components/ui/form";
import { MAX_DEFAULT_CATEGORIES } from "@/lib/news/limits";
import { Field } from "./Fld";
import { api, when } from "./api";

type Config = Record<string, unknown> & {
  source_ids: string[];
  include_keywords: string[];
  exclude_keywords: string[];
  include_entities: string[];
  exclude_entities: string[];
  topics: string[];
  default_categories: string[];
  publishing_slots: string[];
  models: Record<string, string>;
  weights: Record<string, number>;
  budget: Record<string, number>;
  diversity: Record<string, number>;
  image: { enabled: boolean; provider: string | null; variants: number | null };
};
export type JobForm = { name: string; description: string; enabled: boolean; cron: string; timezone: string; mode: string; writing_profile_key: string; image_profile_key: string; review_priority: number; config: Config };
type Version = { version: number; diff: { path: string; before: unknown; after: unknown }[]; note: string | null; created_by: string | null; created_at: string };
type Opt = { value: string; label: string };

const TABS = ["General", "Sources", "Selection & ML", "Writing", "Images", "Categories", "Schedule & limits", "Budget", "Review"] as const;
const FEATURES = ["credibility", "source_count", "burst", "recency", "topic_match", "audience", "novelty", "severity", "keyword_overlap"];
const AGENTS = ["researcher", "analyst", "writer", "fact_checker", "seo_editor", "art_director"];
const list = (s: string) => s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);

function cronHint(expr: string): string | null {
  return expr.trim().split(/\s+/).length === 5 || expr.startsWith("@") ? null : "Five fields: minute hour day-of-month month day-of-week (e.g. 0 7 * * 1-5).";
}

export function JobEditor({ id, initial, versions, sources, topics, categories, writingKeys, imageKeys }: { id: string | null; initial: JobForm; versions: Version[]; sources: Opt[]; topics: Opt[]; categories: Opt[]; writingKeys: Opt[]; imageKeys: Opt[] }) {
  const router = useRouter();
  const [tab, setTab] = useState<(typeof TABS)[number]>("General");
  const [f, setF] = useState<JobForm>(initial);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [diff, setDiff] = useState<Version["diff"] | null>(null);
  const c = f.config;
  const set = <K extends keyof JobForm>(k: K, v: JobForm[K]) => setF((x) => ({ ...x, [k]: v }));
  const setC = (k: string, v: unknown) => setF((x) => ({ ...x, config: { ...x.config, [k]: v } }));
  const setNested = (k: "budget" | "diversity" | "image" | "weights" | "models", sub: string, v: unknown) => setF((x) => ({ ...x, config: { ...x.config, [k]: { ...(x.config[k] as Record<string, unknown>), [sub]: v } } }));
  const toggle = (k: "source_ids" | "topics" | "default_categories", v: string) => setC(k, c[k].includes(v) ? c[k].filter((x) => x !== v) : [...c[k], v]);
  const changedCount = useMemo(() => JSON.stringify(f) !== JSON.stringify(initial), [f, initial]);

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      if (id) {
        const r = await api<{ changed: boolean; version: number; diff?: Version["diff"] }>(`/api/admin/news/jobs/${id}`, "PUT", f);
        setDiff(r.diff ?? null);
        setMsg({ ok: true, text: r.changed ? `Saved as version ${r.version}.` : "No changes." });
        router.refresh();
      } else {
        const r = await api<{ job: { id: string } }>("/api/admin/news/jobs", "POST", f);
        router.push(`/admin/news/jobs/${r.job.id}`);
      }
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function action(body: Record<string, unknown>, confirmText?: string) {
    if (!id || (confirmText && !window.confirm(confirmText))) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ run_id?: string; job?: { id: string } }>(`/api/admin/news/jobs/${id}/actions`, "POST", body);
      if (r.run_id) setMsg({ ok: true, text: `Started run ${r.run_id.slice(0, 8)}… (Run history shows it live).` });
      if (body.action === "clone" && r.job) router.push(`/admin/news/jobs/${r.job.id}`);
      if (body.action === "rollback") router.refresh();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  // `max`: once that many are ticked the rest are disabled, so the editor stops where the save would refuse.
  const checks = (k: "source_ids" | "topics" | "default_categories", opts: Opt[], empty: string, max?: number) => (
    <fieldset className="grid gap-2 sm:grid-cols-2">
      {opts.length === 0 && <p className="text-sm text-fg-subtle">{empty}</p>}
      {opts.map((o) => {
        const on = c[k].includes(o.value);
        const full = max !== undefined && !on && c[k].length >= max;
        return (
          <label key={o.value} className={`flex min-h-11 items-center gap-2 rounded-lg border border-line px-3 text-sm${full ? " opacity-50" : ""}`}>
            <input type="checkbox" checked={on} disabled={full} onChange={() => toggle(k, o.value)} />
            {o.label}
          </label>
        );
      })}
    </fieldset>
  );
  const num = (label: string, value: number, onChange: (n: number) => void, opts: { min?: number; max?: number; step?: number; hint?: string } = {}) => (
    <Field label={label} hint={opts.hint}>
      <Input type="number" value={Number.isFinite(value) ? value : ""} min={opts.min} max={opts.max} step={opts.step ?? 1} onChange={(e) => onChange(Number(e.target.value))} />
    </Field>
  );

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_18rem]">
      <div>
        <div role="tablist" aria-label="Job settings" className="mb-6 flex flex-wrap gap-1">
          {TABS.map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`min-h-11 whitespace-nowrap rounded-lg px-3 text-sm font-medium ${tab === t ? "bg-accent text-white" : "bg-surface-muted text-fg-muted hover:text-fg"}`}>
              {t}
            </button>
          ))}
        </div>
        <div role="tabpanel" className="space-y-5">
          {tab === "General" && (
            <>
              <Field label="Name"><Input value={f.name} onChange={(e) => set("name", e.target.value)} maxLength={120} /></Field>
              <Field label="Description"><Textarea value={f.description} onChange={(e) => set("description", e.target.value)} rows={3} /></Field>
              <Field label="Mode" hint="Single stories: one article per story. Daily digest: one article with the top stories. Both: singles plus a digest of the rest.">
                <Select value={f.mode} onChange={(e) => set("mode", e.target.value)}>
                  <option value="single_stories">Single stories</option>
                  <option value="daily_digest">Daily digest</option>
                  <option value="both">Both</option>
                </Select>
              </Field>
              <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={f.enabled} onChange={(e) => set("enabled", e.target.checked)} /> Enabled (runs on its schedule)</label>
            </>
          )}
          {tab === "Sources" && (
            <>
              <p className="text-sm text-fg-muted">No selection = every enabled source. Sources are fetched once per interval and shared by all jobs.</p>
              {checks("source_ids", sources, "No sources yet (Sources tab of the news desk).")}
            </>
          )}
          {tab === "Selection & ML" && (
            <>
              <Field label="Include keywords" hint="Comma or newline separated. A story must match one (if any are set)."><Textarea rows={2} value={c.include_keywords.join(", ")} onChange={(e) => setC("include_keywords", list(e.target.value))} /></Field>
              <Field label="Exclude keywords"><Textarea rows={2} value={c.exclude_keywords.join(", ")} onChange={(e) => setC("exclude_keywords", list(e.target.value))} /></Field>
              <Field label="Include entities" hint="Products/organisations, e.g. Kubernetes, AWS."><Input value={c.include_entities.join(", ")} onChange={(e) => setC("include_entities", list(e.target.value))} /></Field>
              <Field label="Exclude entities"><Input value={c.exclude_entities.join(", ")} onChange={(e) => setC("exclude_entities", list(e.target.value))} /></Field>
              <div className="space-y-1.5">
                <p className="text-sm font-medium text-fg">Topics</p>
                <p className="text-xs text-fg-subtle">Only stories classified into these topics (none = any).</p>
                {checks("topics", topics, "No topics.")}
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                {num("Min score", Number(c.min_score), (n) => setC("min_score", n), { min: 0, max: 1, step: 0.01 })}
                {num("Dedupe window (days)", Number(c.dedupe_window_days), (n) => setC("dedupe_window_days", n), { min: 1, max: 60 })}
                {num("Max story age (hours)", Number(c.max_age_hours), (n) => setC("max_age_hours", n), { min: 1, max: 2160 })}
                {num("Recency half-life (hours)", Number(c.recency_half_life_hours), (n) => setC("recency_half_life_hours", n), { min: 1, max: 720 })}
                {num("Digest size", Number(c.digest_size), (n) => setC("digest_size", n), { min: 2, max: 12 })}
                <Field label="Language"><Input value={String(c.language)} maxLength={2} onChange={(e) => setC("language", e.target.value.toLowerCase())} /></Field>
              </div>
              <details className="rounded-lg border border-line p-4">
                <summary className="cursor-pointer text-sm font-semibold">Score weights (v1)</summary>
                <p className="mt-2 text-sm text-fg-subtle">Blank = default. Weights are renormalised to sum to 1. When the learned ranker is promoted it replaces these (Analytics → models).</p>
                <div className="mt-3 grid gap-3 sm:grid-cols-3">
                  {FEATURES.map((k) => (
                    <Field key={k} label={k.replace(/_/g, " ")}>
                      <Input type="number" min={0} max={1} step={0.01} value={c.weights[k] ?? ""} onChange={(e) => setF((x) => { const w = { ...x.config.weights }; if (e.target.value === "") delete w[k]; else w[k] = Number(e.target.value); return { ...x, config: { ...x.config, weights: w } }; })} />
                    </Field>
                  ))}
                </div>
              </details>
            </>
          )}
          {tab === "Writing" && (
            <>
              <Field label="Writing profile"><Select value={f.writing_profile_key} onChange={(e) => set("writing_profile_key", e.target.value)}>{writingKeys.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</Select></Field>
              {num("Pin profile version (0 = active)", Number(c.writing_profile_version ?? 0), (n) => setC("writing_profile_version", n > 0 ? n : null), { min: 0 })}
              <div className="grid gap-4 sm:grid-cols-2">
                {num("Min words", Number(c.length_min_words), (n) => setC("length_min_words", n), { min: 100, max: 5000 })}
                {num("Max words", Number(c.length_max_words), (n) => setC("length_max_words", n), { min: 150, max: 8000 })}
              </div>
              <Field label="Author (author profile slug)" hint="Blank = the first admin."><Input value={String(c.author ?? "")} onChange={(e) => setC("author", e.target.value || null)} /></Field>
              <details className="rounded-lg border border-line p-4">
                <summary className="cursor-pointer text-sm font-semibold">Models per agent</summary>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  {AGENTS.map((a) => (
                    <Field key={a} label={a.replace(/_/g, " ")}>
                      <Select value={c.models[a] ?? ""} onChange={(e) => setF((x) => { const m = { ...x.config.models }; if (!e.target.value) delete m[a]; else m[a] = e.target.value; return { ...x, config: { ...x.config, models: m } }; })}>
                        <option value="">Default</option>
                        <option value="claude-sonnet-5-5">Claude Sonnet 5.5</option>
                        <option value="claude-haiku-5-5">Claude Haiku 5.5</option>
                        <option value="claude-opus-5-5">Claude Opus 5.5</option>
                      </Select>
                    </Field>
                  ))}
                </div>
              </details>
            </>
          )}
          {tab === "Images" && (
            <>
              <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={c.image.enabled} onChange={(e) => setNested("image", "enabled", e.target.checked)} /> Generate a cover image</label>
              <Field label="Image profile"><Select value={f.image_profile_key} onChange={(e) => set("image_profile_key", e.target.value)}>{imageKeys.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</Select></Field>
              <Field label="Provider override" hint="Template is free; Gemini/OpenAI need configuration and an image budget (the news agent's docs/IMAGES.md).">
                <Select value={c.image.provider ?? ""} onChange={(e) => setNested("image", "provider", e.target.value || null)}>
                  <option value="">The profile&apos;s provider</option>
                  <option value="template">Template</option>
                  <option value="gemini">Gemini</option>
                  <option value="openai">OpenAI</option>
                </Select>
              </Field>
              {num("Variants (0 = profile default)", Number(c.image.variants ?? 0), (n) => setNested("image", "variants", n > 0 ? n : null), { min: 0, max: 4 })}
            </>
          )}
          {tab === "Categories" && (
            <>
              <p className="text-sm text-fg-muted">
                Used when the classifier has no confident category. Topics map to these CMS categories (Topics tab). The writer is offered at most 3: the
                topic&apos;s category first, then these in the order you ticked them; the article is filed under the one it puts first. Up to{" "}
                {MAX_DEFAULT_CATEGORIES}; {c.default_categories.length} ticked.
              </p>
              {checks("default_categories", categories, "No categories.", MAX_DEFAULT_CATEGORIES)}
            </>
          )}
          {tab === "Schedule & limits" && (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Cron" hint={cronHint(f.cron) ?? "minute hour day month weekday, in the job's time zone"}><Input value={f.cron} onChange={(e) => set("cron", e.target.value)} className="font-mono" /></Field>
                <Field label="Time zone"><Input value={f.timezone} onChange={(e) => set("timezone", e.target.value)} /></Field>
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                {num("Max articles per run", Number(c.max_articles_per_run), (n) => setC("max_articles_per_run", n), { min: 0, max: 20 })}
                {num("Max articles per day", Number(c.max_articles_per_day), (n) => setC("max_articles_per_day", n), { min: 0, max: 40, hint: "In the job's time zone. A limit to keep quality high, not a target." })}
                {num("Max per topic per day", Number(c.diversity.max_per_topic_per_day), (n) => setNested("diversity", "max_per_topic_per_day", n), { min: 1, max: 20 })}
                {num("Max per source per day", Number(c.diversity.max_per_source_per_day), (n) => setNested("diversity", "max_per_source_per_day", n), { min: 1, max: 20 })}
                {num("Expiry notice after (days, 0 = never)", Number(c.expiry_days ?? 0), (n) => setC("expiry_days", n > 0 ? n : null), { min: 0, max: 3650 })}
              </div>
              <Field label="Publishing slots (HH:MM, job time zone)" hint="“Schedule” in review offers the next of these."><Input value={c.publishing_slots.join(", ")} onChange={(e) => setC("publishing_slots", list(e.target.value))} /></Field>
            </>
          )}
          {tab === "Budget" && (
            <div className="grid gap-4 sm:grid-cols-2">
              {num("Images per day (USD)", Number(c.budget.image_daily_usd), (n) => setNested("budget", "image_daily_usd", n), { min: 0, max: 100, step: 0.05 })}
              {num("Images per month (USD)", Number(c.budget.image_monthly_usd), (n) => setNested("budget", "image_monthly_usd", n), { min: 0, max: 1000, step: 0.5 })}
              {num("Tokens per draft (crew cap)", Number(c.budget.max_tokens_per_draft), (n) => setNested("budget", "max_tokens_per_draft", n), { min: 10_000, max: 400_000, step: 1000 })}
              <p className="text-sm text-fg-subtle sm:col-span-2">These are image caps and a token limit per draft. LLM spend has no cap per job: it counts in the one LLM budget (AI &amp; SEO → Settings → LLM budget), and a run stops as “paused (budget)” when that is used up or an image cap is reached. The global image caps (Settings) apply too.</p>
            </div>
          )}
          {tab === "Review" && (
            <>
              {num("Review priority (0–100)", f.review_priority, (n) => set("review_priority", n), { min: 0, max: 100, hint: "Sorts this job's drafts higher or lower in the review queue (together with score and freshness)." })}
              <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={Boolean(c.notify)} onChange={(e) => setC("notify", e.target.checked)} /> Email a summary after each run (when SEO alert recipients and email are configured)</label>
            </>
          )}
        </div>
        <div className="sticky bottom-0 mt-8 flex flex-wrap items-center gap-3 border-t border-line bg-surface py-4">
          <Button onClick={save} loading={busy} disabled={!changedCount && Boolean(id)}>{id ? "Save new version" : "Create job"}</Button>
          {id && <Button variant="secondary" onClick={() => action({ action: "dry_run", llm: true })} disabled={busy}>Dry run</Button>}
          {id && <Button variant="ghost" onClick={() => action({ action: "dry_run", llm: false })} disabled={busy}>Dry run (no LLM)</Button>}
          {id && <Button variant="ghost" onClick={() => action({ action: "run" }, "Run now? It drafts up to the per-run cap and spends budget.")} disabled={busy}>Run now</Button>}
          {id && <Button variant="ghost" onClick={() => action({ action: "clone" })} disabled={busy}>Clone</Button>}
          {id && (
            <Button
              variant="danger"
              disabled={busy}
              onClick={async () => {
                if (!window.confirm("Delete this job? Its runs and drafts stay in history.")) return;
                await api(`/api/admin/news/jobs/${id}`, "DELETE");
                router.push("/admin/news");
              }}
            >
              Delete
            </Button>
          )}
        </div>
        {msg && <div className="mt-3"><Alert tone={msg.ok ? "success" : "error"}>{msg.text}</Alert></div>}
        {diff && diff.length > 0 && (
          <div className="mt-4 rounded-lg border border-line p-4 text-sm">
            <p className="font-semibold">Changes in this version</p>
            <DiffList diff={diff} />
          </div>
        )}
      </div>
      {id && (
        <aside aria-labelledby="versions" className="space-y-3">
          <h2 id="versions" className="text-sm font-semibold text-fg">Versions</h2>
          <ol className="space-y-3">
            {versions.map((v, i) => (
              <li key={v.version} className="rounded-lg border border-line p-3 text-sm">
                <p className="font-medium text-fg">v{v.version} {i === 0 && <span className="text-xs text-emerald-700 dark:text-emerald-300">current</span>}</p>
                <p className="text-xs text-fg-subtle">{when(v.created_at)} · {v.created_by ?? "?"}{v.note ? ` · ${v.note}` : ""}</p>
                {v.diff.length > 0 && <details className="mt-1"><summary className="cursor-pointer text-xs">{v.diff.length} change{v.diff.length === 1 ? "" : "s"}</summary><DiffList diff={v.diff} /></details>}
                {i > 0 && <Button size="sm" variant="ghost" className="mt-2" onClick={() => action({ action: "rollback", version: v.version }, `Roll back to v${v.version}? This saves it as a new version.`)}>Roll back to v{v.version}</Button>}
              </li>
            ))}
          </ol>
        </aside>
      )}
    </div>
  );
}

function DiffList({ diff }: { diff: { path: string; before: unknown; after: unknown }[] }) {
  return (
    <ul className="mt-2 space-y-1 text-xs">
      {diff.map((d) => (
        <li key={d.path} className="[overflow-wrap:anywhere]">
          <code>{d.path}</code>: <del className="text-red-700 dark:text-red-300">{JSON.stringify(d.before)}</del> → <ins className="text-emerald-700 no-underline dark:text-emerald-300">{JSON.stringify(d.after)}</ins>
        </li>
      ))}
    </ul>
  );
}
