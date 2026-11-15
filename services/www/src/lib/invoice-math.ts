/**
 * Invoice arithmetic and formatting, shared by the server (lib/invoices.ts), the admin form (live totals) and the PDF
 * (lib/invoice-pdf.ts). No imports and no floating-point money: every amount is an integer in the currency's smallest
 * unit (cents, paise), quantities are in hundredths (1.5 hours = 150) and tax rates in basis points (9% = 900).
 */

/** Two-decimal currencies only: the arithmetic and Razorpay's "smallest unit" both assume 1/100. */
export const INVOICE_CURRENCIES = ["INR", "USD", "SGD", "EUR", "GBP", "AUD", "CAD", "AED"] as const;
export type InvoiceCurrency = (typeof INVOICE_CURRENCIES)[number];

export const INVOICE_STATUSES = ["draft", "sent", "paid", "void"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/** One line: `amount` is quantity × unitPrice, rounded half up, stored so the invoice never changes afterwards. */
export type InvoiceItem = { description: string; quantity: number; unitPrice: number; amount: number };

/** The business details as they were when the invoice was sent (later changes to the settings do not rewrite it). */
export type InvoiceSeller = { name: string; address: string; email: string; taxIdLabel: string; taxId: string; footer: string };

export const MAX_ITEMS = 50;
/** 10,000,000.00: fits the integer columns and stays far below Number.MAX_SAFE_INTEGER. */
export const MAX_TOTAL = 1_000_000_000;
/** 100,000.00 units. */
export const MAX_QUANTITY = 10_000_000;
export const MAX_UNIT_PRICE = 1_000_000_000;
/** 100%. */
export const MAX_TAX_RATE_BP = 10_000;

/**
 * "1,500.50" → 150050. Null when the text is not a plain non-negative number with at most two decimals. Also used for
 * quantities ("1.5" → 150 hundredths) and tax rates ("8.25" → 825 basis points): all three are "times one hundred".
 */
export function parseHundredths(text: string): number | null {
  const t = text.replace(/[\s,]/g, "");
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(t)) return null;
  const [whole = "0", frac = ""] = t.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

/** quantity (hundredths) × unit price (smallest unit), rounded half up to the smallest unit. */
export function lineAmount(quantity: number, unitPrice: number): number {
  return Number((BigInt(quantity) * BigInt(unitPrice) + BigInt(50)) / BigInt(100));
}

/** Tax on the subtotal at a rate in basis points, rounded half up. */
export function taxOn(subtotal: number, rateBp: number): number {
  return Number((BigInt(subtotal) * BigInt(rateBp) + BigInt(5000)) / BigInt(10_000));
}

export type InvoiceTotals = { lines: number[]; subtotal: number; taxAmount: number; total: number };

export function invoiceTotals(items: { quantity: number; unitPrice: number }[], taxRateBp: number): InvoiceTotals {
  const lines = items.map((i) => lineAmount(i.quantity, i.unitPrice));
  const subtotal = lines.reduce((a, b) => a + b, 0);
  const taxAmount = taxOn(subtotal, taxRateBp);
  return { lines, subtotal, taxAmount, total: subtotal + taxAmount };
}

/** 150050 → "1,500.50": always two decimals, thousands grouped. */
export function formatAmount(minor: number): string {
  const abs = Math.abs(Math.trunc(minor));
  const whole = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${minor < 0 ? "-" : ""}${whole}.${String(abs % 100).padStart(2, "0")}`;
}

/** "USD 1,500.50": the ISO code, so the PDF (whose built-in fonts have no ₹), the email and the page all agree. */
export const formatMoney = (minor: number, currency: string): string => `${currency} ${formatAmount(minor)}`;

/** Hundredths without trailing zeros: 100 → "1", 150 → "1.5", 125 → "1.25". Used for quantities and form values. */
export function formatHundredths(value: number): string {
  const abs = Math.abs(Math.trunc(value));
  const frac = String(abs % 100).padStart(2, "0").replace(/0+$/, "");
  return `${value < 0 ? "-" : ""}${Math.floor(abs / 100)}${frac ? `.${frac}` : ""}`;
}

/** 900 → "9%", 825 → "8.25%". */
export const formatRate = (bp: number): string => `${formatHundredths(bp)}%`;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A real calendar date written YYYY-MM-DD. */
export function isIsoDate(text: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/** "2026-11-05" → "5 Nov 2026" (unambiguous in every country); anything else is returned as it is. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso || !isIsoDate(iso)) return iso ?? "";
  const [y = "", m = "1", d = "1"] = iso.split("-");
  return `${Number(d)} ${MONTHS[Number(m) - 1] ?? ""} ${y}`;
}

export function addDays(iso: string, days: number): string {
  const [y = "1970", m = "1", d = "1"] = iso.split("-");
  return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d) + days)).toISOString().slice(0, 10);
}

/** Today's date (YYYY-MM-DD) on the wall clock of `timeZone`; UTC when the zone is unknown. */
export function todayIn(timeZone: string | undefined, now: Date = new Date()): string {
  try {
    // en-CA formats dates as YYYY-MM-DD.
    return new Intl.DateTimeFormat("en-CA", { timeZone: timeZone || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** Sent, not paid, and the due date has passed. */
export const isOverdue = (status: string, dueDate: string | null | undefined, today: string): boolean => status === "sent" && !!dueDate && dueDate < today;

/** "INV-2026-0007": four digits, growing past them when a year has more than 9,999 invoices. */
export const invoiceNumber = (prefix: string, year: number, sequence: number): string => `${prefix}-${year}-${String(sequence).padStart(4, "0")}`;

/** The counter an invoice number comes from: one sequence per prefix and year. */
export const invoiceSeries = (prefix: string, year: number): string => `${prefix}-${year}`;
