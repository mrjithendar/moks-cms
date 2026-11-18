"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export type CalendarBrief = { gap?: string; audience?: string; intent?: string; supportingQueries?: string[]; outline?: string[]; codeExamples?: string[]; diagrams?: string[]; readingTimeMinutes?: number | null; notes?: string; authorNotes?: string };
type Owner = { id: string; name: string };

const field = "w-full rounded-md border border-line bg-surface px-2 py-1 text-fg placeholder:text-fg-subtle hover:border-line-strong focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20";

function Line({ name, value, placeholder, onSave, className = "" }: { name: string; value: string; placeholder: string; onSave: (v: string) => void; className?: string }) {
  const [v, setV] = useState(value);
  return (
    <input aria-label={name} value={v} placeholder={placeholder} className={`${field} ${className}`} onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
      onBlur={() => v.trim() !== value.trim() && onSave(v.trim())} />
  );
}
function Lines({ name, value, placeholder, onSave }: { name: string; value: string[]; placeholder: string; onSave: (v: string[]) => void }) {
  const joined = value.join("\n");
  const [v, setV] = useState(joined);
  return (
    <textarea aria-label={name} value={v} placeholder={placeholder} rows={Math.min(8, Math.max(1, value.length))} className={`${field} resize-y`} onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== joined && onSave(v.split("\n").map((x) => x.trim()).filter(Boolean))} />
  );
}
/**
 * The grey details of an editorial-calendar item (cluster, category, owner, title, every brief field), editable in place
 * for scheduled and unscheduled items. Each field looks like text until hovered/focused and saves on blur (Enter for
 * one-line fields) through PATCH /api/admin/seo/calendar/{id}; the server validates and audits every change.
 */
export function CalendarItemFields({ id, title, cluster, category, ownerId, owners, brief, compact = false }: { id: string; title: string; cluster: string | null; category: string | null; ownerId: string | null; owners: Owner[]; brief: CalendarBrief; compact?: boolean }) {
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const patch = async (body: Record<string, unknown>) => {
    setErr(null);
    setSaving(true);
    const res = await fetch(`/api/admin/seo/calendar/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    setSaving(false);
    if (!res.ok) setErr(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Could not save.");
    else router.refresh();
  };
  const label = "shrink-0 font-medium text-fg-muted";

  const b = (k: keyof CalendarBrief) => (v: unknown) => void patch({ brief: { [k]: v } });

  return (
    <div className="text-xs" aria-busy={saving}>
      <Line name="Title" value={title} placeholder="Title" onSave={(v) => v.length >= 5 && void patch({ title: v })} className="!text-base font-semibold !text-fg" />
      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        <label className="flex items-center gap-2"><span className={label}>Cluster</span><Line name="Cluster" value={cluster ?? ""} placeholder="—" onSave={(v) => void patch({ cluster: v || null })} /></label>
        <label className="flex items-center gap-2"><span className={label}>Category</span><Line name="Category" value={category ?? ""} placeholder="category-slug" onSave={(v) => void patch({ category: v || null })} /></label>
        <label className="flex items-center gap-2"><span className={label}>Owner</span>
          <select aria-label="Owner" value={ownerId ?? ""} className={field} onChange={(e) => void patch({ ownerId: e.target.value || null })}>
            <option value="">—</option>
            {owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </label>
      </div>
      <details className="mt-2 text-sm" open={!compact}>
        <summary className="cursor-pointer font-medium text-fg-muted hover:text-fg">Brief</summary>
        <dl className="mt-3 grid grid-cols-1 items-start gap-x-4 gap-y-2 sm:grid-cols-[9rem_1fr] [&>dt]:pt-1.5">
          <dt className={label}>Gap</dt><dd><Lines name="Gap" value={brief.gap ? [brief.gap] : []} placeholder="Why this article" onSave={(v) => b("gap")(v.join(" "))} /></dd>
          <dt className={label}>Audience</dt><dd><Line name="Audience" value={brief.audience ?? ""} placeholder="Who it's for" onSave={b("audience")} /></dd>
          <dt className={label}>Intent</dt><dd><Line name="Intent" value={brief.intent ?? ""} placeholder="informational, how-to…" onSave={b("intent")} /></dd>
          <dt className={label}>Queries</dt><dd><Line name="Queries" value={(brief.supportingQueries ?? []).join(", ")} placeholder="comma-separated" onSave={(v) => b("supportingQueries")(v.split(",").map((x) => x.trim()).filter(Boolean))} /></dd>
          <dt className={label}>Outline</dt><dd><Lines name="Outline" value={brief.outline ?? []} placeholder="One heading per line" onSave={b("outline")} /></dd>
          <dt className={label}>Code</dt><dd><Lines name="Code examples" value={brief.codeExamples ?? []} placeholder="One per line" onSave={b("codeExamples")} /></dd>
          <dt className={label}>Diagrams</dt><dd><Lines name="Diagrams" value={brief.diagrams ?? []} placeholder="One per line" onSave={b("diagrams")} /></dd>
          <dt className={label}>Reading time</dt><dd><Line name="Reading time (minutes)" value={brief.readingTimeMinutes ? String(brief.readingTimeMinutes) : ""} placeholder="minutes" onSave={(v) => b("readingTimeMinutes")(v ? Math.max(1, Math.min(120, Math.round(Number(v)) || 1)) : null)} /></dd>
          <dt className={label}>First-hand notes</dt><dd><Lines name="First-hand notes" value={brief.authorNotes ? brief.authorNotes.split("\n") : []} placeholder="What you built, ran or measured: real commands, versions, results, mistakes, opinions. The writer treats these as your own experience." onSave={(v) => b("authorNotes")(v.join("\n"))} /></dd>
          <dt className={label}>Notes</dt><dd><Lines name="Notes" value={brief.notes ? brief.notes.split("\n") : []} placeholder="Notes" onSave={(v) => b("notes")(v.join("\n"))} /></dd>
        </dl>
      </details>
      {err && <p role="alert" className="mt-1 text-xs text-red-700 dark:text-red-300">{err}</p>}
    </div>
  );
}
