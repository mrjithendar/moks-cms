import { SectionHeading } from "@/components/admin/SettingsParts";
import { Card } from "@/components/admin/ui";
import { emailSummary } from "@/lib/mail";
import { requireRole } from "@/lib/session";
import { EmailSettings } from "./EmailSettings";

/** Settings → Email (its own page, /admin/email, until 2026-11-26): the provider and sender, or a test message. */
async function EmailPart({ part }: { part: "provider" | "test" }) {
  const me = await requireRole("admin");
  const e = await emailSummary();
  return (
    <section aria-labelledby={`email-${part}-title`} className="space-y-4">
      <SectionHeading
        id={`email-${part}-title`}
        title={part === "provider" ? "Email provider" : "Test message"}
        description={
          part === "provider" ? (
            <>
              Outgoing email: sign-up verification, password resets, invitations and contact-form notifications. Keys are encrypted at rest and never shown again. Setup steps per
              provider: <code>docs/EMAIL.md</code>.
            </>
          ) : (
            "Sends a message through the saved provider, to check that email arrives."
          )
        }
      />
      <Card>
        <EmailSettings key={part} initial={e} adminEmail={me.email} part={part} />
      </Card>
    </section>
  );
}

export const EmailProviderSection = () => EmailPart({ part: "provider" });
export const EmailTestSection = () => EmailPart({ part: "test" });
