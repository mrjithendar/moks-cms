import Link from "next/link";
import { RuntimeSettings } from "@/components/admin/RuntimeSettings";
import { SeeAlso } from "@/components/admin/SettingsParts";
import { Card } from "@/components/admin/ui";
import { Field, Input } from "@/components/ui/form";
import { absoluteUrl } from "@/config/site";

/**
 * Sections that are one runtime-settings group (lib/runtime-settings.ts GROUPS; the section id is the group id). The
 * form is components/admin/RuntimeSettings.tsx, as on the pages these groups were on before 2026-11-26 (Integrations,
 * Users, Media & storage, Payments, Bookings, Cache). Like every section, the async form is awaited here, never nested
 * as an element (the page calls a section's render directly).
 */
export const runtimeSection = (id: string) =>
  async function RuntimeSection() {
    return RuntimeSettings({ ids: [id], layout: "section" });
  };

/** Settings → Payments & bookings → Razorpay: the keys, and how to connect the webhook (was on Billing → Payments). */
export async function RazorpaySection() {
  const webhook = absoluteUrl("/api/razorpay/webhook");
  return (
    <>
      {await RuntimeSettings({ ids: ["razorpay"], layout: "section" })}
      <Card>
        <h3 className="font-semibold text-fg">Webhook</h3>
        <p className="mt-1 text-sm text-fg-muted">
          In the Razorpay dashboard, add a webhook with this URL and the same secret as above, for the events <code>payment.captured</code>, <code>payment.failed</code> and{" "}
          <code>order.paid</code> (paid calls) and <code>payment_link.paid</code>, <code>payment_link.cancelled</code> and <code>payment_link.expired</code> (invoices). Then switch on paid calls in <Link href="/admin/appearance?section=hireMe" className="link">Appearance → Hire me</Link>.
        </p>
        <div className="mt-4">
          <Field label="Webhook URL" htmlFor="razorpay-webhook">
            <Input id="razorpay-webhook" readOnly value={webhook} className="font-mono text-xs" />
          </Field>
        </div>
      </Card>
      <SeeAlso href="/admin/payments">Billing → Payments: the payments received</SeeAlso>
    </>
  );
}

/** Settings → Payments & bookings → Cal.com bookings: the webhook secret, and how to connect it (was on Comments → Bookings). */
export async function CalcomSection() {
  const webhook = absoluteUrl("/api/cal/webhook");
  return (
    <>
      {await RuntimeSettings({ ids: ["calcom"], layout: "section" })}
      <Card>
        <h3 className="font-semibold text-fg">Webhook</h3>
        <p className="mt-1 text-sm text-fg-muted">In Cal.com: Settings → Developer → Webhooks → New, with this subscriber URL, the booking events, and the same secret as above.</p>
        <div className="mt-4">
          <Field label="Subscriber URL" htmlFor="calcom-webhook">
            <Input id="calcom-webhook" readOnly value={webhook} className="font-mono text-xs" />
          </Field>
        </div>
      </Card>
      <SeeAlso href="/admin/bookings">Comments → Bookings: the meetings booked</SeeAlso>
    </>
  );
}

/** Settings → System → Cloudflare cache: zone, token and purge policy (was on Tools → Cache, where the purges still are). */
export async function CloudflareSection() {
  return (
    <>
      {await RuntimeSettings({ ids: ["cloudflare"], layout: "section" })}
      <SeeAlso href="/admin/cache#cloudflare-purge">Tools → Cache: test the connection and purge Cloudflare now</SeeAlso>
    </>
  );
}
