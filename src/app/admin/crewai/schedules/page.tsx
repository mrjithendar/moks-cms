import Link from "next/link";
import { AdminHeader } from "@/components/admin/ui";
import { FlowSchedules } from "@/components/crewai/FlowSchedules";

export const metadata = { title: "Schedules" };

/**
 * AI & SEO → Flows → Schedules: when the built-in flows and the custom flows run (components/crewai/FlowSchedules.tsx).
 * The "system jobs" of the Jobs page from 2026-11-21 to 2026-11-23. ?flow= narrows it to one flow.
 */
export default async function SchedulesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const flow = sp.flow && /^[a-z][a-z0-9_]{2,39}_flow$/.test(sp.flow) ? sp.flow : null;
  const schedules = await FlowSchedules({ flow });
  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-3 text-sm text-fg-muted">
        <Link href="/admin/crewai/flows" className="hover:underline">Flows</Link>
      </nav>
      <AdminHeader
        title="Schedules"
        description="When the built-in flows and your custom flows run: Search Console and GA4 syncs, audits, reports, the ML models, content flow housekeeping. One dispatcher checks these and the content flows every minute and starts what is due. Times are a cron expression in a time zone; a content flow's own time is set in that flow."
      />
      {schedules}
    </>
  );
}
