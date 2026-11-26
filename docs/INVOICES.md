# Invoices: send a bill, take payment through Razorpay, keep the PDF in R2

Status: implemented 2026-11-15 (owner request). Live Razorpay and R2 checks **require manual configuration** (see the
end): this was written and tested without a Razorpay account or a bucket.

Admin → Invoices lets an admin write an invoice, send it to a client by email, and get paid through a Razorpay payment
link. Every invoice that has been sent has a PDF in R2 that the admin and the client can download.

## How it works

```
draft ──Send──▶ sent ──▶ paid        Razorpay webhook · client returns from Razorpay · admin "Mark as paid"
  │               │
  └────Void───────┴──▶ void          cancels the payment link; the number stays used
```

| Step | What happens | Code |
|---|---|---|
| Draft | Client, lines (description, quantity, unit price), tax label and rate, dates, notes. Totals are worked out on the server. Editable and deletable. | `createInvoice`, `updateInvoice` in `src/lib/invoices.ts` |
| Send | 1. the next number is given (`INV-2026-0007`); 2. the PDF is rendered and stored in R2; 3. a Razorpay payment link is created for exactly the total; 4. the invoice becomes `sent`; 5. the client is emailed their link. Steps 1–4 either all happen or leave a draft (which keeps its number); the email is last and can be sent again. | `sendInvoice` |
| Client page | `/invoice/<token>`: the invoice, a **Pay** button (the Razorpay link), **Download PDF** and Print. No sign-in: the token is the credential. | `src/app/invoice/[token]/` |
| Paid | Recorded once, by whichever comes first: the webhook (`payment_link.paid`), the signed address Razorpay sends the client back to, or an admin marking a bank transfer. The PDF is rendered again as PAID; the client gets a thank-you email and the admins a notice (online payments). | `handlePaymentLinkEvent`, `confirmInvoiceReturn`, `markInvoicePaid` |
| Void | The payment link is cancelled, the invoice is kept as void and the PDF says so. A paid invoice cannot be voided (refunds are made in Razorpay). | `voidInvoice` |

A sent invoice cannot be edited. To correct one: **Copy to a new draft**, send the copy, void the original.

## Rules worth knowing

- **Money is integers.** Amounts are stored in the currency's smallest unit, quantities in hundredths, tax rates in
  basis points; rounding is half up, per line and for the tax (`src/lib/invoice-math.ts`). The browser shows live
  totals with the same functions, and the server works them out again from what was posted.
- **Currencies:** INR, USD, SGD, EUR, GBP, AUD, CAD, AED (all two-decimal). Amounts are written with the ISO code
  (`USD 1,500.00`) everywhere, because the PDF's built-in fonts have no ₹.
- **Tax:** one tax line (label and rate) added on top of the lines. No tax-inclusive prices, no split CGST/SGST, no
  discounts, no credit notes, no partial payments.
- **Numbers:** `PREFIX-YEAR-0001`, one sequence per prefix and year (`invoice_counter`), given when an invoice is first
  sent. A number is never reused and never skipped: a failed send keeps its number for the next try, and anything with
  a number is voided, not deleted.
- **The seller's details are frozen at send.** Changing Invoices → Settings later does not rewrite a sent invoice.
- **Online payment is optional.** With Razorpay not connected, or "Add a Razorpay payment link" switched off, the
  invoice goes out without a Pay button and is marked paid by hand. A link can be added later (**Create a payment
  link**), also after one expired.
- **No double payment.** Marking paid by hand or voiding cancels the payment link first; if Razorpay answers that the
  link was just paid, the invoice is recorded as that online payment instead.
- **Razorpay stays quiet.** Links are created with `notify` and `reminder_enable` off: the site sends the invoice
  email, and Razorpay does not email or text the link or reminders. (A payment receipt from Razorpay, if your account
  sends one, is separate.)

## The PDF

