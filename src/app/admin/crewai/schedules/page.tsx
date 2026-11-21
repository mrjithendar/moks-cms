import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/** Schedules are the system jobs on AI & SEO → Jobs since 2026-11-21 (components/crewai/SystemJobs.tsx). */
export default async function CrewaiSchedulesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const flow = sp.flow && /^[a-z][a-z0-9_]{2,39}_flow$/.test(sp.flow) ? sp.flow : null;
  redirect(`/admin/crewai/jobs?kind=system${flow ? `&flow=${flow}` : ""}`);
}
