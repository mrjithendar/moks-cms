"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type MouseEvent, type ReactNode, useEffect } from "react";
import { settingsNavClass, settingsNavItemClass, UnsavedChangesBoundary, useMayLeave } from "@/components/admin/SettingsSections";
import { inputClass } from "@/components/ui/form";
import { settingsHref, settingsSection, SETTINGS_PATH } from "@/lib/settings-areas";

export type HubSection = { id: string; label: string; href: string };
export type HubCategory = { id: string; label: string; href: string; sections: HubSection[] };

/**
 * The Settings area's navigation (app/admin/settings/[category]/page.tsx): two levels, categories and their sections
 * (lib/settings-areas.ts). Each section is its own server render at `/admin/settings/<category>?section=<id>`, so
 * every entry is a link.
 *
 * - From `xl` up: a list beside the form that stays in view while the form scrolls. The open category shows its
 *   sections under it; the others are one line each, so the list fits the window (it scrolls on its own only when it
 *   does not).
 * - Below `xl` (tablets and phones, where the admin menu already takes the side): a select of categories and the open
 *   category's sections as buttons that wrap onto as many lines as they need, never sideways.
 *
 * While a form in the open section has unsaved changes (`useUnsavedChanges`), leaving it asks first. An old
 * `#tab-<id>` link (AI & SEO settings were tabs once) is sent on to that section.
 */
export function SettingsHub({ categories, category, section, children }: { categories: HubCategory[]; category: string; section: string; children: ReactNode }) {
  return (
    <UnsavedChangesBoundary current={section}>
      <HubLayout categories={categories} category={category} section={section}>
        {children}
      </HubLayout>
    </UnsavedChangesBoundary>
  );
}

function HubLayout({ categories, category, section, children }: { categories: HubCategory[]; category: string; section: string; children: ReactNode }) {
  const router = useRouter();
  const mayLeave = useMayLeave();
  const open = categories.find((c) => c.id === category);

  useEffect(() => {
    const old = /^#tab-([a-z0-9-]+)$/.exec(window.location.hash)?.[1];
    if (old && old !== section && settingsSection(old)) router.replace(settingsHref(old));
  }, [section, router]);

  /** A link elsewhere asks first when the open section has unsaved changes; the open section's own link never does. */
  const guard = (target: string) => (e: MouseEvent<HTMLAnchorElement>) => {
    if (target !== section && !mayLeave()) e.preventDefault();
  };
  const chooseCategory = (id: string) => {
    const c = categories.find((x) => x.id === id);
    if (!c || id === category || !mayLeave()) return;
    router.push(c.href);
  };

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6 xl:grid-cols-[15rem_minmax(0,1fr)] xl:gap-8">
      <nav aria-label="Settings" className={settingsNavClass}>
        <div className="space-y-3 xl:hidden">
          <label className="block max-w-md">
            <span className="mb-1.5 block text-sm font-medium text-fg">Category</span>
            <select value={category} onChange={(e) => chooseCategory(e.target.value)} className={inputClass}>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          {open && open.sections.length > 1 && (
            <ul aria-label={`${open.label} sections`} className="flex flex-wrap gap-2">
              {open.sections.map((s) => (
                <li key={s.id} className="min-w-0 max-w-full">
                  <Link
                    href={s.href}
                    aria-current={s.id === section ? "page" : undefined}
                    onClick={guard(s.id)}
                    className={`inline-flex min-h-9 max-w-full items-center rounded-full border px-3 py-1 text-sm font-medium transition-colors ${s.id === section ? "border-transparent bg-accent-soft text-accent-text" : "border-line-strong bg-surface text-fg-muted hover:bg-surface-sunken hover:text-fg"}`}
                  >
                    {s.label}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="hidden xl:block">
          <Link href={SETTINGS_PATH} onClick={guard("")} className={`${settingsNavItemClass(false)} mb-2`}>
            <span className="min-w-0">All settings</span>
            <span aria-hidden="true" className="text-fg-subtle">
              ↖
            </span>
          </Link>
          <ul className="space-y-0.5 border-t border-line pt-2">
            {categories.map((c) => {
              const isOpen = c.id === category;
              const single = c.sections.length === 1;
              return (
                <li key={c.id}>
                  <Link
                    href={c.href}
                    aria-current={isOpen ? (single ? "page" : "true") : undefined}
                    onClick={guard(isOpen ? section : `category:${c.id}`)}
                    className={settingsNavItemClass(isOpen && single)}
                  >
                    <span className={`min-w-0 ${isOpen && !single ? "font-semibold text-fg" : ""}`}>{c.label}</span>
                  </Link>
                  {isOpen && !single && (
                    <ul aria-label={`${c.label} sections`} className="mb-1.5 ml-3 mt-0.5 space-y-0.5 border-l border-line pl-2">
                      {c.sections.map((s) => (
                        <li key={s.id}>
                          <Link href={s.href} aria-current={s.id === section ? "page" : undefined} onClick={guard(s.id)} className={settingsNavItemClass(s.id === section)}>
                            <span className="min-w-0">{s.label}</span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </nav>
      <div className="min-w-0 space-y-6">{children}</div>
    </div>
  );
}
