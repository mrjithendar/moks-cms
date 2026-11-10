"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Card } from "@/components/admin/ui";
import { Alert, Button } from "@/components/ui/form";
import type { PublicSeoSettings } from "@/lib/seo-intel/settings";

/**
 * Settings editor generated from the settings document: booleans → checkboxes, numbers → number inputs,
 * strings → text, string lists → comma-separated text (search types → checkboxes). The server validates everything.
 */
type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

const SECTION_LABELS: Record<string, string> = {
  google: "Google properties",
  sync: "Sync and retention",
  schedules: "Schedules (UTC; weekday 0 = Sunday)",
  weights: "Scoring weights (relative; renormalised when an input is missing)",
  thresholds: "Rule thresholds",
  crawler: "Technical crawler",
  llm: "LLM enrichment (optional; off by default)",
  reports: "Reports (email only after recipients are set and email is enabled)",
  drafts: "Claude drafts (automation stops at “ready for review”; empty models/budget = environment defaults)",
  links: "Internal linking limits (conservative by default)",
  submission: "Search-engine submission (kill switch: SEO_SUBMISSION_ENABLED)",
  keywords: "Keyword opportunities",
};
const SEARCH_TYPES = ["web", "image", "video", "news", "discover", "googleNews"];

const human = (k: string) => k.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());

function setIn(obj: Json, path: string[], value: Json): Json {
  if (!path.length) return value;
  const [h, ...rest] = path;
  const o = (obj && typeof obj === "object" && !Array.isArray(obj) ? obj : {}) as Record<string, Json>;
  return { ...o, [h!]: setIn(o[h!] ?? null, rest, value) };
}

function Field({ path, value, onChange }: { path: string[]; value: Json; onChange: (path: string[], v: Json) => void }) {
  const key = path.at(-1)!;
  const id = `seo-${path.join("-")}`;
  const input = "min-h-9 w-full rounded-md border border-line-strong bg-surface px-2 text-sm text-fg";
  if (typeof value === "boolean")
    return (
      <label htmlFor={id} className="flex items-center gap-2 text-sm text-fg">
        <input id={id} type="checkbox" checked={value} onChange={(e) => onChange(path, e.target.checked)} /> {human(key)}
      </label>
    );
  if (key === "searchTypes" && Array.isArray(value))
    return (
      <fieldset className="text-sm">
        <legend className="text-xs text-fg-subtle">Search types</legend>
        <div className="mt-1 flex flex-wrap gap-3">
          {SEARCH_TYPES.map((t) => (
            <label key={t} className="flex items-center gap-1">
              <input type="checkbox" checked={value.includes(t)} onChange={(e) => onChange(path, e.target.checked ? [...value, t] : value.filter((v) => v !== t))} /> {t}
            </label>
          ))}
        </div>
      </fieldset>
    );
  if (Array.isArray(value))
    return (
      <label htmlFor={id} className="grid gap-1 text-xs text-fg-subtle">
        {human(key)} (comma-separated)
        <input id={id} className={input} defaultValue={value.join(", ")} onChange={(e) => onChange(path, e.target.value.split(",").map((s) => s.trim()).filter(Boolean))} />
      </label>
    );
  if (value && typeof value === "object")
    return (
      <fieldset className="rounded-lg border border-line p-3">
        <legend className="px-1 text-xs font-semibold text-fg-muted">{human(key)}</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {Object.entries(value).map(([k, v]) => <Field key={k} path={[...path, k]} value={v} onChange={onChange} />)}
        </div>
      </fieldset>
    );
  return (
    <label htmlFor={id} className="grid gap-1 text-xs text-fg-subtle">
      {human(key)}
      <input id={id} className={input} type={typeof value === "number" ? "number" : "text"} step="any" value={value === null ? "" : String(value)} onChange={(e) => onChange(path, typeof value === "number" ? Number(e.target.value) : e.target.value)} />
    </label>
  );
}

export function SettingsForm({ initial }: { initial: PublicSeoSettings }) {
  const router = useRouter();
  const { llmKeySet, ...editable } = initial;
  const [value, setValue] = useState<Json>(editable as unknown as Json);
  const [llmApiKey, setKey] = useState("");
  const [clearLlmKey, setClear] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string; issues?: string[] } | null>(null);
  const onChange = (path: string[], v: Json) => setValue((cur) => setIn(cur, path, v));
  return (
    <form
      className="space-y-6"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setResult(null);
        const res = await fetch("/api/admin/seo/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...(value as object), ...(llmApiKey ? { llmApiKey } : {}), clearLlmKey }) }).catch(() => null);
        const data = (await res?.json().catch(() => ({}))) as { error?: string; issues?: string[] } | undefined;
        setBusy(false);
        if (res?.ok) {
          setKey("");
          setResult({ ok: true, text: "Saved." });
          router.refresh();
        } else setResult({ ok: false, text: data?.error ?? "Could not save.", issues: data?.issues });
      }}
    >
      {Object.entries(value as Record<string, Json>).map(([section, v]) => (
        <Card key={section}>
          <h2 className="mb-3 font-semibold text-fg">{SECTION_LABELS[section] ?? human(section)}</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {Object.entries(v as Record<string, Json>).map(([k, leaf]) => <Field key={k} path={[section, k]} value={leaf} onChange={onChange} />)}
          </div>
          {section === "llm" && (
            <div className="mt-4 grid gap-2 border-t border-line pt-4 text-sm">
              <p className="text-fg-muted">API key: {llmKeySet ? "saved (encrypted)" : "not saved; the provider's environment variable is used if set"}. Bedrock uses the pod&apos;s AWS credentials; Ollama (OpenAI-compatible base URL on localhost or in-cluster) needs none.</p>
              <label className="grid gap-1 text-xs text-fg-subtle">New API key (write-only)
                <input type="password" autoComplete="off" value={llmApiKey} onChange={(e) => setKey(e.target.value)} className="min-h-9 rounded-md border border-line-strong bg-surface px-2 text-sm text-fg" />
              </label>
              {llmKeySet && <label className="flex items-center gap-2"><input type="checkbox" checked={clearLlmKey} onChange={(e) => setClear(e.target.checked)} /> Remove the saved key</label>}
            </div>
          )}
        </Card>
      ))}
      {result && (
        <Alert tone={result.ok ? "success" : "error"}>
          {result.text}
          {result.issues && <ul className="mt-1 list-disc pl-5">{result.issues.map((i) => <li key={i}>{i}</li>)}</ul>}
        </Alert>
      )}
      <Button type="submit" loading={busy}>Save settings</Button>
    </form>
  );
}
