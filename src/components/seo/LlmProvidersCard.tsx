"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useUnsavedChanges } from "@/components/admin/SettingsSections";
import { Card } from "@/components/admin/ui";
import { Alert, Button, Field, Input, Select } from "@/components/ui/form";
import type { AgentLlmKind, AgentLlmModel, AgentLlmProvider, AgentLlmProviderSave, AgentLlmProvidersView } from "@/lib/seo-agent/client";
import type { LlmProvidersLoad } from "@/lib/llm-providers-view";

/** A model row as it is typed: prices and limits are text until a save, so an empty field stays empty. */
export type ModelDraft = { model_id: string; label: string; enabled: boolean; free: boolean; input: string; output: string; cacheRead: string; cacheWrite: string; context: string; maxOutput: string; structured: boolean; tools: boolean; vision: boolean };
export type ProviderDraft = { id: string; kind: string; name: string; enabled: boolean; base_url: string; region: string; deployment: string; api_version: string; apiKey: string; removeKey: boolean; models: ModelDraft[] };

const text = (n: number | null) => (n === null || n === undefined ? "" : String(n));

export const modelDraftOf = (m: AgentLlmModel): ModelDraft => ({
  model_id: m.model_id,
  label: m.label === m.model_id ? "" : m.label,
  enabled: m.enabled,
  free: m.free,
  input: text(m.prices.input),
  output: text(m.prices.output),
  cacheRead: text(m.prices.cache_read),
  cacheWrite: text(m.prices.cache_write),
  context: text(m.context_window),
  maxOutput: text(m.max_output),
  structured: m.capabilities.structured_output,
  tools: m.capabilities.tools,
  vision: m.capabilities.vision,
});

/** What the form starts with. The key field always starts empty: a key is never sent to the browser. */
export const draftOf = (p: AgentLlmProvider, kind: AgentLlmKind | undefined): ProviderDraft => ({
  id: p.id,
  kind: p.kind,
  name: p.name,
  enabled: p.enabled,
  base_url: kind && !kind.base_url_editable ? "" : p.base_url,
  region: p.region,
  deployment: p.deployment,
  api_version: p.api_version,
  apiKey: "",
  removeKey: false,
  models: p.models.map(modelDraftOf),
});

/** A new provider of a kind: its id is the kind's for a one-of-a-kind provider, else the kind plus a number. */
export function newProviderId(kind: AgentLlmKind, taken: string[]): string {
  if (!kind.many) return kind.id;
  const base = kind.id.replace(/_/g, "-");
  for (let n = 1; n < 100; n++) {
    const id = n === 1 ? base : `${base}-${n}`;
    if (!taken.includes(id)) return id;
  }
  return `${base}-${Date.now() % 100000}`;
}

function num(v: string, what: string, issues: string[], whole = false): number | null {
  const t = v.trim();
  if (t === "") return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0 || (whole && (!Number.isInteger(n) || n === 0))) {
    issues.push(`${what}: enter ${whole ? "a whole number above 0" : "a number, 0 or more"}, or leave it empty.`);
    return null;
  }
  return n;
}

/**
 * The body of a save. Numbers that are not numbers are reported here; every other rule (a price before a model is
 * switched on, what a provider needs) is the agent's and comes back as its issues. The key is sent only when one was
 * typed, "" only when the admin ticked "remove".
 */