`src/lib/invoice-pdf.ts` writes the PDF by hand (no PDF library is installed): A4, Helvetica and Helvetica-Bold, as
many pages as the lines need, with the client's link clickable. Characters the built-in fonts lack are written without
their accent or as `?`. The client's page (`InvoiceSheet`) and the PDF are made from the same `invoiceDocument()`, so
they always say the same thing.

Stored at `jithendar/www/invoices/{year}/{invoice id}/{random uuid}.pdf` with `Cache-Control: private, no-store`. A
new object is written (and the old one deleted) when the invoice is paid or voided, or when a payment link is added.
Downloads (`/api/admin/invoices/{id}/pdf` for admins, `/invoice/{token}/pdf` for the client) serve that object through
the site; if it is missing or out of date it is rendered and stored again, and if storage is down the PDF is rendered
on the spot so the client still gets it. A draft's "Preview PDF" is rendered on the spot and never stored.

## Privacy and security

- The client link is 32 random bytes. It is the only thing that opens an invoice without signing in; drafts have no
  public address. Pages and PDFs under `/invoice/` are `private, no-store` and `noindex` (`src/proxy.ts`,
  `next.config.ts`), the token is removed from access and error logs (`loggedPath`), and the path stays reachable in
  maintenance mode.
- The object name in R2 contains a random UUID, so it cannot be guessed even when the bucket has a public domain
  (`R2_PUBLIC_BASE_URL`).
- Admins only. Demo accounts see a notice instead of invoices, and cannot download PDFs.
- Webhook deliveries are verified with the webhook secret; the amount and currency in a `payment_link.paid` event
  must equal the invoice's. The return address is verified with the key secret (HMAC-SHA256 of
  `payment_link_id|reference_id|status|payment_id`) and must be for the invoice's current link.
- The audit log records create, update, send, resend, paid (by hand), void, new link, settings and downloads, without
  the client's name, email or address.
- Invoices are **not** part of the content backup (Admin → Backups); they are in the database and the PDFs are in R2.

## Files

| Concern | File |
|---|---|
| Arithmetic and formatting (shared with the browser) | `src/lib/invoice-math.ts` |
| PDF | `src/lib/invoice-pdf.ts` |
| Drafts, sending, payment links, paid/void, settings | `src/lib/invoices.ts` |
| Webhook branch, return-address signature | `src/lib/razorpay.ts` |
| Admin pages | `src/app/admin/invoices/` (list, new, `[id]`, settings) |
| Client page and PDF | `src/app/invoice/[token]/`, `src/components/invoice/InvoiceSheet.tsx` |
| Admin PDF | `src/app/api/admin/invoices/[id]/pdf/route.ts` |
| Tables | `invoice`, `invoice_counter`: migration `0032_invoices.sql`, rollback in `src/db/rollback/` |
| Tests | `tests/invoices.test.ts`, `tests/invoice-pdf.test.ts` |

## Requires manual configuration

1. **Invoices → Settings:** business name (required to send), address, tax ID, default currency, tax and payment
   terms, payment details.
2. **Storage** must be connected and verified (Admin → Settings → Media & storage): sending is refused without it.
3. **Email** must be working (same page), or the invoice is issued but the client is not told; the invoice page then
   says so and offers "Email again" and the link to copy.
4. **Razorpay:** the same keys as paid calls (Payments → Razorpay payments). On the existing webhook
   (`https://jithendar.com/api/razorpay/webhook`) also switch on **payment_link.paid**, **payment_link.cancelled** and
   **payment_link.expired**. Without the webhook a payment is still recorded when the client returns to the invoice
   page after paying, but not if they close the tab first. Currencies other than INR need International payments
   enabled on the Razorpay account. Razorpay's test mode allows a limited number of payment links.
5. Try it end to end with `rzp_test_` keys before sending a real invoice: send one to yourself, pay with a test card,
   check that it turns paid and that both PDFs download.
