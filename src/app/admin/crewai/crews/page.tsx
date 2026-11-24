import Link from "next/link";
import { AdminHeader } from "@/components/admin/ui";
import { CatalogFilters } from "@/components/crewai/CatalogFilters";
import { CatalogList } from "@/components/crewai/CatalogList";
import { buttonClass } from "@/components/ui/form";
import { listCatalog, listCategories, parseFilter, syncFromAgent } from "@/lib/crewai/catalog";
import { agentCrews } from "@/lib/crewai/catalogue";

export const metadata = { title: "Crews" };

/**
 * AI & SEO → Crews: every crew in one list (D-100), filtered, sorted and paged on the server (lib/crewai/catalog.ts).
 * There are no built-in and custom crews: any crew can be edited, duplicated, switched off or deleted; categories and
 * tags only organise them. Crews the agent reports that the list does not have yet are added as it opens.
 */
export default async function CrewaiCrewsPage({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> } = {}) {
  const filter = parseFilter((await searchParams) ?? {});
  await syncFromAgent(null, await agentCrews()).catch(() => 0);
  const [page, categories] = await Promise.all([listCatalog("crew", filter), listCategories()]);
  return (
    <>
      <AdminHeader
        title="Crews"
        description="Every crew: its agents (role, goal, backstory, model, tools), its tasks, its inputs and output, its versions and the runs of the flows that run it. Open one to edit or test it; duplicate any crew to start a new one from it."
        actions={
          <>
            <Link href="/admin/crewai/categories" className={buttonClass("ghost")}>Categories</Link>
            <Link href="/admin/crewai/crews/new" className={buttonClass("primary")}>New crew</Link>
          </>
        }
      />
      <CatalogFilters kind="crew" filter={filter} categories={categories} facets={page.facets} total={page.total} />
      <CatalogList page={page} filter={filter} categories={categories} basePath="/admin/crewai/crews" newHref="/admin/crewai/crews/new" />
    </>
  );
}
