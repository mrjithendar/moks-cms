import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { CopyLink } from "@/components/CopyLink";
import { LocalTime } from "@/components/LocalTime";
import { Flash, type FlashParams } from "@/components/admin/Flash";
import { AdminHeader, Card, StatusPill } from "@/components/admin/ui";
import { InvoiceSheet } from "@/components/invoice/InvoiceSheet";
import { Alert, buttonClass, Field, Input } from "@/components/ui/form";
import { adminActor } from "@/lib/admin";
import { flash } from "@/lib/flash";
import { formatHundredths, formatMoney, isOverdue } from "@/lib/invoice-math";
import {
  deleteInvoice,
  duplicateInvoice,
  getInvoice,
  invoiceContext,
  invoiceDocument,
  invoiceReadiness,
  invoiceUrl,
  markInvoicePaid,
  payableOnline,
  renewPaymentLink,
  resendInvoice,
  sendInvoice,
  voidInvoice,
  type InvoiceRow,
} from "@/lib/invoices";
import { PostError } from "@/lib/posts";
import { RAZORPAY_DASHBOARD_PAYMENT } from "@/lib/razorpay";
import { requireRole } from "@/lib/session";
import { ActionButton } from "../ActionButton";
import { InvoiceForm } from "../InvoiceForm";
import { HiddenFromDemo, Readiness } from "../parts";

export const metadata = { title: "Invoice" };

const ok = (path: string, message: string) => `${path}?ok=${encodeURIComponent(message)}`;

/** Every button on this page. `op` says which; the result comes back as a message at the top of the page. */
async function act(form: FormData) {
  "use server";
  const actor = await adminActor();
  const id = String(form.get("id") ?? "");
  const op = String(form.get("op") ?? "");
  const here = `/admin/invoices/${id}`;

  // These two leave the page on success, so only their failure comes back here.
  if (op === "delete") {
    try {
      await deleteInvoice(actor, id);
    } catch (error) {
      await flash(here, async () => {
        throw error;
      });
    }
    redirect(ok("/admin/invoices", "Draft deleted."));
  }
  if (op === "duplicate") {
    let copy = "";
    try {
      copy = (await duplicateInvoice(actor, id)).id;
    } catch (error) {
      await flash(here, async () => {
        throw error;
      });
    }
    redirect(ok(`/admin/invoices/${copy}`, "Copied to a new draft. Check the dates and the lines, then send it."));
  }

  await flash(here, async () => {
    if (op === "send") {
      const r = await sendInvoice(actor, id);
      const what = `Invoice ${r.invoice.number}${r.online ? " with a Razorpay payment link" : ""}`;
      // The invoice is out; only the email is missing. Said as an error so it is not overlooked.
      if (!r.emailed) throw new PostError(`${what} is issued, but the email to ${r.invoice.clientEmail} could not be sent. Check Settings → Email and press “Email again”, or copy the client link and send it yourself.`);
      return `${what} was sent to ${r.invoice.clientEmail}.`;
    }
    if (op === "resend") {
      if (!(await resendInvoice(actor, id))) throw new PostError("The email could not be sent. Check Settings → Email.");
      return "Email sent.";
    }
    if (op === "paid") {
      const r = await markInvoicePaid(actor, id, form.get("note"));
      if (r.alreadyOnline) return "The client had already paid online, so it is recorded as a Razorpay payment.";
      return r.linkOpen ? "Marked paid. Razorpay is not connected, so cancel the payment link in the Razorpay dashboard yourself." : "Marked paid.";
    }
    if (op === "void") {
      await voidInvoice(actor, id);
      return "Invoice voided. The client's link now shows it as cancelled.";
    }
    if (op === "link") {
      await renewPaymentLink(actor, id);
      return "A new payment link is ready. The client's link shows the Pay button again.";
    }
    throw new PostError("Unknown action.");
  });
}

const formValues = (row: InvoiceRow) => ({
  clientName: row.clientName,
  clientEmail: row.clientEmail,
  clientCompany: row.clientCompany ?? "",
  clientAddress: row.clientAddress ?? "",
  clientTaxId: row.clientTaxId ?? "",
  currency: row.currency,
  issueDate: row.issueDate ?? "",
  dueDate: row.dueDate ?? "",
  taxLabel: row.taxLabel ?? "",
  taxRate: row.taxRateBp > 0 ? formatHundredths(row.taxRateBp) : "",
  notes: row.notes ?? "",
  items: row.items.map((it) => ({ description: it.description, quantity: formatHundredths(it.quantity), unitPrice: formatHundredths(it.unitPrice) })),
});

