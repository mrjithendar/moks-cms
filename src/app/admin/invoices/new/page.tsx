import Link from "next/link";
import { AdminHeader } from "@/components/admin/ui";
import { addDays, formatHundredths } from "@/lib/invoice-math";
import { invoiceContext, invoiceReadiness } from "@/lib/invoices";
import { requireRole } from "@/lib/session";
import { InvoiceForm } from "../InvoiceForm";
import { HiddenFromDemo, Readiness } from "../parts";

export const metadata = { title: "New invoice" };

export default async function NewInvoicePage() {
  const user = await requireRole("admin");
  if (user.demo) return <HiddenFromDemo />;
  const [{ settings, today }, ready] = await Promise.all([invoiceContext(), invoiceReadiness()]);
  return (
    <>
      <AdminHeader
        title="New invoice"
        description={
          <>
            Saved as a draft first. <Link href="/admin/invoices" className="link">Back to invoices</Link>
          </>
        }
      />
      <Readiness ready={ready} />
      <InvoiceForm
        initial={{
          clientName: "",
          clientEmail: "",
          clientCompany: "",
          clientAddress: "",
          clientTaxId: "",
          currency: settings.currency,
          issueDate: today,
          dueDate: addDays(today, settings.dueDays),
          taxLabel: settings.taxLabel,
          taxRate: settings.taxRateBp > 0 ? formatHundredths(settings.taxRateBp) : "",
          notes: "",
          items: [],
        }}
      />
    </>
  );
}
