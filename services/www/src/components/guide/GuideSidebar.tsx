import Link from "next/link";
import type { ReactNode } from "react";
import { guideArticlePath, guideToc, type GuideEntry } from "@/lib/user-guide";

/**
 * The manual's contents tree: every category with its guides and questions, each a link to its own page. The page
 * being read is marked (aria-current) and its category is open; on the manual's home the first category is.
 * Categories are <details>, so the tree works without JavaScript and is rendered on the server.
 */
export function GuideSidebar({ entries, base, current }: { entries: GuideEntry[]; base: string; current?: string }) {
  const toc = guideToc(entries);
  const openSection = entries.find((e) => e.id === current)?.section ?? toc[0]?.section;
  const item = (active: boolean) =>
    `block rounded-md px-2 py-1.5 leading-5 transition-colors ${active ? "bg-accent-soft font-medium text-accent-text" : "text-fg-muted hover:bg-surface-muted hover:text-fg"}`;
  return (
    <nav aria-label="Manual contents" className="text-sm">
      <Link href={base} aria-current={current ? undefined : "page"} className={item(!current)}>
        Manual home
      </Link>
      <ul className="mt-2 space-y-1">
        {toc.map((s) => (
          <li key={s.section}>
            <details open={s.section === openSection}>
              <summary className="flex min-h-9 cursor-pointer list-none items-center justify-between gap-2 rounded-md px-2 font-semibold text-fg hover:bg-surface-muted">
                <span>{s.section}</span>
                <span className="text-xs font-normal text-fg-subtle">{s.guides.length + s.faqs.length}</span>
              </summary>
              <ul className="mb-2 ml-2 mt-1 space-y-0.5 border-l border-line pl-2">
                {[...s.guides, ...s.faqs].map((e) => (
                  <li key={e.id}>
                    <Link href={guideArticlePath(base, e.id)} aria-current={e.id === current ? "page" : undefined} className={item(e.id === current)}>
                      {e.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </details>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * The manual's two columns: the contents tree beside the page. On a wide screen the tree stays in view while the page
 * scrolls; on a phone or tablet it folds away under "Contents" above the page. Neither is printed.
 */
export function GuideLayout({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }) {
  return (
    <div className="lg:grid lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-8">
      <div className="print:hidden">
        {/* Only one of the two copies is displayed at any width, so assistive technology meets the tree once. */}
        <details className="mb-6 rounded-xl border border-line bg-surface lg:hidden">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-4 text-sm font-semibold text-fg">
            <span>Contents</span>
            <span className="text-xs font-normal text-fg-subtle">Show or hide</span>
          </summary>
          <div className="border-t border-line p-3">{sidebar}</div>
        </details>
        <div className="hidden lg:sticky lg:top-[calc(var(--spacing-header)+1.5rem)] lg:block lg:max-h-[calc(100dvh-var(--spacing-header)-3rem)] lg:overflow-y-auto lg:pr-1">{sidebar}</div>
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
