"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/components/news/api";
import { Alert, Button, Input, Textarea } from "@/components/ui/form";
import type { CatalogKind, Category } from "@/lib/crewai/catalog-shared";

export type Details = { label: string; description: string; objective: string; categories: string[]; tags: string[] };

/** Tags typed as text: commas or Enter separate them. */
export function TagInput({ id, value, onChange }: { id: string; value: string[]; onChange: (v: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const add = (raw: string) => {
    const next = [...new Set([...value, ...raw.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean)])].slice(0, 20);
    onChange(next);
    setDraft("");
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {value.map((t) => (
          <span key={t} className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-muted py-0.5 pl-2.5 pr-1 text-xs text-fg">
            #{t}
            <button type="button" onClick={() => onChange(value.filter((x) => x !== t))} className="inline-flex h-6 w-6 items-center justify-center rounded-full text-fg-muted hover:bg-surface-sunken" aria-label={`Remove tag ${t}`}>×</button>
          </span>
        ))}
      </div>
      <Input
        id={id}
        value={draft}
        placeholder="Add tags: weekly, kubernetes"
        onChange={(e) => (e.target.value.endsWith(",") ? add(e.target.value) : setDraft(e.target.value))}
        onKeyDown={(e) => {
          if (e.key === "Enter" && draft.trim()) {
            e.preventDefault();
            add(draft);
          }
        }}
        onBlur={() => draft.trim() && add(draft)}
      />
    </div>
  );
}

/** Categories as a group of checkboxes (any number), with a link to manage them. */
export function CategoryPicker({ categories, value, onChange }: { categories: Category[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <fieldset>
      <legend className="mb-1.5 text-sm font-medium text-fg">Categories</legend>
      {categories.length === 0 ? (
        <p className="text-sm text-fg-muted">No categories yet: <Link className="underline" href="/admin/crewai/categories">add some</Link>.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {categories.map((c) => (
            <label key={c.slug} className={`inline-flex min-h-9 cursor-pointer items-center gap-2 rounded-full border px-3 text-sm ${value.includes(c.slug) ? "border-accent bg-accent/10 text-fg" : "border-line text-fg-muted"}`} title={c.description || undefined}>
              <input type="checkbox" className="sr-only" checked={value.includes(c.slug)} onChange={(e) => onChange(e.target.checked ? [...value, c.slug] : value.filter((x) => x !== c.slug))} />
              <span aria-hidden="true">{value.includes(c.slug) ? "✓" : "+"}</span>
              {c.label}
            </label>
          ))}
        </div>
      )}
      <p className="mt-1.5 text-xs text-fg-subtle">For finding and filtering only: categories never change how anything runs. <Link className="underline" href="/admin/crewai/categories">Manage categories</Link></p>
    </fieldset>
  );
}

/**
 * A crew's or flow's details: name, description, objective (crews), categories and tags. The same form for every crew
 * and every flow; it saves on its own (PATCH /api/admin/crewai/catalog/...).
 */
export function CatalogDetails({ kind, itemKey, initial, categories, readOnly = false }: { kind: CatalogKind; itemKey: string; initial: Details; categories: Category[]; readOnly?: boolean }) {
  const router = useRouter();
  const [d, setD] = useState<Details>(initial);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const dirty = JSON.stringify(d) !== JSON.stringify(initial);
  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await api(`/api/admin/crewai/catalog/${kind === "crew" ? "crews" : "flows"}/${itemKey}`, "PATCH", { label: d.label, description: d.description, ...(kind === "crew" ? { objective: d.objective } : {}), categories: d.categories, tags: d.tags });
      setMsg({ ok: true, text: "Saved." });
      router.refresh();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const id = `details-${kind}-${itemKey}`;
  return (
    <section aria-labelledby={`${id}-h`} className="space-y-4">
      <h2 id={`${id}-h`} className="text-base font-semibold text-fg">Details</h2>
      <fieldset disabled={readOnly || busy} className="grid gap-4 md:grid-cols-2">
        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-fg">Name</span>
          <Input value={d.label} maxLength={120} onChange={(e) => setD({ ...d, label: e.target.value })} />
        </label>
        <div className="space-y-1.5">
          <label htmlFor={`${id}-tags`} className="text-sm font-medium text-fg">Tags</label>
          <TagInput id={`${id}-tags`} value={d.tags} onChange={(tags) => setD({ ...d, tags })} />
        </div>
        <label className="block space-y-1.5 md:col-span-2">
          <span className="text-sm font-medium text-fg">Description</span>
          <Textarea rows={2} maxLength={1000} value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} />
        </label>
        {kind === "crew" && (
          <label className="block space-y-1.5 md:col-span-2">
            <span className="text-sm font-medium text-fg">Objective</span>
            <Textarea rows={2} maxLength={1500} value={d.objective} placeholder="What this crew is for and what a good result looks like" onChange={(e) => setD({ ...d, objective: e.target.value })} />
          </label>
        )}
        <div className="md:col-span-2">
          <CategoryPicker categories={categories} value={d.categories} onChange={(c) => setD({ ...d, categories: c })} />
        </div>
      </fieldset>
      {!readOnly && (
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={save} disabled={!dirty || busy} loading={busy}>Save details</Button>
          {dirty && <Button variant="ghost" onClick={() => setD(initial)} disabled={busy}>Discard</Button>}
        </div>
      )}
      {msg && <Alert tone={msg.ok ? "success" : "error"}>{msg.text}</Alert>}
    </section>
  );
}
