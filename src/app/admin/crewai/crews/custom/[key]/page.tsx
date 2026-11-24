import { redirect } from "next/navigation";

/** Custom crews' addresses before migration 0041: every crew is under /admin/crewai/crews/<key> now (D-100). */
export default async function OldCustomCrewPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  redirect(key === "new" ? "/admin/crewai/crews/new" : `/admin/crewai/crews/${encodeURIComponent(key)}`);
}
