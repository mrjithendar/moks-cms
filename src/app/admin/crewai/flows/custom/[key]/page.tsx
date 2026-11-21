import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminHeader } from "@/components/admin/ui";
import { BLANK_FLOW, CustomFlowEditor, type CrewOption, type FlowSpec } from "@/components/crewai/CustomFlowEditor";
import { getCustom, listCustom } from "@/lib/crewai/custom";

export const metadata = { title: "Custom flow" };

/** AI & SEO → Flows → New flow (/admin/crewai/flows/custom/new) or one custom flow (crew-jobs plan PR 6). */
export default async function CustomFlowPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const isNew = key === "new";
  const row = isNew ? null : await getCustom("flow", key);
  if (!isNew && !row) notFound();
  const crews: CrewOption[] = (await listCustom("crew")).filter((c) => c.enabled).map((c) => ({ key: c.key, label: c.label, inputs: (c.spec.inputs as string[] | undefined) ?? [] }));
  return (
    <>
      <AdminHeader
        title={row ? row.label : "New flow"}
        description={<>{row ? <>Version {row.version}{row.enabled ? "" : " · switched off"}. </> : null}Steps run in order: your custom crews, conditions on their output, and drafts for the review queue. A custom flow never publishes; a person approves every draft. Its runs are under <Link className="underline" href="/admin/crewai/runs?flow=custom_flow">Flow runs</Link>.</>}
      />
      <CustomFlowEditor initial={(row?.spec as unknown as FlowSpec) ?? BLANK_FLOW} isNew={isNew} enabled={row?.enabled ?? true} crews={crews} />
    </>
  );
}