export function saveBody(d: ProviderDraft): { body: AgentLlmProviderSave } | { issues: string[] } {
  const issues: string[] = [];
  if (!d.name.trim()) issues.push("Name: enter a name.");
  const ids = new Set<string>();
  const models = d.models.map((m) => {
    const id = m.model_id.trim();
    if (!id) issues.push("A model needs its id (the name the provider's API takes).");
    else if (ids.has(id)) issues.push(`${id}: listed twice.`);
    ids.add(id);
    return {
      model_id: id,
      label: m.label.trim(),
      enabled: m.enabled,
      free: m.free,
      input_usd: num(m.input, `${id || "model"} input price`, issues),
      output_usd: num(m.output, `${id || "model"} output price`, issues),
      cache_read_usd: num(m.cacheRead, `${id || "model"} cache read price`, issues),
      cache_write_usd: num(m.cacheWrite, `${id || "model"} cache write price`, issues),
      context_window: num(m.context, `${id || "model"} context window`, issues, true),
      max_output: num(m.maxOutput, `${id || "model"} max output`, issues, true),
      structured_output: m.structured,
      tools: m.tools,
      vision: m.vision,
    };
  });
  if (issues.length) return { issues };
  const body: AgentLlmProviderSave = { id: d.id, kind: d.kind, name: d.name.trim(), enabled: d.enabled, base_url: d.base_url.trim(), region: d.region.trim(), deployment: d.deployment.trim(), api_version: d.api_version.trim(), models };
  if (d.apiKey.trim()) body.api_key = d.apiKey.trim();
  else if (d.removeKey) body.api_key = "";
  return { body };
}

export const KEY_WORDS: Record<AgentLlmProvider["key"], string> = { saved: "Key saved", env: "Key from the deployment", none: "No key", not_needed: "No key needed" };
export const PRICE_WORDS: Record<AgentLlmModel["price_state"], string> = { entered: "Your prices", "built-in": "Built-in price", free: "Free", missing: "No price yet" };

const blankModel = (): ModelDraft => ({ model_id: "", label: "", enabled: false, free: false, input: "", output: "", cacheRead: "", cacheWrite: "", context: "", maxOutput: "", structured: false, tools: false, vision: false });
const pill = "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium";

