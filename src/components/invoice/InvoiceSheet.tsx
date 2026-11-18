import type { InvoicePdfInput } from "@/lib/invoice-pdf";

/** Hides the site's (and the admin's) chrome when an invoice page is printed. No <header>/<footer> below: this hides them. */
export const INVOICE_PRINT_CSS =
  "@media print { [data-admin-shell] > aside, header, footer, .announcement, [data-demo-banner], [data-invoice-actions] { display: none !important; } [data-admin-shell] { display: block !important; background: white; } [data-invoice-sheet] { border: 0 !important; padding: 0 !important; box-shadow: none !important; } }";

const TONE: Record<InvoicePdfInput["status"], string> = {
  draft: "text-fg",
  sent: "text-fg",
  paid: "text-emerald-700 dark:text-emerald-400",
  void: "text-red-700 dark:text-red-400",
};

/**
 * The invoice as a page: the same words and numbers as the PDF (both are made from lib/invoices.ts invoiceDocument),
 * for the client's link and the admin's view of a sent invoice.
 */
export function InvoiceSheet({ doc }: { doc: InvoicePdfInput }) {
  return (
    <article data-invoice-sheet className="rounded-xl border border-line bg-surface p-6 text-fg shadow-xs sm:p-10">
      <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-lg font-semibold [overflow-wrap:anywhere]">{doc.seller.name}</p>
          {doc.seller.lines.map((line, i) => (
            <p key={i} className="text-sm text-fg-muted [overflow-wrap:anywhere]">{line}</p>
          ))}
        </div>
        <div className="shrink-0 sm:text-right">
          <h1 className="text-2xl font-semibold tracking-tight">{doc.status === "draft" ? "Draft invoice" : "Invoice"}</h1>
          <dl className="mt-2 grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5 text-sm sm:justify-end">
            <dt className="text-fg-muted">Invoice no.</dt>
            <dd className="font-medium tabular-nums sm:text-right">{doc.number}</dd>
            {doc.issueDate && (
              <>
                <dt className="text-fg-muted">Issued</dt>
                <dd className="sm:text-right">{doc.issueDate}</dd>
              </>
            )}
            {doc.dueDate && (
              <>
                <dt className="text-fg-muted">Due</dt>
                <dd className="sm:text-right">{doc.dueDate}</dd>
              </>
            )}
          </dl>
        </div>
      </div>

      <div className="mt-8 flex flex-col gap-6 border-t border-line pt-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">Bill to</h2>
          <p className="mt-1.5 font-semibold [overflow-wrap:anywhere]">{doc.client.name}</p>
          {doc.client.lines.map((line, i) => (
            <p key={i} className="text-sm text-fg-muted [overflow-wrap:anywhere]">{line}</p>
          ))}
        </div>
        <div className="shrink-0 sm:text-right">
          <p className={`text-xs font-semibold uppercase tracking-wide ${doc.status === "paid" || doc.status === "void" ? TONE[doc.status] : "text-fg-subtle"}`}>{doc.summary.label}</p>
          <p className={`mt-1 text-2xl font-semibold tabular-nums ${TONE[doc.status]}`}>{doc.summary.value}</p>
          {doc.summary.note && <p className="mt-0.5 text-sm text-fg-muted [overflow-wrap:anywhere]">{doc.summary.note}</p>}
        </div>
      </div>

      <div className="mt-8 overflow-x-auto" tabIndex={0} role="region" aria-label="Invoice lines (scrolls sideways)">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="bg-surface-muted text-xs font-semibold uppercase tracking-wide text-fg-subtle">
              <th scope="col" className="px-3 py-2.5 text-left">Description</th>
              <th scope="col" className="px-3 py-2.5 text-right">Qty</th>
              <th scope="col" className="whitespace-nowrap px-3 py-2.5 text-right">Unit price</th>
              <th scope="col" className="px-3 py-2.5 text-right">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line border-b border-line">
            {doc.items.map((item, i) => (
              <tr key={i}>
                <td className="whitespace-pre-line px-3 py-3 align-top min-w-48 [overflow-wrap:anywhere]">{item.description}</td>
                <td className="px-3 py-3 text-right align-top tabular-nums">{item.quantity}</td>
                <td className="px-3 py-3 text-right align-top tabular-nums">{item.unitPrice}</td>
                <td className="px-3 py-3 text-right align-top tabular-nums">{item.amount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <dl className="ml-auto mt-4 w-full max-w-xs text-sm">
        {doc.totals.map((row, i) => (
          <div key={i} className={`flex items-baseline justify-between gap-6 px-3 py-1.5 ${row.strong ? "mt-1 border-t border-fg pt-2.5 text-base font-semibold" : ""}`}>
            <dt className={row.strong ? "" : "text-fg-muted"}>{row.label}</dt>
            <dd className="tabular-nums">{row.value}</dd>
          </div>
        ))}
      </dl>

      {doc.notes && (
        <section className="mt-8">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">Notes</h2>
          <p className="mt-1.5 whitespace-pre-line text-sm [overflow-wrap:anywhere]">{doc.notes}</p>
        </section>
      )}
      {doc.footer && (
        <section className="mt-6">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">Payment details and terms</h2>
          <p className="mt-1.5 whitespace-pre-line text-sm [overflow-wrap:anywhere]">{doc.footer}</p>
        </section>
      )}
    </article>
  );
}
