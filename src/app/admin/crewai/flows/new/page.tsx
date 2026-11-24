import Link from "next/link";
import { AdminHeader } from "@/components/admin/ui";
import { BLANK_FLOW, CustomFlowEditor } from "@/components/crewai/CustomFlowEditor";
import { builderOptions } from "@/lib/crewai/builder-options";
import { listCategories } from "@/lib/crewai/catalog";
import { agentCrews, agentFlows } from "@/lib/crewai/catalogue";

export const metadata = { title: "New flow" };

/** AI & SEO → Flows → New flow: a flow of steps from scratch (or duplicate any flow, built-in ones too, from its page). */
export default async function NewFlowPage() {
  const [crews, flows, categories] = await Promise.all([agentCrews(), agentFlows(), listCategories()]);
  const options = await builderOptions(crews, flows);
  return (
    <>
      <AdminHeader
        title="New flow"
        description={<>Steps run in order: crews, other flows, conditions and drafts for the review queue, each with the steps it needs, a condition, retries, a time limit and what to do when it fails. A flow never publishes on its own: a person approves every draft. To start from an existing flow, open it and duplicate it. <Link className="underline" href="/admin/crewai/flows">All flows</Link></>}
      />
      <CustomFlowEditor initial={BLANK_FLOW} isNew enabled crews={options.crews} flows={options.flows} categories={categories} />
    </>
  );
}