function ProviderForm({ provider, kind, canStoreKeys, keyEnv, isNew, onSaved, onCancel }: { provider: AgentLlmProvider; kind: AgentLlmKind | undefined; canStoreKeys: boolean; keyEnv: string; isNew: boolean; onSaved: (v: AgentLlmProvidersView) => void; onCancel?: () => void }) {
  const [draft, setDraft] = useState<ProviderDraft>(() => draftOf(provider, kind));
  const [dirty, setDirty] = useState(isNew);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; issues?: string[] } | null>(null);
  useUnsavedChanges(dirty);
  const set = (patch: Partial<ProviderDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setDirty(true);
  };
  const setModel = (i: number, patch: Partial<ModelDraft>) => set({ models: draft.models.map((m, j) => (j === i ? { ...m, ...patch } : m)) });
  const uid = `prov-${provider.id}`;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const next = saveBody(draft);
    if ("issues" in next) {
      setMsg({ ok: false, text: "Not saved.", issues: next.issues });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/admin/seo/llm-providers", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next.body) });
      const body = (await res.json().catch(() => ({}))) as { error?: string; issues?: string[]; reference?: string; view?: AgentLlmProvidersView };
      if (!res.ok || !body.view) setMsg({ ok: false, text: (body.error ?? `HTTP ${res.status}`) + (body.reference ? ` (ref ${body.reference})` : ""), issues: body.issues });
      else {
        setDraft((d) => ({ ...d, apiKey: "", removeKey: false }));
        setDirty(false);
        setMsg({ ok: true, text: "Saved in the SEO agent." });
        onSaved(body.view);
      }
    } catch {
      setMsg({ ok: false, text: "Network error." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="rounded-xl border border-line p-4" aria-labelledby={`${uid}-title`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`${uid}-title`} className="min-w-0 break-words font-semibold text-fg">
          {draft.name || kind?.label || provider.kind} <span className="font-normal text-fg-subtle">· {kind?.label ?? provider.kind}</span>
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`${pill} ${provider.enabled && !isNew ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-500/15 dark:text-emerald-200" : "bg-surface-sunken text-fg-muted"}`}>{isNew ? "Not saved yet" : provider.enabled ? "On" : "Off"}</span>
          {kind?.takes_key && !isNew && <span className={`${pill} bg-surface-sunken text-fg-muted`}>{KEY_WORDS[provider.key]}</span>}
        </div>
      </div>
      {kind?.note && <p className="mt-1 text-sm text-fg-muted">{kind.note}</p>}
      {!isNew && provider.issues.length > 0 && (
        <div className="mt-3">
          <Alert tone="info">
            Needs attention:
            <ul className="mt-1 list-disc pl-5">{provider.issues.map((i) => <li key={i}>{i}</li>)}</ul>
          </Alert>
        </div>
      )}

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor={`${uid}-name`}>
          <Input id={`${uid}-name`} value={draft.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <div className="flex items-end">
          <label className="flex items-center gap-2 text-sm text-fg">
            <input type="checkbox" checked={draft.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Switched on
          </label>
        </div>
        {kind?.base_url_editable ? (
          <Field label="Base URL" htmlFor={`${uid}-url`} hint={kind.id === "azure_openai" ? "https://<resource>.openai.azure.com" : "The part before /chat/completions, e.g. https://host/v1"}>
            <Input id={`${uid}-url`} type="url" inputMode="url" value={draft.base_url} maxLength={300} onChange={(e) => set({ base_url: e.target.value })} />
          </Field>
        ) : (
          kind?.base_url && (
            <div className="min-w-0 text-sm">
              <p className="font-medium text-fg">Address</p>
              <p className="mt-1.5 break-all text-fg-muted">{kind.base_url}</p>
            </div>
          )
        )}
        {kind?.needs.includes("region") && (
          <Field label="AWS region" htmlFor={`${uid}-region`} hint="For example us-east-1.">
            <Input id={`${uid}-region`} value={draft.region} maxLength={40} onChange={(e) => set({ region: e.target.value })} />
          </Field>
        )}
        {kind?.id === "azure_openai" && (
          <Field label="API version" htmlFor={`${uid}-apiv`} optional hint="Leave empty for Azure's v1 route. Each model's id is its deployment name.">
            <Input id={`${uid}-apiv`} value={draft.api_version} maxLength={40} onChange={(e) => set({ api_version: e.target.value })} />
          </Field>
        )}
        {kind?.takes_key && (
          <Field
            label={provider.key === "saved" ? "Replace the API key" : "API key"}
            htmlFor={`${uid}-key`}
            optional={kind.id === "custom" || provider.key !== "none"}
            hint={canStoreKeys ? "Stored sealed in the SEO agent. It is never shown again." : `A key cannot be stored until ${keyEnv} is set on the seo-agent (manual step).`}
          >
            <Input id={`${uid}-key`} type="password" autoComplete="off" spellCheck={false} disabled={!canStoreKeys || draft.removeKey} value={draft.apiKey} maxLength={4000} onChange={(e) => set({ apiKey: e.target.value })} />
            {provider.key === "saved" && (
              <label className="mt-2 flex items-center gap-2 text-sm text-fg-muted">
                <input type="checkbox" checked={draft.removeKey} onChange={(e) => set({ removeKey: e.target.checked, apiKey: "" })} /> Remove the saved key
              </label>
            )}
          </Field>
        )}
      </div>

      <h4 className="mt-6 text-sm font-semibold text-fg">Models</h4>
      <p className="mt-1 text-sm text-fg-muted">Prices are USD per million tokens. A model can be switched on once its input and output prices are entered{provider.kind === "anthropic" ? ", or it has a built-in price" : ""}, or it is marked free (a local model). No price is ever filled in for you.</p>
      {draft.models.length === 0 && <p className="mt-3 text-sm text-fg-subtle">No models yet. Add the ones you want to use.</p>}
      <ul className="mt-3 space-y-3">
        {draft.models.map((m, i) => {
          const saved = provider.models.find((x) => x.model_id === m.model_id);
          const mid = `${uid}-m${i}`;
          return (
            <li key={i} className="rounded-lg border border-line p-3">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Field label="Model id" htmlFor={`${mid}-id`}>
                  <Input id={`${mid}-id`} value={m.model_id} maxLength={200} spellCheck={false} onChange={(e) => setModel(i, { model_id: e.target.value })} />
                </Field>
                <Field label="Label" htmlFor={`${mid}-label`} optional>
                  <Input id={`${mid}-label`} value={m.label} maxLength={120} onChange={(e) => setModel(i, { label: e.target.value })} />
                </Field>
                <Field label="Input price" htmlFor={`${mid}-in`} hint={saved?.builtin_prices ? `Built-in: $${saved.builtin_prices.input}` : undefined}>
                  <Input id={`${mid}-in`} inputMode="decimal" disabled={m.free} value={m.input} onChange={(e) => setModel(i, { input: e.target.value })} />
                </Field>
                <Field label="Output price" htmlFor={`${mid}-out`} hint={saved?.builtin_prices ? `Built-in: $${saved.builtin_prices.output}` : undefined}>
                  <Input id={`${mid}-out`} inputMode="decimal" disabled={m.free} value={m.output} onChange={(e) => setModel(i, { output: e.target.value })} />
                </Field>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-fg">
                <label className="flex items-center gap-2"><input type="checkbox" checked={m.enabled} onChange={(e) => setModel(i, { enabled: e.target.checked })} /> Switched on</label>
                <label className="flex items-center gap-2"><input type="checkbox" checked={m.free} onChange={(e) => setModel(i, { free: e.target.checked, ...(e.target.checked ? { input: "", output: "", cacheRead: "", cacheWrite: "" } : {}) })} /> Free (local)</label>
                <label className="flex items-center gap-2"><input type="checkbox" checked={m.structured} onChange={(e) => setModel(i, { structured: e.target.checked })} /> Structured output</label>
                <label className="flex items-center gap-2"><input type="checkbox" checked={m.tools} onChange={(e) => setModel(i, { tools: e.target.checked })} /> Tools</label>
                <label className="flex items-center gap-2"><input type="checkbox" checked={m.vision} onChange={(e) => setModel(i, { vision: e.target.checked })} /> Vision</label>
                {saved && <span className={`${pill} ${saved.price_state === "missing" ? "bg-amber-100 text-amber-900 dark:bg-amber-500/15 dark:text-amber-200" : "bg-surface-sunken text-fg-muted"}`}>{PRICE_WORDS[saved.price_state]}</span>}
                <button type="button" className="ml-auto text-sm text-red-700 underline dark:text-red-300" onClick={() => set({ models: draft.models.filter((_, j) => j !== i) })}>
                  Remove
                </button>
              </div>
              <details className="mt-2 text-sm">
                <summary className="cursor-pointer text-fg-muted">Cache prices and limits</summary>
                <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <Field label="Cache read price" htmlFor={`${mid}-cr`} optional><Input id={`${mid}-cr`} inputMode="decimal" disabled={m.free} value={m.cacheRead} onChange={(e) => setModel(i, { cacheRead: e.target.value })} /></Field>
                  <Field label="Cache write price" htmlFor={`${mid}-cw`} optional><Input id={`${mid}-cw`} inputMode="decimal" disabled={m.free} value={m.cacheWrite} onChange={(e) => setModel(i, { cacheWrite: e.target.value })} /></Field>
                  <Field label="Context window (tokens)" htmlFor={`${mid}-ctx`} optional><Input id={`${mid}-ctx`} inputMode="numeric" value={m.context} onChange={(e) => setModel(i, { context: e.target.value })} /></Field>
                  <Field label="Max output (tokens)" htmlFor={`${mid}-max`} optional><Input id={`${mid}-max`} inputMode="numeric" value={m.maxOutput} onChange={(e) => setModel(i, { maxOutput: e.target.value })} /></Field>
                </div>
              </details>
            </li>
          );
        })}
      </ul>
      <div className="mt-3">
        <Button type="button" variant="secondary" size="sm" onClick={() => set({ models: [...draft.models, blankModel()] })}>Add a model</Button>
      </div>

      {msg && (
        <div className="mt-4" role="status">
          <Alert tone={msg.ok ? "success" : "error"}>
            {msg.text}
            {msg.issues && msg.issues.length > 0 && <ul className="mt-1 list-disc pl-5">{msg.issues.map((i) => <li key={i}>{i}</li>)}</ul>}
          </Alert>
        </div>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button type="submit" disabled={busy || !dirty}>{busy ? "Saving…" : isNew ? "Add provider" : "Save provider"}</Button>
        {onCancel && <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>}
      </div>
    </form>
  );
}

/** AI & SEO settings → LLM providers & budget → providers and models: one form per provider, saved one at a time in the SEO agent. */
export function LlmProvidersCard({ load }: { load: LlmProvidersLoad }) {
  const router = useRouter();
  const [view, setView] = useState<AgentLlmProvidersView | null>(load.view);
  const [adding, setAdding] = useState<AgentLlmProvider | null>(null);
  const [kindId, setKindId] = useState("");
  const [version, setVersion] = useState(0);

  if (!view) {
    return (
      <Card className="mb-6">
        <h2 id="llm-providers" className="scroll-mt-24 text-lg font-semibold text-fg">LLM providers &amp; models</h2>
        <div className="mt-4">
          <Alert tone={load.tooOld ? "info" : "error"}>{load.error ?? "The SEO agent could not be asked."} Providers, keys and models are kept by the SEO agent, so they can be seen and changed only while it is reachable.</Alert>
        </div>
      </Card>
    );
  }
  const kinds = new Map<string, AgentLlmKind>(view.kinds.map((k) => [k.id, k]));
  const taken = view.providers.map((p) => p.id);
  const addable = view.kinds.filter((k) => k.many || !taken.includes(k.id));
  const saved = (v: AgentLlmProvidersView) => {
    setView(v);
    setAdding(null);
    setVersion((n) => n + 1);
    router.refresh();
  };
  const start = () => {
    const kind = kinds.get(kindId);
    if (!kind) return;
    setAdding({ id: newProviderId(kind, taken), kind: kind.id, kind_label: kind.label, name: kind.label, enabled: false, base_url: kind.base_url, region: "", deployment: "", api_version: "", key: kind.takes_key ? "none" : "not_needed", saved: false, issues: [], models: [] });
  };

  return (
    <Card className="mb-6">
      <h2 id="llm-providers" className="scroll-mt-24 text-lg font-semibold text-fg">LLM providers &amp; models</h2>
      <p className="mt-1 text-sm text-fg-muted">Which model providers the SEO agent may call, their keys, and the models you allow with their prices. Kept in the SEO agent; a key is stored sealed and never shown again.</p>
      <div className="mt-3">
        <Alert tone="info">Set-up only for now: every job still calls Anthropic. Calling other providers, &quot;Fetch models&quot;, &quot;Test&quot; and choosing a model for each job arrive in the next seo-agent releases.</Alert>
      </div>
      {!view.can_store_keys && (
        <div className="mt-3">
          <Alert tone="info">Keys cannot be stored yet: set {view.key_env} (32 characters or more) on the seo-agent and restart it. This is a manual step.</Alert>
        </div>
      )}
      <div className="mt-5 space-y-5">
        {view.providers.map((p) => (
          <ProviderForm key={`${p.id}-${version}`} provider={p} kind={kinds.get(p.kind)} canStoreKeys={view.can_store_keys} keyEnv={view.key_env} isNew={false} onSaved={saved} />
        ))}
        {adding && <ProviderForm key={`new-${adding.id}`} provider={adding} kind={kinds.get(adding.kind)} canStoreKeys={view.can_store_keys} keyEnv={view.key_env} isNew onSaved={saved} onCancel={() => setAdding(null)} />}
      </div>
      {!adding && addable.length > 0 && (
        <div className="mt-5 flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1 sm:max-w-xs">
            <Field label="Add a provider" htmlFor="llm-add-kind">
              <Select id="llm-add-kind" value={kindId} onChange={(e) => setKindId(e.target.value)}>
                <option value="">Choose…</option>
                {addable.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
              </Select>
            </Field>
          </div>
          <Button type="button" variant="secondary" disabled={!kindId} onClick={start}>Add</Button>
        </div>
      )}
      <p className="mt-4 text-sm text-fg-subtle">A provider that is not listed works through &quot;Custom OpenAI-compatible&quot; with its base URL.</p>
    </Card>
  );
}
