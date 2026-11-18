"use client";

import { startTransition, useActionState, useState, type FormEvent } from "react";
import { PlusIcon, TrashIcon } from "@/components/icons";
import { Alert, Button, Field, Input, Select, Textarea } from "@/components/ui/form";
import { formatAmount, formatMoney, INVOICE_CURRENCIES, invoiceTotals, MAX_ITEMS, MAX_TAX_RATE_BP, parseHundredths } from "@/lib/invoice-math";
import { saveInvoiceAction, type InvoiceFormState } from "./actions";

/** The form's values as text, exactly as they are typed and posted. */
export type InvoiceFormValues = {
  clientName: string;
  clientEmail: string;
  clientCompany: string;
  clientAddress: string;
  clientTaxId: string;
  currency: string;
  issueDate: string;
  dueDate: string;
  taxLabel: string;
  taxRate: string;
  notes: string;
  items: { description: string; quantity: string; unitPrice: string }[];
};

type Row = { key: number; description: string; quantity: string; unitPrice: string };

const EMPTY = { description: "", quantity: "1", unitPrice: "" };

/**
 * Admin → Invoices: the draft form. The lines and the tax rate are kept in state so the totals update while typing;
 * they are worked out again on the server with the same arithmetic (lib/invoice-math.ts), which is what is saved.
 */
