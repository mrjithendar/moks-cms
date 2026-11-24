import Link from "next/link";
import { Card } from "@/components/admin/ui";
import { Ago } from "@/components/crewai/Ago";
import { RunStatusIcon } from "@/components/crewai/RunStatusIcon";
import { buttonClass } from "@/components/ui/form";
import { filterQuery, itemHref, type CatalogFilter, type CatalogPage, type Category } from "@/lib/crewai/catalog-shared";
import { CatalogActions } from "./CatalogActions";

/** A crew's or flow's state as one dot and word: on, off, deleted (never a kind). */
export function StateBadge({ enabled, deleted }: { enabled: boolean; deleted: boolean }) {
  const [dot, word] = deleted ? ["bg-slate-400", "Deleted"] : enabled ? ["bg-emerald-500", "On"] : ["bg-amber-500", "Off"];
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-fg-muted">
      <span className={`h-2 w-2 rounded-full ${dot}`} aria-hidden="true" />
      {word}
    </span>
  );
}

export function CategoryChips({ slugs, categories, linkBase }: { slugs: string[]; categories: Category[]; linkBase?: string }) {
  if (slugs.length === 0) return null;
  const label = new Map(categories.map((c) => [c.slug, c.label]));
  return (
    <span className="flex flex-wrap gap-1">
      {slugs.map((s) =>
        linkBase ? (
          <Link key={s} href={`${linkBase}?category=${s}`} className="rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent-text hover:underline">{label.get(s) ?? s}</Link>
        ) : (
          <span key={s} className="rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent-text">{label.get(s) ?? s}</span>
        ),
      )}
    </span>
  );
}

/**
 * The rows of AI & SEO → Crews or → Flows: one layout for both. Name and description, categories and tags, on/off,
 * runs and the last run, when it changed, and the same actions menu (open, switch, duplicate, delete or restore).
 * A list on phones, columns from the medium breakpoint; no card per row.
 */
export function CatalogList({ page, filter, categories, basePath, newHref }: { page: CatalogPage; filter: CatalogFilter; categories: Category[]; basePath: string; newHref: string }) {
  const kind = page.items[0]?.kind;
  const filtered = filterQuery(filter, { page: 1, sort: "name", dir: undefined }) !== "";
  if (page.items.length === 0) {
    return (
      <Card>
        <div className="space-y-3 text-sm text-fg-muted">
          {filtered ? (
            <>
              <p>Nothing matches these filters.</p>
              <Link href={basePath} className={buttonClass("secondary", "sm")}>Clear all filters</Link>
            </>
          ) : (
            <>
              <p>Nothing here yet. Start from scratch, or open one that exists and duplicate it.</p>
              <Link href={newHref} className={buttonClass("primary", "sm")}>Create one</Link>
            </>
          )}
        </div>
      </Card>
    );
  }
  const pages = Math.max(1, Math.ceil(page.total / page.pageSize));
  return (
    <>
      <div className="overflow-hidden rounded-xl border border-line bg-surface">
        <div className="hidden grid-cols-[minmax(0,1fr)_7rem_9rem_8rem_2.5rem] gap-4 border-b border-line bg-surface-muted px-4 py-2 text-xs font-semibold text-fg-subtle md:grid" aria-hidden="true">
          <span>{kind === "crew" ? "Crew" : "Flow"}</span>
          <span>Runs</span>
          <span>Last run</span>
          <span>Changed</span>
          <span />
        </div>
        <ul className="divide-y divide-line" aria-label={kind === "crew" ? "Crews" : "Flows"}>
          {page.items.map((i) => (
            <li key={i.key} className={`grid gap-2 px-4 py-3 md:grid-cols-[minmax(0,1fr)_7rem_9rem_8rem_2.5rem] md:items-start md:gap-4 ${i.enabled && !i.deletedAt ? "" : "bg-surface-muted/40"}`}>
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <Link href={itemHref(i)} className="font-medium text-fg hover:underline">{i.label}</Link>
                  <StateBadge enabled={i.enabled} deleted={Boolean(i.deletedAt)} />
                  {i.runs.running > 0 && <span className="inline-flex items-center gap-1 text-xs text-sky-700 dark:text-sky-300"><RunStatusIcon status="running" size={12} decorative />{i.runs.running} running</span>}
                </div>
                {i.description && <p className="line-clamp-2 text-sm text-fg-muted">{i.description}</p>}
                <div className="flex flex-wrap items-center gap-2">
                  <CategoryChips slugs={i.categories} categories={categories} />
                  {i.tags.map((t) => <span key={t} className="text-xs text-fg-subtle">#{t}</span>)}
                  <code className="text-xs text-fg-subtle">{i.key}</code>
                </div>
              </div>
              <p className="text-sm tabular-nums text-fg-muted"><span className="md:hidden">Runs: </span>{i.runs.total}</p>
              <div className="text-sm">
                {i.runs.last ? (
                  <Link href={`/admin/crewai/runs/${i.runs.last.runId}`} className="inline-flex items-center gap-1.5 text-fg hover:underline">
                    <RunStatusIcon status={i.runs.last.status} />#{i.runs.last.number ?? "?"} <span className="text-xs text-fg-subtle"><Ago iso={i.runs.last.startedAt} /></span>
                  </Link>
                ) : (
                  <span className="text-xs text-fg-subtle">never run</span>
                )}
              </div>
              <p className="text-xs text-fg-subtle"><Ago iso={i.updatedAt} />{i.updatedBy ? <span className="block truncate">{i.updatedBy}</span> : null}</p>
              <div className="md:justify-self-end">
                <CatalogActions compact item={{ kind: i.kind, key: i.key, label: i.label, enabled: i.enabled, deleted: Boolean(i.deletedAt), definition: i.definition }} />
              </div>
            </li>
          ))}
        </ul>
      </div>
      {pages > 1 && (
        <nav aria-label="Pages" className="mt-4 flex flex-wrap items-center justify-between gap-2 text-sm">
          <p className="text-fg-muted">Page {page.page} of {pages}</p>
          <div className="flex gap-2">
            {page.page > 1 && <Link href={`${basePath}?${filterQuery(filter, { page: page.page - 1 })}`} className={buttonClass("secondary", "sm")} rel="prev">Previous</Link>}
            {page.page < pages && <Link href={`${basePath}?${filterQuery(filter, { page: page.page + 1 })}`} className={buttonClass("secondary", "sm")} rel="next">Next</Link>}
          </div>
        </nav>
      )}
    </>
  );
}
