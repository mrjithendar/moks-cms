"use client";

import { useEffect, useState } from "react";
import { Select } from "@/components/ui/form";
import type { AgentLlmModel } from "@/lib/seo-agent/client";

/** A model as one value: "<provider id>/<model id>". The provider id has no slash; a model id may. */
export const modelValue = (m: Pick<AgentLlmModel, "provider_id" | "model_id">) => `${m.provider_id}/${m.model_id}`;
export function parseModelValue(v: string): { provider_id: string; model_id: string } | null {
  const i = v.indexOf("/");
  return i > 0 && i < v.length - 1 ? { provider_id: v.slice(0, i), model_id: v.slice(i + 1) } : null;
}

/** Options grouped by provider, in the agent's order. A current value that is no longer offered is kept, marked. */
export function pickerGroups(models: AgentLlmModel[], current: string): { provider: string; options: { value: string; label: string; missing?: boolean }[] }[] {
  const groups = new Map<string, { provider: string; options: { value: string; label: string; missing?: boolean }[] }>();
  for (const m of models) {
    const g = groups.get(m.provider_id) ?? { provider: m.provider_name ?? m.provider_id, options: [] };
    g.options.push({ value: modelValue(m), label: m.label || m.model_id });
    groups.set(m.provider_id, g);
  }
  const out = [...groups.values()];
  if (current && !models.some((m) => modelValue(m) === current)) out.unshift({ provider: "Not available", options: [{ value: current, label: `${current} (switched off or removed)`, missing: true }] });
  return out;
}

/**
 * Pick one of the models that are switched on in Settings → AI & models → LLM providers & budget. Pass `models` when
 * the page already has them (server-rendered); otherwise the list is fetched once from /api/admin/seo/llm-models.
 * `allowEmpty` adds a first option with `emptyLabel` (e.g. "Default").
 */
export function ModelPicker({ id, value, onChange, models, allowEmpty = false, emptyLabel = "Default", disabled = false }: { id: string; value: string; onChange: (value: string) => void; models?: AgentLlmModel[]; allowEmpty?: boolean; emptyLabel?: string; disabled?: boolean }) {
  const [fetched, setFetched] = useState<AgentLlmModel[] | null>(models ?? null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (models) return;
    let live = true;
    fetch("/api/admin/seo/llm-models")
      .then(async (r) => ({ ok: r.ok, body: (await r.json().catch(() => ({}))) as { models?: AgentLlmModel[]; error?: string | null } }))
      .then(({ ok, body }) => {
        if (!live) return;
        setFetched(Array.isArray(body.models) ? body.models : []);
        setError(!ok || body.error ? (body.error ?? "The models could not be loaded.") : null);
      })
      .catch(() => {
        if (!live) return;
        setFetched([]);
        setError("The models could not be loaded.");
      });
    return () => {
      live = false;
    };
  }, [models]);
  const list = models ?? fetched;
  const groups = pickerGroups(list ?? [], value);
  return (
    <>
      <Select id={id} value={value} disabled={disabled || list === null} aria-describedby={error ? `${id}-models-error` : undefined} onChange={(e) => onChange(e.target.value)}>
        {list === null ? <option value={value}>Loading…</option> : allowEmpty ? <option value="">{emptyLabel}</option> : !value && <option value="">Choose a model…</option>}
        {groups.map((g) => (
          <optgroup key={g.provider} label={g.provider}>
            {g.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </optgroup>
        ))}
      </Select>
      {error && <p id={`${id}-models-error`} className="mt-1 text-sm text-red-700 dark:text-red-300">{error}</p>}
    </>
  );
}