export function InvoiceForm({ id, initial }: { id?: string; initial: InvoiceFormValues }) {
  const [state, save, saving] = useActionState<InvoiceFormState, FormData>(saveInvoiceAction, {});
  const [rows, setRows] = useState<Row[]>(() => (initial.items.length > 0 ? initial.items : [EMPTY]).map((r, i) => ({ key: i, ...r })));
  const [nextKey, setNextKey] = useState(() => Math.max(1, initial.items.length));
  const [currency, setCurrency] = useState(initial.currency);
  const [taxRate, setTaxRate] = useState(initial.taxRate);
  const [taxLabel, setTaxLabel] = useState(initial.taxLabel);

  const change = (key: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const add = () => {
    setRows((rs) => [...rs, { key: nextKey, ...EMPTY }]);
    setNextKey((k) => k + 1);
  };
  const remove = (key: number) => setRows((rs) => (rs.length > 1 ? rs.filter((r) => r.key !== key) : rs));

  // What cannot be read as a number counts as zero here; the server says which field is wrong when the form is saved.
  const rate = parseHundredths(taxRate.trim() === "" ? "0" : taxRate);
  const rateBp = rate !== null && rate <= MAX_TAX_RATE_BP ? rate : 0;
  const totals = invoiceTotals(rows.map((r) => ({ quantity: parseHundredths(r.quantity.trim() === "" ? "1" : r.quantity) ?? 0, unitPrice: parseHundredths(r.unitPrice) ?? 0 })), rateBp);

  // Submit without React's automatic form reset: a validation error must keep what was typed.
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    startTransition(() => save(data));
  };

  return (
    <form onSubmit={submit} className="space-y-8" noValidate>
      {id && <input type="hidden" name="id" value={id} />}
      {state.error && (
        <Alert>
          <p className="font-semibold">{state.error}</p>
          {state.issues && state.issues.length > 0 && (
            <ul className="mt-1 list-disc pl-5">
              {state.issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          )}
        </Alert>
      )}

      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-3 text-base font-semibold text-fg sm:col-span-2">Client</legend>
        <Field label="Client name" htmlFor="inv-clientName" hint="The person the invoice is addressed to.">
          <Input id="inv-clientName" name="clientName" defaultValue={initial.clientName} maxLength={120} required autoComplete="off" />
        </Field>
        <Field label="Client email" htmlFor="inv-clientEmail" hint="The invoice link is sent here.">
          <Input id="inv-clientEmail" name="clientEmail" type="email" defaultValue={initial.clientEmail} maxLength={200} required autoComplete="off" />
        </Field>
        <Field label="Company" htmlFor="inv-clientCompany" optional>
          <Input id="inv-clientCompany" name="clientCompany" defaultValue={initial.clientCompany} maxLength={120} autoComplete="off" />
        </Field>
        <Field label="Client tax ID" htmlFor="inv-clientTaxId" optional hint="Their GST or VAT number, if it must be on the invoice.">
          <Input id="inv-clientTaxId" name="clientTaxId" defaultValue={initial.clientTaxId} maxLength={60} autoComplete="off" />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Billing address" htmlFor="inv-clientAddress" optional>
            <Textarea id="inv-clientAddress" name="clientAddress" defaultValue={initial.clientAddress} rows={3} maxLength={600} />
          </Field>
        </div>
      </fieldset>

      <fieldset className="grid gap-4 sm:grid-cols-3">
        <legend className="mb-3 text-base font-semibold text-fg sm:col-span-3">Invoice</legend>
        <Field label="Currency" htmlFor="inv-currency">
          <Select id="inv-currency" name="currency" value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {INVOICE_CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Invoice date" htmlFor="inv-issueDate">
          <Input id="inv-issueDate" name="issueDate" type="date" defaultValue={initial.issueDate} required />
        </Field>
        <Field label="Due date" htmlFor="inv-dueDate" hint="Leave empty to use your usual payment terms.">
          <Input id="inv-dueDate" name="dueDate" type="date" defaultValue={initial.dueDate} />
        </Field>
      </fieldset>

      <fieldset>
        <legend className="mb-3 text-base font-semibold text-fg">Lines</legend>
        <div className="space-y-3">
          {rows.map((r, i) => {
            const amount = totals.lines[i] ?? 0;
            return (
              <div key={r.key} className="grid gap-3 rounded-xl border border-line bg-surface p-3 sm:grid-cols-[minmax(0,1fr)_6rem_9rem_8rem_auto] sm:items-end">
                <Field label="Description" htmlFor={`inv-desc-${r.key}`}>
                  <Input id={`inv-desc-${r.key}`} name="itemDescription" value={r.description} onChange={(e) => change(r.key, { description: e.target.value })} maxLength={500} autoComplete="off" />
                </Field>
                <Field label="Quantity" htmlFor={`inv-qty-${r.key}`}>
                  <Input id={`inv-qty-${r.key}`} name="itemQuantity" inputMode="decimal" value={r.quantity} onChange={(e) => change(r.key, { quantity: e.target.value })} autoComplete="off" />
                </Field>
                <Field label="Unit price" htmlFor={`inv-price-${r.key}`}>
                  <Input id={`inv-price-${r.key}`} name="itemUnitPrice" inputMode="decimal" value={r.unitPrice} onChange={(e) => change(r.key, { unitPrice: e.target.value })} placeholder="0.00" autoComplete="off" />
                </Field>
                <div className="space-y-1.5">
                  <p className="text-sm font-medium text-fg">Amount</p>
                  <p className="flex min-h-11 items-center justify-end text-sm font-medium tabular-nums text-fg" aria-live="polite">
                    {formatAmount(amount)}
                  </p>
                </div>
                <Button type="button" variant="ghost" onClick={() => remove(r.key)} disabled={rows.length === 1} aria-label={`Remove line ${i + 1}`} title="Remove this line">
                  <TrashIcon className="h-4 w-4" />
                </Button>
              </div>
            );
          })}
        </div>
        <div className="mt-3">
          <Button type="button" variant="secondary" size="sm" onClick={add} disabled={rows.length >= MAX_ITEMS}>
            <PlusIcon className="h-4 w-4" />
            Add a line
          </Button>
        </div>
      </fieldset>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <fieldset className="grid content-start gap-4 sm:grid-cols-2">
          <legend className="mb-3 text-base font-semibold text-fg sm:col-span-2">Tax and notes</legend>
          <Field label="Tax label" htmlFor="inv-taxLabel" optional hint="As it should read on the invoice: GST, VAT, IGST.">
            <Input id="inv-taxLabel" name="taxLabel" value={taxLabel} onChange={(e) => setTaxLabel(e.target.value)} maxLength={30} autoComplete="off" />
          </Field>
          <Field label="Tax rate (%)" htmlFor="inv-taxRate" optional hint="Added on top of the lines. Leave empty for no tax.">
            <Input id="inv-taxRate" name="taxRate" inputMode="decimal" value={taxRate} onChange={(e) => setTaxRate(e.target.value)} placeholder="0" autoComplete="off" />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Notes for the client" htmlFor="inv-notes" optional hint="Shown on the invoice: a purchase order number, the period covered, a thank-you.">
              <Textarea id="inv-notes" name="notes" defaultValue={initial.notes} rows={3} maxLength={2000} />
            </Field>
          </div>
        </fieldset>

        <dl className="h-fit rounded-xl border border-line bg-surface p-5 text-sm" aria-live="polite">
          <div className="flex items-baseline justify-between gap-4 py-1">
            <dt className="text-fg-muted">Subtotal</dt>
            <dd className="tabular-nums text-fg">{formatAmount(totals.subtotal)}</dd>
          </div>
          {rateBp > 0 && (
            <div className="flex items-baseline justify-between gap-4 py-1">
              <dt className="text-fg-muted">
                {taxLabel.trim() || "Tax"} ({taxRate.trim()}%)
              </dt>
              <dd className="tabular-nums text-fg">{formatAmount(totals.taxAmount)}</dd>
            </div>
          )}
          <div className="mt-2 flex items-baseline justify-between gap-4 border-t border-line-strong pt-3 text-base font-semibold text-fg">
            <dt>Total</dt>
            <dd className="tabular-nums">{formatMoney(totals.total, currency)}</dd>
          </div>
        </dl>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-6">
        <Button type="submit" loading={saving}>
          Save draft
        </Button>
        <p className="text-sm text-fg-subtle">Nothing is sent to the client until you press Send on the next page.</p>
      </div>
    </form>
  );
}
