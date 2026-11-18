import { AdminHeader, Card } from "@/components/admin/ui";
import { emailSummary } from "@/lib/mail";
import { requireRole } from "@/lib/session";
import { EmailSettings } from "./EmailSettings";

export const metadata = { title: "Email" };

/** Outgoing email: provider, sender and a test message (was part of Storage & email until 2026-11-18). */
export default async function EmailPage() {
  const me = await requireRole("admin");
  const e = await emailSummary();
  return (
    <>
      <AdminHeader title="Email" description="Outgoing email: sign-up verification, password resets, invitations and contact-form notifications. Keys are encrypted at rest and never shown again." />
      <Card>
        <div className="mb-4">
          <h2 className="font-semibold text-fg">Provider</h2>
          <p className="mt-1 text-sm text-fg-muted">Setup steps per provider: <code>docs/EMAIL.md</code>.</p>
        </div>
        <EmailSettings initial={e} adminEmail={me.email} />
      </Card>
    </>
  );
}
