import Link from "next/link";
import type { ReactNode } from "react";
import { AdminHeader } from "@/components/admin/ui";
import { Alert } from "@/components/ui/form";
import type { invoiceReadiness } from "@/lib/invoices";

/** Demo accounts see the admin as an admin does, except other people's bills: names, addresses and amounts. */
export function HiddenFromDemo() {
  return (
    <>
      <AdminHeader title="Invoices" description="Send invoices to clients, take payment through Razorpay, and keep every invoice as a PDF." />
      <Alert tone="info">Invoices hold clients&apos; names, addresses and amounts, so they are not shown to demo accounts.</Alert>
    </>
  );
}

/** What still has to be set up before an invoice can be sent (or paid online). Nothing when everything is ready. */
export function Readiness({ ready }: { ready: Awaited<ReturnType<typeof invoiceReadiness>> }) {
  const todo: ReactNode[] = [];
  if (!ready.business) {
    todo.push(
      <>
        Add your business name and address in <Link href="/admin/invoices/settings" className="link">Invoice settings</Link>: they are printed on every invoice.
      </>,
    );
  }
  if (!ready.storage) {
    todo.push(
      <>
        Connect file storage in <Link href="/admin/storage" className="link">Storage</Link>: the invoice PDF is stored there, and an invoice cannot be sent without it.
      </>,
    );
  }
  if (ready.settings.onlinePayment && !ready.razorpay) {
    todo.push(
      <>
        Razorpay is not connected, so invoices go out without a Pay button. Add the Key ID and Key secret in{" "}
        <Link href="/admin/advanced" className="link">Advanced settings → Razorpay payments</Link>.
      </>,
    );
  }
  if (ready.online && !ready.webhook) {
    todo.push(
      <>
        Add the Razorpay webhook secret in <Link href="/admin/advanced" className="link">Advanced settings</Link> and switch on the events payment_link.paid, payment_link.cancelled and
        payment_link.expired for the webhook in Razorpay. Without it a payment is only recorded when the client returns to the invoice page after paying.
      </>,
    );
  }
  if (todo.length === 0) return null;
  return (
    <div className="mb-6">
      <Alert tone="info">
        <p className="font-semibold">Before you send</p>
        <ul className="mt-1 list-disc space-y-1 pl-5">
          {todo.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      </Alert>
    </div>
  );
}
