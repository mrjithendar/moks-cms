import Link from "next/link";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { PrintButton } from "@/components/seo/PrintButton";
import type { Crumb } from "@/lib/seo/jsonld";
import { guideArticlePath, guideNeighbours, guideReadingOrder, guideRelated, guideToc, type GuideEntry } from "@/lib/user-guide";
import type { SettingsGroup } from "@/lib/user-guide-settings";
import { GuideBody, GuideDiagram, GuidePageLink, SettingsTable } from "./parts";

/**
 * Printing a page of the manual: only the manual, not the site's header and footer, the announcement bar or the
 * admin's menu (the same rule the SEO report page uses). The manual's own components use no <header> or <footer>.
 */
export const GUIDE_PRINT_CSS =
  "@media print { [data-admin-shell] > aside, header, footer, .announcement, [data-demo-banner] { display: none !important; } [data-admin-shell] { display: block !important; background: white; } }";

/** The trail above an article: the manual, the article's category (the home page filtered to it), the article. */
export function guideCrumbs(entry: GuideEntry, base: string): Crumb[] {
  return [
    { name: "User manual", path: base },
    { name: entry.section, path: `${base}?area=${encodeURIComponent(entry.section)}` },
    { name: entry.title, path: guideArticlePath(base, entry.id) },
  ];
}

const sectionTitle = "text-lg font-semibold text-fg";

/**
 * One entry of the manual as a page of its own: breadcrumbs, title and summary, who the page is for, an "On this
 * page" list, the text, its diagram, where the page is in the admin, the settings of that page, related entries and
 * the previous and next entries in reading order. Rendered on the server; `entries` is what this reader may see.
 */
