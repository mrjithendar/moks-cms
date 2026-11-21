import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminHeader } from "@/components/admin/ui";
import { BLANK_CREW, CustomCrewEditor, type CrewSpec } from "@/components/crewai/CustomCrewEditor";
import { getCustom, listCustom, usedBy } from "@/lib/crewai/custom";

export const metadata = { title: "Custom crew" };

/** AI & SEO → Crews → New crew (/admin/crewai/crews/custom/new) or one custom crew (crew-jobs plan PR 6). */
export default async function CustomCrewPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const isNew = key === "new";
  const row = isNew ? null : await getCustom("crew", key);
  if (!isNew && !row) notFound();
  const flows = row ? usedBy(row.key, await listCustom("flow")).map((f) => f.label) : [];
  return (
    <>
      <AdminHeader
        title={row ? row.label : "New crew"}
        description={<>{row ? <>Version {row.version}{row.enabled ? "" : " · switched off"}. </> : null}A crew you make here runs in your custom flows, with the same rules as the built-in crews: tools from the allowlist only, untrusted data stays data, no delegation or code, the token and time caps, the one LLM budget. <Link className="underline" href="/admin/crewai/crews">All crews</Link></>}
      />
      <CustomCrewEditor initial={(row?.spec as unknown as CrewSpec) ?? BLANK_CREW} isNew={isNew} enabled={row?.enabled ?? true} usedBy={flows} />
    </>
  );
}
