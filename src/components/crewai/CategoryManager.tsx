"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/components/news/api";
import { Alert, Button, Input } from "@/components/ui/form";
import type { Category } from "@/lib/crewai/catalog-shared";
import { ConfirmDialog } from "./ConfirmDialog";

/** Create, rename, describe, reorder and remove the categories crews and flows are filed under. */
export function CategoryManager({ categories }: { categories: Category[] }) {
  const router = useRouter();
  const [draft, setDraft] = useState({ label: "", description: "" });
  const [edit, setEdit] = useState<Record<string, { label: string; description: string }>>({});
  const [remove, setRemove] = useState<Category | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const call = async (fn: () => Promise<unknown>, ok: string) => {
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
  const reorder = (i: number, by: number) => {
    const a = categories[i];
    const b = categories[i + by];
    if (!a || !b) return;
    void call(async () => {
      await api(`/api/admin/crewai/categories/${a.slug}`, "PATCH", { position: b.position });
      await api(`/api/admin/crewai/categories/${b.slug}`, "PATCH", { position: a.position === b.position ? a.position + by : a.position });
    }, "Order saved.");
  };
  return (
    <div className="space-y-6">
      <form
        className="grid gap-3 rounded-xl border border-line p-4 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto] sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          void call(async () => {
            await api("/api/admin/crewai/categories", "POST", { label: draft.label, ...(draft.description ? { description: draft.description } : {}) });
            setDraft({ label: "", description: "" });
          }, "Category added.");
        }}
      >
        <label className="block space-y-1.5"><span className="text-sm font-medium text-fg">New category</span><Input required maxLength={60} value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} placeholder="Security" /></label>
        <label className="block space-y-1.5"><span className="text-sm font-medium text-fg">Description (optional)</span><Input maxLength={300} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></label>
        <Button type="submit" disabled={busy || !draft.label.trim()}>Add</Button>
      </form>
      {categories.length === 0 ? (
        <p className="text-sm text-fg-muted">No categories yet.</p>
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line bg-surface" aria-label="Categories">
          {categories.map((c, i) => {
            const e = edit[c.slug];
            return (
              <li key={c.slug} className="grid gap-3 px-4 py-3 md:grid-cols-[minmax(0,1fr)_10rem_auto] md:items-center">
                {e ? (
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Input aria-label={`Name of ${c.label}`} value={e.label} maxLength={60} onChange={(x) => setEdit({ ...edit, [c.slug]: { ...e, label: x.target.value } })} />
                    <Input aria-label={`Description of ${c.label}`} value={e.description} maxLength={300} onChange={(x) => setEdit({ ...edit, [c.slug]: { ...e, description: x.target.value } })} />
                  </div>
                ) : (
                  <div className="min-w-0">
                    <p className="font-medium text-fg">{c.label} <code className="ml-1 text-xs font-normal text-fg-subtle">{c.slug}</code></p>
                    {c.description && <p className="text-sm text-fg-muted">{c.description}</p>}
                  </div>
                )}
                <p className="text-xs text-fg-muted">
                  <Link className="hover:underline" href={`/admin/crewai/crews?category=${c.slug}`}>{c.crews} crew{c.crews === 1 ? "" : "s"}</Link> · <Link className="hover:underline" href={`/admin/crewai/flows?category=${c.slug}`}>{c.flows} flow{c.flows === 1 ? "" : "s"}</Link>
                </p>
                <div className="flex flex-wrap gap-1">
                  {e ? (
                    <>
                      <Button size="sm" disabled={busy || !e.label.trim()} onClick={() => call(async () => { await api(`/api/admin/crewai/categories/${c.slug}`, "PATCH", e); setEdit((x) => { const y = { ...x }; delete y[c.slug]; return y; }); }, "Saved.")}>Save</Button>
                      <Button size="sm" variant="ghost" onClick={() => setEdit((x) => { const y = { ...x }; delete y[c.slug]; return y; })}>Cancel</Button>
                    </>
                  ) : (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => setEdit({ ...edit, [c.slug]: { label: c.label, description: c.description } })}>Rename</Button>
                      <Button size="sm" variant="ghost" disabled={busy || i === 0} onClick={() => reorder(i, -1)} aria-label={`Move ${c.label} up`}>↑</Button>
                      <Button size="sm" variant="ghost" disabled={busy || i === categories.length - 1} onClick={() => reorder(i, 1)} aria-label={`Move ${c.label} down`}>↓</Button>
                      <Button size="sm" variant="ghost" className="text-red-700 dark:text-red-300" onClick={() => setRemove(c)}>Remove</Button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {msg && <Alert tone={msg.ok ? "success" : "error"}>{msg.text}</Alert>}
      <ConfirmDialog open={remove != null} title={`Remove the category ${remove?.label ?? ""}?`} confirmLabel="Remove category" busy={busy} onCancel={() => setRemove(null)} onConfirm={() => remove && call(async () => { await api(`/api/admin/crewai/categories/${remove.slug}`, "DELETE"); setRemove(null); }, "Category removed.")}>
        <p>It is taken off {remove?.crews ?? 0} crew(s) and {remove?.flows ?? 0} flow(s). They stay as they are otherwise, and nothing about how they run changes.</p>
      </ConfirmDialog>
    </div>
  );
}
