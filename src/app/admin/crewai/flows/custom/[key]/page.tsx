import { redirect } from "next/navigation";

/** Custom flows' addresses before migration 0041: every flow is under /admin/crewai/flows/<key> now (D-100). */
export default async function OldCustomFlowPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  redirect(key === "new" ? "/admin/crewai/flows/new" : `/admin/crewai/flows/${encodeURIComponent(key)}`);
}
