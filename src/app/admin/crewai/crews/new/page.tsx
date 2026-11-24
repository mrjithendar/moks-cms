import Link from "next/link";
import { AdminHeader } from "@/components/admin/ui";
import { BLANK_CREW, CustomCrewEditor } from "@/components/crewai/CustomCrewEditor";
import { listCategories } from "@/lib/crewai/catalog";

export const metadata = { title: "New crew" };

/** AI & SEO → Crews → New crew: a crew from scratch (or duplicate any crew from its page or the list). */
export default async function NewCrewPage() {
  return (
    <>
      <AdminHeader
        title="New crew"
        description={<>Inputs, agents (role, goal, backstory, tools from the allowlist, model), tasks in order and the output. It runs with the rules every crew follows: tools from the allowlist only, untrusted data stays data, no delegation or code, the token and time caps, the one LLM budget. To start from an existing crew, open it and duplicate it. <Link className="underline" href="/admin/crewai/crews">All crews</Link></>}
      />
      <CustomCrewEditor initial={BLANK_CREW} isNew categories={await listCategories()} />
    </>
  );
}
