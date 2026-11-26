import Link from "next/link";
import { Flash, type FlashParams } from "@/components/admin/Flash";
import { AdminHeader, Stat, StatusPill, Table, td, th } from "@/components/admin/ui";
import { buttonClass } from "@/components/ui/form";
import { formatDate, formatMoney, isOverdue } from "@/lib/invoice-math";
import { INVOICE_FILTERS, invoiceContext, invoiceReadiness, invoiceSummary, listInvoices, type InvoiceFilter } from "@/lib/invoices";
import { requireRole } from "@/lib/session";
import { settingsHref } from "@/lib/settings-areas";
import { HiddenFromDemo, Readiness } from "./parts";

export const metadata = { title: "Invoices" };

const FILTER_LABEL: Record<InvoiceFilter, string> = { all: "All", draft: "Drafts", unpaid: "Unpaid", overdue: "Overdue", paid: "Paid", void: "Void" };

const sums = (rows: { currency: string; total: number }[]) => (rows.length === 0 ? "0" : rows.map((r) => formatMoney(r.total, r.currency)).join(" + "));

export default async function InvoicesPage({ searchParams }: { searchParams: FlashParams }) {
  const user = await requireRole("admin");
  if (user.demo) return <HiddenFromDemo />;
  const sp = await searchParams;
  const filter = INVOICE_FILTERS.find((f) => f === sp.status) ?? "all";
  const { today } = await invoiceContext();
  const [rows, summary, ready] = await Promise.all([listInvoices(filter, today), invoiceSummary(today), invoiceReadiness()]);
  return (
    <>
      <AdminHeader
        title="Invoices"
        description="Send invoices to clients, take payment through a Razorpay link, and keep every invoice as a PDF in your storage."
        actions={
          <>
            <Link href={settingsHref("invoices")} className={buttonClass("secondary")}>Settings</Link>
            <Link href="/admin/invoices/new" className={buttonClass("primary")}>New invoice</Link>
          </>
        }
      />
      <Flash ok={sp.ok} error={sp.error} />
      <Readiness ready={ready} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Waiting for payment" value={summary.counts.sent} hint={sums(summary.outstanding)} />
        <Stat label="Overdue" value={summary.overdue} hint={summary.overdue > 0 ? "Past the due date and not paid" : "Nothing is late"} />
        <Stat label="Paid" value={summary.counts.paid} hint={sums(summary.paid)} />
        <Stat label="Drafts" value={summary.counts.draft} hint="Not sent yet" />
      </div>

      <nav aria-label="Filter invoices" className="my-6 flex flex-wrap gap-2">
        {INVOICE_FILTERS.map((f) => (
          <Link
            key={f}
            href={f === "all" ? "/admin/invoices" : `/admin/invoices?status=${f}`}
            aria-current={f === filter ? "page" : undefined}
            className={`rounded-full px-3 py-1 text-sm font-medium ${f === filter ? "bg-fg text-canvas" : "border border-line text-fg-muted hover:bg-surface-sunken"}`}
          >
            {FILTER_LABEL[f]}
          </Link>
        ))}
      </nav>

      {rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line-strong p-8 text-center text-sm text-fg-muted">
          {filter === "all" ? (
            <>
              No invoices yet. <Link href="/admin/invoices/new" className="link">Create the first one</Link>.
            </>
          ) : (
            "No invoices here."
          )}
        </p>
      ) : (
        <Table
          head={
            <tr>
              <th scope="col" className={th}>Number</th>
              <th scope="col" className={th}>Client</th>
              <th scope="col" className={th}>Issued</th>
              <th scope="col" className={th}>Due</th>
              <th scope="col" className={`${th} text-right`}>Total</th>
              <th scope="col" className={th}>Status</th>
            </tr>
          }
        >
          {rows.map((r) => (
            <tr key={r.id}>
              <td className={td}>
                <Link href={`/admin/invoices/${r.id}`} className="font-semibold text-fg underline-offset-2 hover:underline">
                  {r.number ?? "Draft"}
                </Link>
              </td>
              <td className={td}>
                <span className="block text-fg [overflow-wrap:anywhere]">{r.clientName}</span>
                {r.clientCompany && <span className="block [overflow-wrap:anywhere]">{r.clientCompany}</span>}
              </td>
              <td className={`${td} whitespace-nowrap`}>{formatDate(r.issueDate) || "—"}</td>
              <td className={`${td} whitespace-nowrap`}>{formatDate(r.dueDate) || "—"}</td>
              <td className={`${td} whitespace-nowrap text-right tabular-nums text-fg`}>{formatMoney(r.total, r.currency)}</td>
              <td className={td}>
                <StatusPill status={isOverdue(r.status, r.dueDate, today) ? "overdue" : r.status} />
              </td>
            </tr>
          ))}
        </Table>
      )}
      {rows.length === 300 && <p className="mt-3 text-sm text-fg-subtle">Showing the latest 300.</p>}
    </>
  );
}