export function GuideArticle({
  entry,
  entries,
  base,
  linkToAdmin,
  settings,
}: {
  entry: GuideEntry;
  entries: GuideEntry[];
  base: string;
  /** In the admin, link to the page the entry describes; on the public manual only name its path. */
  linkToAdmin: boolean;
  /** The settings groups of the admin page this entry is about (empty when there are none, or for authors). */
  settings: SettingsGroup[];
}) {
  const { previous, next } = guideNeighbours(entries, entry.id);
  const related = guideRelated(entries, entry);
  const isFaq = entry.kind === "faq";
  const onThisPage = [
    { id: "overview", label: isFaq ? "Answer" : "Overview" },
    ...(entry.diagram ? [{ id: "diagram", label: "Diagram" }] : []),
    ...(entry.href ? [{ id: "where", label: "Where to find it" }] : []),
    ...(settings.length ? [{ id: "settings", label: "Settings on this page" }] : []),
    ...(related.length ? [{ id: "related", label: "Related" }] : []),
  ];
  const position = guideReadingOrder(entries).findIndex((e) => e.id === entry.id);
  const badge = "rounded-full bg-surface-sunken px-2.5 py-1 text-xs font-medium text-fg-muted";

  return (
    <article>
      <div className="print:hidden">
        <Breadcrumbs crumbs={guideCrumbs(entry, base)} />
      </div>
      <div className="mt-4 border-b border-line pb-6">
        <p className="text-xs font-medium uppercase tracking-wide text-fg-subtle">
          {isFaq ? "Question" : "Guide"} · {entry.section}
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-fg [overflow-wrap:anywhere]">{entry.title}</h1>
        {/* A question's summary is the first line of its answer, which follows: not shown twice. */}
        {!isFaq && <p className="mt-2 max-w-2xl text-[0.9375rem] leading-6 text-fg-muted">{entry.summary}</p>}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className={badge}>For: {entry.adminOnly ? "admins" : "admins and authors"}</span>
          {position >= 0 && <span className={badge}>Page {position + 1} of {entries.length}</span>}
          <PrintButton />
        </div>
      </div>

      <div className="mt-6 xl:grid xl:grid-cols-[minmax(0,1fr)_11rem] xl:gap-8">
        {onThisPage.length > 1 && (
          <nav aria-label="On this page" className="mb-6 text-sm print:hidden xl:order-2 xl:mb-0">
            <div className="xl:sticky xl:top-[calc(var(--spacing-chrome)+1.5rem)]">
              <p className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">On this page</p>
              <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 xl:block xl:space-y-1.5 xl:border-l xl:border-line xl:pl-3">
                {onThisPage.map((s) => (
                  <li key={s.id}>
                    <a href={`#${s.id}`} className="text-fg-muted underline-offset-2 hover:text-fg hover:underline">{s.label}</a>
                  </li>
                ))}
              </ul>
            </div>
          </nav>
        )}

        <div className="min-w-0 xl:order-1">
          <section id="overview" aria-labelledby="overview-title">
            <h2 id="overview-title" className={sectionTitle}>{isFaq ? "Answer" : "Overview"}</h2>
            <GuideBody lines={entry.body} />
          </section>

          {entry.diagram && (
            <section id="diagram" aria-labelledby="diagram-title" className="mt-8">
              <h2 id="diagram-title" className={sectionTitle}>Diagram</h2>
              <GuideDiagram d={entry.diagram} eager />
            </section>
          )}

          {entry.href && (
            <section id="where" aria-labelledby="where-title" className="mt-8">
              <h2 id="where-title" className={sectionTitle}>Where to find it</h2>
              <p className="mt-3 text-sm leading-6 text-fg-muted">
                This page of the admin: <span className="font-mono text-fg">{entry.href}</span>. {entry.adminOnly ? "Only admins (and read-only demo accounts) can open it." : "Admins and authors can open it."}
              </p>
              {linkToAdmin && <GuidePageLink href={entry.href} linkToAdmin />}
            </section>
          )}

          {settings.length > 0 && (
            <section id="settings" aria-labelledby="settings-title" className="mt-8">
              <h2 id="settings-title" className={sectionTitle}>Settings on this page</h2>
              <p className="mt-1 text-sm text-fg-muted">What each setting does and its default. Defaults only: the manual never shows the values saved on a site.</p>
              {settings.map((g) => (
                <div key={g.id} className="mt-5">
                  <h3 className="text-sm font-semibold text-fg">{g.title}</h3>
                  {g.description && <p className="mt-1 text-sm text-fg-muted">{g.description}</p>}
                  <SettingsTable group={g} />
                </div>
              ))}
            </section>
          )}

          {related.length > 0 && (
            <section id="related" aria-labelledby="related-title" className="mt-8 print:hidden">
              <h2 id="related-title" className={sectionTitle}>Related</h2>
              <ul className="mt-3 divide-y divide-line rounded-xl border border-line bg-surface">
                {related.map((e) => (
                  <li key={e.id}>
                    <Link href={guideArticlePath(base, e.id)} className="block px-4 py-3 transition-colors hover:bg-surface-muted">
                      <span className="block text-sm font-medium text-fg">{e.title}</span>
                      <span className="mt-0.5 block text-sm text-fg-muted">{e.summary}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <nav aria-label="Previous and next page" className="mt-10 grid gap-3 border-t border-line pt-6 print:hidden sm:grid-cols-2">
            {previous ? (
              <Link href={guideArticlePath(base, previous.id)} className="rounded-xl border border-line bg-surface p-4 transition-colors hover:border-line-strong">
                <span className="block text-xs text-fg-subtle">← Previous</span>
                <span className="mt-1 block text-sm font-semibold text-fg">{previous.title}</span>
              </Link>
            ) : (
              <span className="hidden sm:block" />
            )}
            {next && (
              <Link href={guideArticlePath(base, next.id)} className="rounded-xl border border-line bg-surface p-4 transition-colors hover:border-line-strong sm:text-right">
                <span className="block text-xs text-fg-subtle">Next →</span>
                <span className="mt-1 block text-sm font-semibold text-fg">{next.title}</span>
              </Link>
            )}
          </nav>
        </div>
      </div>
    </article>
  );
}

/**
 * The whole manual on one page, for printing or saving as a PDF: a contents list, then every category with its
 * entries (each category starts a new sheet), then the settings reference. `entries` and `settings` are what this
 * reader may see.
 */
export function GuidePrint({ entries, settings, base, linkToAdmin, siteName }: { entries: GuideEntry[]; settings: SettingsGroup[]; base: string; linkToAdmin: boolean; siteName: string }) {
  const toc = guideToc(entries);
  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link href={base} className="link text-sm font-medium">← Back to the manual</Link>
        <PrintButton />
      </div>
      <h1 className="text-3xl font-semibold tracking-tight text-fg">User manual</h1>
      <p className="mt-2 text-sm text-fg-muted">
        {siteName} · Moks CMS · {entries.length} pages{settings.length ? ` and ${settings.reduce((n, g) => n + g.rows.length, 0)} settings` : ""}. The current version is always the one online.
      </p>

      <nav aria-label="Contents" className="mt-8">
        <h2 className={sectionTitle}>Contents</h2>
        <ol className="mt-3 space-y-3 text-sm">
          {toc.map((s) => (
            <li key={s.section}>
              <p className="font-semibold text-fg">{s.section}</p>
              <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-fg-muted">
                {[...s.guides, ...s.faqs].map((e) => (
                  <li key={e.id}>
                    <a href={`#${e.id}`} className="underline-offset-2 hover:underline">{e.title}</a>
                  </li>
                ))}
              </ol>
            </li>
          ))}
          {settings.length > 0 && (
            <li>
              <a href="#settings-reference" className="font-semibold text-fg underline-offset-2 hover:underline">Settings reference</a>
            </li>
          )}
        </ol>
      </nav>

      {toc.map((s) => (
        <section key={s.section} className="mt-10 break-before-page">
          <h2 className="border-b border-line pb-2 text-xl font-semibold text-fg">{s.section}</h2>
          {[...s.guides, ...s.faqs].map((e) => (
            <div key={e.id} id={e.id} className="mt-6">
              <h3 className="text-base font-semibold text-fg">{e.title}</h3>
              {e.kind === "guide" && <p className="mt-1 text-sm text-fg-muted">{e.summary}</p>}
              <GuideBody lines={e.body} />
              {e.diagram && <GuideDiagram d={e.diagram} eager />}
              <GuidePageLink href={e.href} linkToAdmin={linkToAdmin} />
            </div>
          ))}
        </section>
      ))}

      {settings.length > 0 && (
        <section id="settings-reference" className="mt-10 break-before-page">
          <h2 className="border-b border-line pb-2 text-xl font-semibold text-fg">Settings reference</h2>
          <p className="mt-2 text-sm text-fg-muted">Every setting and option, what it does and its default. Defaults only: the manual never shows the values saved on a site.</p>
          {settings.map((g) => (
            <div key={g.id} className="mt-6">
              <h3 className="text-base font-semibold text-fg">{g.title}</h3>
              <p className="mt-0.5 text-xs text-fg-subtle">{g.area}</p>
              {g.description && <p className="mt-1 text-sm text-fg-muted">{g.description}</p>}
              <SettingsTable group={g} />
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
