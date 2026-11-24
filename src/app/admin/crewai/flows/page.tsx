import Link from "next/link";
import { AdminHeader } from "@/components/admin/ui";
import { CatalogFilters } from "@/components/crewai/CatalogFilters";
import { CatalogList } from "@/components/crewai/CatalogList";
import { buttonClass } from "@/components/ui/form";
import { listCatalog, listCategories, parseFilter, syncFromAgent } from "@/lib/crewai/catalog";
import { agentFlows } from "@/lib/crewai/catalogue";

export const metadata = { title: "Flows" };

/**
 * AI & SEO → Flows: every flow in one list (D-100). There are no system, custom, content or SEO kinds of flow any
 * more: each is a workflow with categories and tags, edited, duplicated, switched off or deleted the same way, and run
 * by the same engine (lib/crewai/catalog.ts). The old ?kind= addresses become category filters.
 */
export default async function CrewaiFlowsPage({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> } = {}) {
  const sp = (await searchParams) ?? {};
  const legacy = { content: "content", custom: "custom" }[String(sp.kind ?? "")];
  const filter = parseFilter(legacy && !sp.category ? { ...sp, category: legacy } : sp);
  const agent = await agentFlows();
  await syncFromAgent(agent ? [...agent.values()] : null, null).catch(() => 0);
  const [page, categories] = await Promise.all([listCatalog("flow", filter), listCategories()]);
  return (
    <>
      <AdminHeader
        title="Flows"
        description="Every flow: what it runs, when, and its last runs. Open one to edit its steps, settings and schedule, test it or start it; duplicate any flow to build a new one around it."
        actions={
          <>
            <Link href="/admin/crewai/runs" className={buttonClass("ghost")}>Runs</Link>
            <Link href="/admin/crewai/schedules" className={buttonClass("ghost")}>Schedules</Link>
            <Link href="/admin/crewai/flows/content/new" className={buttonClass("secondary")}>New content flow</Link>
            <Link href="/admin/crewai/flows/new" className={buttonClass("primary")}>New flow</Link>
          </>
        }
      />
      {!agent && <p role="status" className="mb-4 rounded-lg border border-line bg-surface-muted p-3 text-sm text-fg-muted">The SEO agent did not answer: the list is the admin&apos;s own, and flows cannot be started until it is back.</p>}
      <CatalogFilters kind="flow" filter={filter} categories={categories} facets={page.facets} total={page.total} />
      <CatalogList page={page} filter={filter} categories={categories} basePath="/admin/crewai/flows" newHref="/admin/crewai/flows/new" />
    </>
  );
}
