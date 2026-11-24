import Link from "next/link";
import type { ReactNode } from "react";
import { Ago } from "@/components/crewai/Ago";
import type { CatalogItem, Category } from "@/lib/crewai/catalog-shared";
import { CatalogActions } from "./CatalogActions";
import { CategoryChips, StateBadge } from "./CatalogList";

/**
 * The top of every crew's and flow's page: where it is in the console, its name and state, its categories and tags,
 * one line of facts, and the same actions for all of them (switch, duplicate, delete or restore).
 */
export function ItemHeader({ item, categories, facts, extra }: { item: CatalogItem; categories: Category[]; facts?: ReactNode; extra?: ReactNode }) {
  const list = item.kind === "crew" ? "/admin/crewai/crews" : "/admin/crewai/flows";
  return (
    <header className="mb-6 space-y-3">
      <nav aria-label="Breadcrumb" className="text-sm text-fg-muted">
        <Link href={list} className="hover:underline">{item.kind === "crew" ? "Crews" : "Flows"}</Link>
        <span className="mx-1.5 text-fg-subtle">/</span>
        <span className="text-fg-subtle">{item.key}</span>
      </nav>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight text-fg">{item.label}</h1>
            <StateBadge enabled={item.enabled} deleted={Boolean(item.deletedAt)} />
          </div>
          {item.description && <p className="max-w-3xl text-sm text-fg-muted">{item.description}</p>}
          <div className="flex flex-wrap items-center gap-2">
            <CategoryChips slugs={item.categories} categories={categories} linkBase={list} />
            {item.tags.map((t) => <Link key={t} href={`${list}?tag=${encodeURIComponent(t)}`} className="text-xs text-fg-subtle hover:underline">#{t}</Link>)}
          </div>
          <p className="text-xs text-fg-subtle">
            <code>{item.key}</code>
            {item.definition === "spec" && <> · v{item.version}</>} · {item.runs.total} run{item.runs.total === 1 ? "" : "s"} · changed <Ago iso={item.updatedAt} />{item.updatedBy ? ` by ${item.updatedBy}` : ""}
            {facts ? <> · {facts}</> : null}
          </p>
          {!item.enabled && !item.deletedAt && item.disabledReason && <p className="text-sm text-amber-800 dark:text-amber-200">Switched off: {item.disabledReason}</p>}
          {item.deletedAt && <p className="text-sm text-fg-muted">Deleted <Ago iso={item.deletedAt} />. Its run history stays; restore it to edit or run it again.</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {extra}
          <CatalogActions item={{ kind: item.kind, key: item.key, label: item.label, enabled: item.enabled, deleted: Boolean(item.deletedAt), definition: item.definition }} />
        </div>
      </div>
    </header>
  );
}

/** A small list of an item's spec versions (newest first) with Restore. */
export function SpecVersionList({ versions, current, restore }: { versions: { version: number; note: string; createdAt: string; createdBy: string | null }[]; current: number; restore: (v: number) => ReactNode }) {
  if (versions.length === 0) return <p className="text-sm text-fg-muted">No versions yet.</p>;
  return (
    <ol className="divide-y divide-line rounded-lg border border-line">
      {versions.map((v) => (
        <li key={v.version} className="flex flex-wrap items-start justify-between gap-2 px-3 py-2 text-sm">
          <div>
            <span className="font-medium text-fg">v{v.version}</span>
            {v.version === current && <span className="ml-2 text-xs text-emerald-700 dark:text-emerald-300">current</span>}
            {v.note && <p className="text-xs text-fg [overflow-wrap:anywhere]">{v.note}</p>}
            <p className="text-xs text-fg-subtle">{v.createdBy ?? "?"} · <Ago iso={v.createdAt} /></p>
          </div>
          {v.version !== current && restore(v.version)}
        </li>
      ))}
    </ol>
  );
}
