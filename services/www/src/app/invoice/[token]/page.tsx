import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Container } from "@/components/Container";
import { INVOICE_PRINT_CSS, InvoiceSheet } from "@/components/invoice/InvoiceSheet";
import { PrintButton } from "@/components/seo/PrintButton";
import { Alert, buttonClass } from "@/components/ui/form";
import { clientInvoice, confirmInvoiceReturn } from "@/lib/invoices";

// One client's bill behind an unguessable address: rendered for each request, never cached, never indexed
// (the proxy and next.config.ts add the headers).
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Invoice", robots: { index: false, follow: false } };

type Props = { params: Promise<{ token: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

/**
 * /invoice/{token}: what the client opens from the email. Shows the invoice, a Pay button while it can be paid
 * online (a Razorpay payment link) and the PDF. Razorpay sends the client back here after paying, with a signed
 * address that records the payment straight away (the webhook does the same, server to server).
 */
export default async function ClientInvoicePage({ params, searchParams }: Props) {
  const [{ token }, sp] = await Promise.all([params, searchParams]);
  if (typeof sp.razorpay_payment_link_id === "string") {
    const paid = await confirmInvoiceReturn(token, sp);
    // A clean address afterwards: the payment details do not stay in the history or get shared with the link.
    redirect(`/invoice/${encodeURIComponent(token)}${paid ? "?thanks=1" : ""}`);
  }
  const found = await clientInvoice(token);
  if (!found) notFound();
  const { document: doc, payUrl, overdue, row } = found;
  const pdf = `/invoice/${encodeURIComponent(token)}/pdf`;
  return (
    <Container className="py-10 sm:py-14">
      <style>{INVOICE_PRINT_CSS}</style>
      <div className="mx-auto max-w-3xl">
        <div data-invoice-actions className="mb-6 space-y-4">
          {row.status === "paid" && <Alert tone="success">{sp.thanks ? "Thank you. Your payment was received and this invoice is paid." : "This invoice is paid. Thank you."}</Alert>}
          {row.status === "void" && <Alert tone="info">This invoice was cancelled. Nothing is due.</Alert>}
          {row.status === "sent" && overdue && <Alert tone="info">This invoice was due on {doc.dueDate}.</Alert>}
          <div className="flex flex-wrap items-center gap-3">
            {payUrl && (
              <a href={payUrl} rel="noopener noreferrer" className={buttonClass("primary", "lg")}>
                Pay {doc.summary.value} online
              </a>
            )}
            <a href={pdf} className={buttonClass(payUrl ? "secondary" : "primary", "lg")}>
              Download PDF
            </a>
            <PrintButton />
          </div>
          {payUrl && <p className="text-sm text-fg-muted">Payment is taken by Razorpay on their secure page. You come back here afterwards, and this page then shows the invoice as paid.</p>}
        </div>
        <InvoiceSheet doc={doc} />
      </div>
    </Container>
  );
}
