import { AdminHeader } from "@/components/admin/ui";
import { CategoryManager } from "@/components/crewai/CategoryManager";
import { listCategories } from "@/lib/crewai/catalog";

export const metadata = { title: "Categories" };

/** AI & SEO → Categories: what crews and flows are filed under, for finding and filtering them (never how they run). */
export default async function CrewaiCategoriesPage() {
  return (
    <>
      <AdminHeader title="Categories" description="Crews and flows are filed under any number of categories, for finding and filtering them. Categories never change how a crew or flow runs. Renaming one keeps it on everything filed under it; removing one takes it off them." />
      <CategoryManager categories={await listCategories()} />
    </>
  );
}
