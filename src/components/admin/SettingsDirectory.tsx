"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { inputClass } from "@/components/ui/form";
import { searchSettings, type SettingsSectionDef } from "@/lib/settings-areas";

export type DirectoryCategory = { id: string; label: string; description: string; href: string; sections: (SettingsSectionDef & { href: string })[] };

/**
 * The Settings overview (app/admin/settings/page.tsx): every category with its sections, and a search over section
 * names, descriptions, keywords and the names of the fields in each (`fields`, from the user guide's settings
 * reference), so "AdSense" or "SMTP" finds the one section that has it.
 */
export function SettingsDirectory({ categories, fields, initialQuery = "" }: { categories: DirectoryCategory[]; fields: Record<string, string[]>; initialQuery?: string }) {
  const [q, setQ] = useState(initialQuery);
  const id = useId();
  const all = categories.flatMap((c) => c.sections);
  const found = q.trim() ? searchSettings(all, q, fields) : null;
  const labelOf = new Map(categories.map((c) => [c.id, c.label]));

  return (
    <div className="@container space-y-6">
      <div className="max-w-xl">
        <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-fg">
          Search settings
        </label>
        <input
          id={id}
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="A setting or service: AdSense, SMTP, budget, Turnstile…"
          className={inputClass}
          autoComplete="off"
          spellCheck={false}
          aria-describedby={`${id}-hint`}
        />
        <p id={`${id}-hint`} className="mt-1.5 text-sm text-fg-subtle">
          Searches section names and the fields in them.
        </p>
      </div>

      {found ? (
        <section aria-live="polite" aria-label="Matching settings">
          {found.length === 0 ? (
            <p className="text-sm text-fg-muted">
              No settings match “{q.trim()}”. The <Link href="/admin/user-manual" className="link">User manual</Link> explains every setting.
            </p>
          ) : (
            <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
              {found.map((s) => (
                <li key={s.id}>
                  <Link href={s.href} className="block px-4 py-3 transition-colors hover:bg-surface-muted">
                    <span className="block text-xs font-semibold uppercase tracking-wide text-fg-subtle">{labelOf.get(s.category)}</span>
                    <span className="block font-medium text-fg">{s.label}</span>
                    <span className="mt-0.5 block text-sm text-fg-muted">{s.description}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : (
        <ul className="grid gap-4 @2xl:grid-cols-2 @5xl:grid-cols-3">
          {categories.map((c) => (
            <li key={c.id} className="flex min-w-0 flex-col rounded-xl border border-line bg-surface p-5 shadow-sm">
              <h2 className="text-base font-semibold text-fg">
                <Link href={c.href} className="hover:underline">
                  {c.label}
                </Link>
              </h2>
              <p className="mt-1 text-sm leading-6 text-fg-muted">{c.description}</p>
              <ul className="mt-3 space-y-1 border-t border-line pt-3">
                {c.sections.map((s) => (
                  <li key={s.id}>
                    <Link href={s.href} className="link text-sm">
                      {s.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
