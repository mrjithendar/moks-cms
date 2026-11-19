import { AdminHeader, Card } from "@/components/admin/ui";
import { ConfigTransfer } from "@/components/crewai/ConfigTransfer";
import { hasSchedules } from "@/lib/crewai/schedules";

export const metadata = { title: "Import / export" };

/** Import and export of the console's configuration: schedules, crew versions and skills (lib/crewai/config-io.ts). */
export default async function CrewaiConfigPage() {
  const ready = await hasSchedules().catch(() => false);
  return (
    <>
      <AdminHeader title="Import / export" description="Copy the CrewAI configuration (schedules, crew versions and skills) to another site, keep it in the site's repository, or save it before a big change." />
      {!ready && <Card><p className="mb-4 text-sm text-fg-muted">Import and export work once database migration 0037 is applied (the web app applies it when it starts).</p></Card>}
      <ConfigTransfer disabled={!ready} />
    </>
  );
}
