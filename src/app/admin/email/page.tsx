import type { FlashParams } from "@/components/admin/Flash";
import { SettingsSections } from "@/components/admin/SettingsSections";
import { AdminHeader, Card } from "@/components/admin/ui";
import { emailSummary } from "@/lib/mail";
import { requireRole } from "@/lib/session";
import { EmailSettings } from "./EmailSettings";

export const metadata = { title: "Email" };

/** The page's sections: the same sectioned layout as Settings → General, one at a time at /admin/email?section=<id>. */
const SECTIONS = [
  { id: "provider", label: "Provider" },
  { id: "test", label: "Test message" },
] as const;

/** Outgoing email: provider, sender and a test message (was part of Storage & email until 2026-11-18). */
export default async function EmailPage({ searchParams }: { searchParams: FlashParams }) {
  const me = await requireRole("admin");
  const [e, sp] = await Promise.all([emailSummary(), searchParams]);
  const section = SECTIONS.find((x) => x.id === sp.section)?.id ?? "provider";
  return (
    <>
      <AdminHeader title="Email" description="Outgoing email: sign-up verification, password resets, invitations and contact-form notifications. Keys are encrypted at rest and never shown again." />
      <SettingsSections sections={SECTIONS} current={section} basePath="/admin/email" label="Email sections">
        <Card>
          <div className="mb-4">
            <h2 className="font-semibold text-fg">{section === "provider" ? "Provider" : "Test message"}</h2>
            {section === "provider" && <p className="mt-1 text-sm text-fg-muted">Setup steps per provider: <code>docs/EMAIL.md</code>.</p>}
          </div>
          <EmailSettings key={section} initial={e} adminEmail={me.email} part={section} />
        </Card>
      </SettingsSections>
    </>
  );
}