export default async function InvoicePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: FlashParams }) {
  const user = await requireRole("admin");
  if (user.demo) return <HiddenFromDemo />;
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const row = await getInvoice(id);
  if (!row) notFound();
  const [ctx, ready] = await Promise.all([invoiceContext(), invoiceReadiness()]);
  const amount = formatMoney(row.total, row.currency);
  const pdf = `/api/admin/invoices/${row.id}/pdf`;
  const back = <Link href="/admin/invoices" className={buttonClass("secondary")}>All invoices</Link>;

  if (row.status === "draft") {
    const canSend = ready.business && ready.storage && row.total > 0;
    return (
      <>
        <AdminHeader title={row.number ? `Draft ${row.number}` : "Draft invoice"} description={`${amount} · ${row.clientName} <${row.clientEmail}>`} actions={back} />
        <Flash ok={sp.ok} error={sp.error} />
        <Readiness ready={ready} />
        {row.number && (
          <div className="mb-6">
            <Alert tone="info">
              A send was started and did not finish, so this draft already has the number {row.number} and keeps it. It can be sent or voided, but not deleted: invoice numbers are never skipped.
            </Alert>
          </div>
        )}
        <Card className="mb-8">
          <h2 className="text-base font-semibold text-fg">Send to the client</h2>
          <p className="mt-1 text-sm text-fg-muted">
            Sending gives the invoice its number, stores the PDF{ready.online ? ", creates a Razorpay payment link" : ""} and emails {row.clientEmail} a link to view{ready.online ? ", pay" : ""} and
            download it. After that it cannot be edited.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            {canSend ? (
              <ActionButton action={act} fields={{ id: row.id, op: "send" }} variant="primary" confirm={`Send this invoice for ${amount} to ${row.clientEmail}?\n\nIt gets its number and cannot be edited afterwards.`}>
                Send invoice
              </ActionButton>
            ) : (
              <span className={buttonClass("primary")} aria-disabled="true" title="See “Before you send” above">
                Send invoice
              </span>
            )}
            <a href={pdf} target="_blank" rel="noopener" className={buttonClass("secondary")}>Preview PDF</a>
            <ActionButton action={act} fields={{ id: row.id, op: "duplicate" }}>Copy to a new draft</ActionButton>
            {row.number ? (
              <ActionButton action={act} fields={{ id: row.id, op: "void" }} variant="ghost" confirm={`Void ${row.number}? The number stays used and the invoice is kept as cancelled.`}>
                Void
              </ActionButton>
            ) : (
              <ActionButton action={act} fields={{ id: row.id, op: "delete" }} variant="ghost" confirm="Delete this draft? This cannot be undone.">
                Delete draft
              </ActionButton>
            )}
          </div>
        </Card>
        <h2 className="mb-4 text-lg font-semibold text-fg">Edit the draft</h2>
        <InvoiceForm id={row.id} initial={formValues(row)} />
      </>
    );
  }

  const link = invoiceUrl(row.token);
  const overdue = isOverdue(row.status, row.dueDate, ctx.today);
  const payable = payableOnline(row);
  return (
    <>
      <AdminHeader
        title={`Invoice ${row.number ?? ""}`}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <StatusPill status={overdue ? "overdue" : row.status} />
            <span>
              {amount} · {row.clientName} &lt;{row.clientEmail}&gt;
            </span>
          </span>
        }
        actions={
          <>
            <a href={pdf} className={buttonClass("primary")}>Download PDF</a>
            {back}
          </>
        }
      />
      <Flash ok={sp.ok} error={sp.error} />

      <div className="mb-8 grid gap-4 lg:grid-cols-2">
        <Card>
          <h2 className="text-base font-semibold text-fg">The client&apos;s link</h2>
          <p className="mt-1 text-sm text-fg-muted">
            Anyone with this link can view{row.status === "sent" && payable ? ", pay" : ""} and download the invoice without signing in. It was emailed to {row.clientEmail}
            {row.emailedAt ? (
              <>
                {" "}
                on <LocalTime iso={row.emailedAt.toISOString()} />.
              </>
            ) : (
              <strong className="text-fg"> — not yet: the email could not be sent.</strong>
            )}
          </p>
          <p className="mt-3 break-all rounded-lg bg-surface-sunken px-3 py-2 font-mono text-xs text-fg">{link}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <CopyLink url={link} className={buttonClass("secondary", "sm")} />
            <a href={link} target="_blank" rel="noopener" className={buttonClass("secondary", "sm")}>Open as the client</a>
            {(row.status === "sent" || row.status === "paid") && (
              <ActionButton action={act} fields={{ id: row.id, op: "resend" }} confirm={`Email ${row.clientEmail} the ${row.status === "paid" ? "receipt" : "invoice"} link again?`}>
                {row.status === "paid" ? "Email the receipt" : "Email again"}
              </ActionButton>
            )}
          </div>
        </Card>

        <Card>
          <h2 className="text-base font-semibold text-fg">Payment</h2>
          {row.status === "paid" && (
            <p className="mt-1 text-sm text-fg-muted">
              Paid on <LocalTime iso={row.paidAt?.toISOString()} />{" "}
              {row.paidVia === "razorpay" ? (
                <>
                  through Razorpay
                  {row.paymentId && (
                    <>
                      {" "}
                      (<a href={RAZORPAY_DASHBOARD_PAYMENT(row.paymentId)} target="_blank" rel="noopener" className="link break-all font-mono text-xs">{row.paymentId}</a>)
                    </>
                  )}
                  . Refunds are made in the Razorpay dashboard.
                </>
              ) : (
                <>, recorded by hand{row.paymentNote ? `: ${row.paymentNote}` : ""}.</>
              )}
            </p>
          )}
          {row.status === "void" && (
            <p className="mt-1 text-sm text-fg-muted">
              Voided on <LocalTime iso={row.voidedAt?.toISOString()} />. Nothing is due, and the payment link (if there was one) is cancelled.
            </p>
          )}
          {row.status === "sent" && (
            <>
              <p className="mt-1 text-sm text-fg-muted">
                {payable ? (
                  <>
                    The client can pay online: <a href={row.paymentLinkUrl ?? "#"} target="_blank" rel="noopener noreferrer" className="link break-all">{row.paymentLinkUrl}</a>. The invoice is marked paid on its own
                    when Razorpay confirms the payment.
                  </>
                ) : row.paymentLinkId ? (
                  <>The Razorpay payment link is {row.paymentLinkStatus ?? "closed"}, so the client has no Pay button.</>
                ) : (
                  <>This invoice has no online payment link. The client pays as your payment details say; mark it paid when the money arrives.</>
                )}
              </p>
              <div className="mt-4 space-y-3">
                {!payable && ready.razorpay && (
                  <ActionButton action={act} fields={{ id: row.id, op: "link" }} confirm="Create a new Razorpay payment link for this invoice?">
                    Create a payment link
                  </ActionButton>
                )}
                <ActionButton
                  action={act}
                  fields={{ id: row.id, op: "paid" }}
                  confirm={`Mark ${row.number} as paid?${payable ? "\n\nThe Razorpay payment link is cancelled first, so the client cannot pay twice." : ""}`}
                  extra={
                    <div className="min-w-0 flex-1 basis-56">
                      <Field label="Paid another way" htmlFor="inv-paid-note" optional hint="For example: bank transfer, reference 12345.">
                        <Input id="inv-paid-note" name="note" maxLength={200} autoComplete="off" />
                      </Field>
                    </div>
                  }
                >
                  Mark as paid
                </ActionButton>
              </div>
            </>
          )}
          <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
            <ActionButton action={act} fields={{ id: row.id, op: "duplicate" }}>Copy to a new draft</ActionButton>
            {row.status === "sent" && (
              <ActionButton action={act} fields={{ id: row.id, op: "void" }} variant="ghost" confirm={`Void ${row.number}?\n\nThe payment link is cancelled and the client's link shows the invoice as cancelled. This cannot be undone.`}>
                Void invoice
              </ActionButton>
            )}
          </div>
        </Card>
      </div>

      <InvoiceSheet doc={invoiceDocument(row, ctx)} />
    </>
  );
}
