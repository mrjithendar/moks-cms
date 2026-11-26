import Link from "next/link";
import { LocalTime } from "@/components/LocalTime";
import { Flash, type FlashParams } from "@/components/admin/Flash";
import { SettingsElsewhere } from "@/components/admin/SettingsParts";
import { AdminHeader, Card, StatusPill } from "@/components/admin/ui";
import { Button } from "@/components/ui/form";
import { adminActor } from "@/lib/admin";
import { flash } from "@/lib/flash";
import { moneyLabel, type PayCurrency } from "@/lib/hire-me";
import { deletePayment, listPayments, RAZORPAY_DASHBOARD_PAYMENT, razorpayKeys, type PaymentFilter } from "@/lib/razorpay";
import { effectiveEnv } from "@/lib/runtime-settings";
import { requireRole } from "@/lib/session";
import { settingsHref } from "@/lib/settings-areas";

export const metadata = { title: "Payments" };

const FILTERS: PaymentFilter[] = ["paid", "failed", "created", "all"];
const FILTER_LABEL: Record<PaymentFilter, string> = { paid: "Paid", failed: "Failed", created: "Started, not paid", all: "All" };

async function act(form: FormData) {
  "use server";
  const actor = await adminActor();
  const back = `/admin/payments?status=${String(form.get("back") ?? "paid")}`;
  await flash(back, async () => {
    await deletePayment(actor, String(form.get("id")));
    return "Removed from this list (the payment in Razorpay is unchanged and not refunded).";
  });
}

export default async function PaymentsPage({ searchParams }: { searchParams: FlashParams }) {
  await requireRole("admin");
  const sp = await searchParams;
  const filter = FILTERS.find((f) => f === sp.status) ?? "paid";
  const [rows, env] = await Promise.all([listPayments(filter), effectiveEnv()]);
  const keys = razorpayKeys(env);
  const totals = new Map<string, number>();
  if (filter === "paid") for (const r of rows) totals.set(r.currency, (totals.get(r.currency) ?? 0) + r.amount);
  return (
    <>
      <AdminHeader
        title="Payments"
        description={
          <>
            Paid calls from the Hire me page (Razorpay). Refunds and settlements are handled in the Razorpay dashboard. Bills you send to clients are under{" "}
            <Link href="/admin/invoices" className="link">Invoices</Link>.
          </>
        }
      />
      <Flash ok={sp.ok} error={sp.error} />
      {(!keys.keyId || !keys.keySecret || !keys.webhookSecret) && (
        <Card>
          <p className="text-sm text-fg-muted">
            {!keys.keyId || !keys.keySecret ? "Not connected yet: add the Key ID and Key secret" : "Add the webhook secret"} in{" "}
            <Link href={settingsHref("razorpay")} className="link">Settings → Payments &amp; bookings → Razorpay</Link>, which also shows the webhook URL and its events. Then switch on
            paid calls in <Link href="/admin/appearance?section=hireMe" className="link">Appearance → Hire me</Link>.
          </p>
        </Card>
      )}
      <nav aria-label="Filter payments" className="my-6 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <Link key={f} href={`/admin/payments?status=${f}`} aria-current={f === filter ? "page" : undefined}
            className={`rounded-full px-3 py-1 text-sm font-medium ${f === filter ? "bg-fg text-canvas" : "border border-slate-200 dark:border-white/10"}`}>
            {FILTER_LABEL[f]}
          </Link>
        ))}
      </nav>
      {totals.size > 0 && (
        <p className="mb-4 text-sm text-fg-muted">
          Shown here: {[...totals].map(([c, a]) => moneyLabel(a, c as PayCurrency)).join(" + ")} (latest 300).
        </p>
      )}
      <div className="space-y-4">
        {rows.length === 0 && <p className="text-sm text-slate-500">No payments.</p>}
        {rows.map((p) => (
          <Card key={p.id}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-semibold text-fg">{moneyLabel(p.amount, p.currency as PayCurrency)} · {p.minutes}-minute call</span>
              <span className="flex items-center gap-2 text-sm text-slate-500">
                <StatusPill status={p.status} />
                <LocalTime iso={(p.paidAt ?? p.createdAt).toISOString()} />
              </span>
            </div>
            <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm text-fg-muted sm:grid-cols-2">
              <div><dt className="inline font-semibold">From: </dt><dd className="inline">{p.name} &lt;{p.email}&gt;</dd></div>
              {p.country && <div><dt className="inline font-semibold">Country: </dt><dd className="inline">{p.country}</dd></div>}
              <div><dt className="inline font-semibold">Order: </dt><dd className="inline break-all font-mono text-xs">{p.orderId}</dd></div>
              {p.paymentId && (
                <div><dt className="inline font-semibold">Payment: </dt><dd className="inline break-all font-mono text-xs"><a href={RAZORPAY_DASHBOARD_PAYMENT(p.paymentId)} target="_blank" rel="noopener" className="underline">{p.paymentId}</a></dd></div>
              )}
              {p.failureReason && <div className="sm:col-span-2"><dt className="inline font-semibold">Reason: </dt><dd className="inline">{p.failureReason}</dd></div>}
            </dl>
            {p.topic && <p className="mt-3 whitespace-pre-line break-words text-slate-800 dark:text-slate-200">{p.topic}</p>}
            <form action={act} className="mt-4 flex flex-wrap gap-2">
              <input type="hidden" name="id" value={p.id} />
              <input type="hidden" name="back" value={filter} />
              <a href={`mailto:${p.email}?subject=${encodeURIComponent(`Your ${p.minutes}-minute call`)}`} className="inline-flex items-center rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-on-accent">Email</a>
              <Button type="submit" variant="ghost">Remove from list</Button>
            </form>
          </Card>
        ))}
      </div>
      <SettingsElsewhere href={settingsHref("razorpay")}>the Razorpay keys and webhook are in Settings → Payments &amp; bookings → Razorpay.</SettingsElsewhere>
    </>
  );
}
