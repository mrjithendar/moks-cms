import Link from "next/link";
import { Readiness } from "@/app/admin/invoices/parts";
import { SectionHeading, SeeAlso } from "@/components/admin/SettingsParts";
import { Card } from "@/components/admin/ui";
import { Alert, Button, Field, Input, Select, Textarea } from "@/components/ui/form";
import { adminActor } from "@/lib/admin";
import { flash } from "@/lib/flash";
import { formatHundredths, INVOICE_CURRENCIES, invoiceNumber } from "@/lib/invoice-math";
import { invoiceContext, invoiceReadiness, saveInvoiceSettings } from "@/lib/invoices";
import { requireRole } from "@/lib/session";
import { settingsHref } from "@/lib/settings-areas";

const FIELDS = ["businessName", "businessAddress", "businessEmail", "taxIdLabel", "taxId", "currency", "taxLabel", "taxRate", "dueDays", "prefix", "footer", "onlinePayment"];

async function save(form: FormData) {
  "use server";
  const actor = await adminActor();
  await flash(settingsHref("invoices"), async () => {
    const raw: Record<string, unknown> = {};
    for (const k of FIELDS) if (form.has(k)) raw[k] = String(form.get(k) ?? "");
    await saveInvoiceSettings(actor, raw);
    return "Saved. New invoices use these details; invoices already sent keep the details they were sent with.";
  });
}

/** Settings → Payments & bookings → Invoices (its own page, /admin/invoices/settings, until 2026-11-26). */
export default async function InvoicesSection() {
  const user = await requireRole("admin");
  if (user.demo) return <Alert tone="info">Invoice settings hold your business details, so they are not shown to demo accounts.</Alert>;
  const [{ settings: s, today }, ready] = await Promise.all([invoiceContext(), invoiceReadiness()]);
  return (
    <section aria-labelledby="invoices-title" className="space-y-4">
      <SectionHeading id="invoices-title" title="Invoices" description="Who the invoices are from, and what a new invoice starts with. Invoices already sent keep the details they were sent with." />
      <Readiness ready={ready} />
      <form action={save} className="space-y-6">
        <Card>
          <fieldset className="grid gap-4 sm:grid-cols-2">
            <legend className="mb-3 text-base font-semibold text-fg sm:col-span-2">Your business</legend>
            <Field label="Business name" htmlFor="set-businessName" hint="Printed at the top of every invoice. Needed before an invoice can be sent.">
              <Input id="set-businessName" name="businessName" defaultValue={s.businessName} maxLength={120} autoComplete="organization" />
            </Field>
            <Field label="Business email" htmlFor="set-businessEmail" optional hint="Shown on the invoice and in the email as the address for questions.">
              <Input id="set-businessEmail" name="businessEmail" type="email" defaultValue={s.businessEmail} maxLength={200} autoComplete="off" />
            </Field>
            <div className="sm:col-span-2">
              <Field label="Business address" htmlFor="set-businessAddress" optional hint="One line per row, as it should appear on the invoice.">
                <Textarea id="set-businessAddress" name="businessAddress" defaultValue={s.businessAddress} rows={3} maxLength={600} />
              </Field>
            </div>
            <Field label="Tax ID label" htmlFor="set-taxIdLabel" optional hint="What your registration is called: GSTIN, GST Reg. No., VAT, UEN.">
              <Input id="set-taxIdLabel" name="taxIdLabel" defaultValue={s.taxIdLabel} maxLength={30} autoComplete="off" />
            </Field>
            <Field label="Tax ID" htmlFor="set-taxId" optional hint="Your registration number, printed under the address.">
              <Input id="set-taxId" name="taxId" defaultValue={s.taxId} maxLength={60} autoComplete="off" />
            </Field>
          </fieldset>
        </Card>

        <Card>
          <fieldset className="grid gap-4 sm:grid-cols-2">
            <legend className="mb-3 text-base font-semibold text-fg sm:col-span-2">Defaults for a new invoice</legend>
            <Field label="Default currency" htmlFor="set-currency" hint="Each invoice can use another one. Razorpay needs international payments switched on for anything but INR.">
              <Select id="set-currency" name="currency" defaultValue={s.currency}>
                {INVOICE_CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Payment due (days)" htmlFor="set-dueDays" hint="The due date of a new invoice is this many days after its date.">
              <Input id="set-dueDays" name="dueDays" type="number" inputMode="numeric" min={0} max={365} defaultValue={s.dueDays} />
            </Field>
            <Field label="Default tax label" htmlFor="set-taxLabel" optional hint="GST, VAT, IGST.">
              <Input id="set-taxLabel" name="taxLabel" defaultValue={s.taxLabel} maxLength={30} autoComplete="off" />
            </Field>
            <Field label="Default tax rate (%)" htmlFor="set-taxRate" optional hint="Added on top of the lines. Leave empty if you do not charge tax.">
              <Input id="set-taxRate" name="taxRate" inputMode="decimal" defaultValue={s.taxRateBp > 0 ? formatHundredths(s.taxRateBp) : ""} placeholder="0" autoComplete="off" />
            </Field>
            <Field
              label="Number prefix"
              htmlFor="set-prefix"
              hint={`Letters and digits. The next invoice would be numbered like ${invoiceNumber(s.prefix, Number(today.slice(0, 4)), 1)}; numbers start again at 0001 each year and are never reused.`}
            >
              <Input id="set-prefix" name="prefix" defaultValue={s.prefix} maxLength={10} autoComplete="off" />
            </Field>
            <div className="sm:col-span-2">
              <Field label="Payment details and terms" htmlFor="set-footer" optional hint="Printed at the end of every invoice: bank account for transfers, late-payment terms.">
                <Textarea id="set-footer" name="footer" defaultValue={s.footer} rows={4} maxLength={1500} />
              </Field>
            </div>
          </fieldset>
        </Card>

        <Card>
          <h2 className="text-base font-semibold text-fg">Online payment</h2>
          <label className="mt-3 flex items-start gap-3 text-sm text-fg">
            <input type="checkbox" name="onlinePayment" defaultChecked={s.onlinePayment} className="mt-1 h-4 w-4 accent-[var(--accent)]" />
            <span>
              <span className="font-medium">Add a Razorpay payment link to every invoice</span>
              <span className="block text-fg-muted">
                The client gets a Pay button and the invoice is marked paid when Razorpay confirms the payment. Uses the keys in{" "}
                <Link href={settingsHref("razorpay")} className="link">Settings → Payments &amp; bookings → Razorpay</Link>. Switch it off to send invoices that are paid by bank transfer only.
              </span>
            </span>
          </label>
        </Card>

        <Button type="submit">Save settings</Button>
      </form>
      <SeeAlso href="/admin/invoices">Billing → Invoices: write and send invoices</SeeAlso>
    </section>
  );
}
