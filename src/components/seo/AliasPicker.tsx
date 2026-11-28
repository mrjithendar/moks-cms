"use client";

import { useEffect, useState } from "react";
import { Select } from "@/components/ui/form";

type Loaded = { aliases: string[]; defaults: { default: string; fast: string } | null; error: string | null };
let pending: Promise<Loaded> | null = null;

/** One request per page, however many pickers it has. */
function loadOnce(): Promise<Loaded> {
  pending ??= fetch("/api/admin/seo/llm-models")
    .then(async (r) => {
      const body = (await r.json().catch(() => ({}))) as Partial<Loaded>;
      return { aliases: Array.isArray(body.aliases) ? body.aliases : [], defaults: body.defaults ?? null, error: !r.ok || body.error ? (body.error ?? "LiteLLM's aliases could not be loaded.") : null };
    })
    .catch(() => ({ aliases: [], defaults: null, error: "LiteLLM's aliases could not be loaded." }));
  return pending;
}

/** The options: every alias LiteLLM lists, and a current value it no longer lists, kept and marked. */
export function aliasOptions(aliases: string[], current: string): { value: string; label: string; missing?: boolean }[] {
  const out: { value: string; label: string; missing?: boolean }[] = aliases.map((a) => ({ value: a, label: a }));
  if (current && !aliases.includes(current)) out.unshift({ value: current, label: `${current} (not listed by LiteLLM)`, missing: true });
  return out;
}

/**
 * Pick a LiteLLM alias (D-110: which provider and model answer is set in LiteLLM, never here). The list is what LiteLLM
 * lists for the SEO agent's key. `emptyLabel` is the first option, meaning "the default".
 */
export function AliasPicker({ id, value, onChange, emptyLabel = "Default", disabled = false }: { id?: string; value: string; onChange: (value: string) => void; emptyLabel?: string; disabled?: boolean }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  useEffect(() => {
    let live = true;
    void loadOnce().then((l) => live && setLoaded(l));
    return () => {
      live = false;
    };
  }, []);
  const errorId = id ? `${id}-aliases-error` : undefined;
  return (
    <>
      <Select id={id} value={value} disabled={disabled || loaded === null} aria-describedby={loaded?.error ? errorId : undefined} onChange={(e) => onChange(e.target.value)}>
        {loaded === null ? <option value={value}>Loading…</option> : <option value="">{emptyLabel}</option>}
        {loaded && aliasOptions(loaded.aliases, value).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </Select>
      {loaded?.error && <p id={errorId} className="mt-1 text-sm text-red-700 dark:text-red-300">{loaded.error}</p>}
    </>
  );
}
