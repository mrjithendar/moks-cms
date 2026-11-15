import "server-only";
import { randomBytes, randomUUID } from "node:crypto";
import { and, count, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { absoluteUrl } from "@/config/site";
import { audit } from "./audit";
import {
  addDays,
  formatAmount,
  formatDate,
  formatHundredths,
  formatMoney,
  formatRate,
  INVOICE_CURRENCIES,
  INVOICE_STATUSES,
  invoiceNumber,
  invoiceSeries,
  invoiceTotals,
  isIsoDate,
  isOverdue,
  MAX_ITEMS,
  MAX_QUANTITY,
  MAX_TAX_RATE_BP,
  MAX_TOTAL,
  MAX_UNIT_PRICE,
  parseHundredths,
  todayIn,
  type InvoiceCurrency,
  type InvoiceItem,
  type InvoiceSeller,
  type InvoiceStatus,
} from "./invoice-math";
import { renderInvoicePdf, type InvoicePdfInput } from "./invoice-pdf";
import { log } from "./log";
import { sendMail } from "./mail";
import type { Actor } from "./posts";
import { PostError } from "./posts";
import { MIN_AMOUNT, paymentLinkSignatureValid, razorpayKeys } from "./razorpay";
import { effectiveEnv } from "./runtime-settings";
import { getPublishedConfig } from "./site-config/store";
import { deleteObject, getObjectBytes, putObject, storageReady } from "./storage";

/**
 * Invoices: Admin → Invoices (docs/INVOICES.md).
 *
 * draft ──send──▶ sent ──▶ paid          A draft can be edited and deleted. Sending gives it the next number, stores
 *   │               │                    the PDF in R2, creates a Razorpay payment link (when Razorpay is connected
 *   └────void───────┴──▶ void            and online payment is on) and emails the client their link, /invoice/<token>.
 *
 * - Numbers ("INV-2026-0007") come from invoice_counter, one sequence per prefix and year. A number is given once and
 *   stays with the invoice: a failed send keeps it for the next try, and a numbered invoice is voided, never deleted,
 *   so the sequence has no gaps.
 * - Paid is recorded once, by whichever arrives first: Razorpay's webhook (payment_link.paid), the client coming
 *   back from Razorpay with a signed address, or an admin marking a bank transfer. An invoice that is sent cannot be
 *   edited; to change it, void it and send a new one.
 * - Every invoice that has left draft has a PDF in R2 under INVOICE_ROOT, rendered again when it is paid or voided.
 *   The object name contains a random UUID, so it cannot be guessed even if the bucket has a public domain.
 * - Nothing here holds a database transaction open across a network call (Razorpay, R2, email).
 */

export const INVOICE_ROOT = "jithendar/www/invoices";
const API = "https://api.razorpay.com/v1";
const SETTINGS_KEY = "invoices";
const MAX_PDF_BYTES = 5 * 1024 * 1024;
const PRIVATE = "private, no-store";

type Fetch = typeof fetch;
export type InvoiceRow = typeof schema.invoice.$inferSelect;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const EMAIL = /^[^\s@<>,;:"]+@[^\s@<>,;:"]+\.[^\s@<>,;:"]{2,}$/;

function adminOnly(actor: Actor) {
  if (actor.role !== "admin") throw new PostError("Only admins can manage invoices.", 403);
}

/** One line of plain text: control characters (and line breaks) become spaces. */
const oneLine = (v: unknown) => (typeof v === "string" ? v : "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
/** Several lines of plain text: line breaks kept, other control characters removed. */
const manyLines = (v: unknown) => (typeof v === "string" ? v : "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "").trim();

export const invoiceUrl = (token: string): string => absoluteUrl(`/invoice/${token}`);

// --- Settings -------------------------------------------------------------------------------------------------------

export type InvoiceSettings = {
  businessName: string;
  businessAddress: string;
  businessEmail: string;
  taxIdLabel: string;
  taxId: string;
  currency: InvoiceCurrency;
  taxLabel: string;
  taxRateBp: number;
  dueDays: number;
  prefix: string;
  footer: string;
  onlinePayment: boolean;
};

export const DEFAULT_INVOICE_SETTINGS: InvoiceSettings = {
  businessName: "",
  businessAddress: "",
  businessEmail: "",
  taxIdLabel: "",
  taxId: "",
  currency: "USD",
  taxLabel: "",
  taxRateBp: 0,
  dueDays: 14,
  prefix: "INV",
  footer: "",
  onlinePayment: true,
};

const isCurrency = (v: unknown): v is InvoiceCurrency => typeof v === "string" && (INVOICE_CURRENCIES as readonly string[]).includes(v);
const PREFIX = /^[A-Z0-9]{1,10}$/;

export async function readInvoiceSettings(): Promise<InvoiceSettings> {
  const db = await getDb();
  const [row] = await db.select().from(schema.setting).where(eq(schema.setting.key, SETTINGS_KEY));
  const v = (row?.value ?? {}) as Partial<Record<keyof InvoiceSettings, unknown>>;
  const d = DEFAULT_INVOICE_SETTINGS;
  const text = (x: unknown, fallback: string) => (typeof x === "string" ? x : fallback);
  const int = (x: unknown, fallback: number, max: number) => (typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= max ? x : fallback);
  return {
    businessName: text(v.businessName, d.businessName),
    businessAddress: text(v.businessAddress, d.businessAddress),
    businessEmail: text(v.businessEmail, d.businessEmail),
    taxIdLabel: text(v.taxIdLabel, d.taxIdLabel),
    taxId: text(v.taxId, d.taxId),
    currency: isCurrency(v.currency) ? v.currency : d.currency,
    taxLabel: text(v.taxLabel, d.taxLabel),
    taxRateBp: int(v.taxRateBp, d.taxRateBp, MAX_TAX_RATE_BP),
    dueDays: int(v.dueDays, d.dueDays, 365),
    prefix: typeof v.prefix === "string" && PREFIX.test(v.prefix) ? v.prefix : d.prefix,
    footer: text(v.footer, d.footer),
    onlinePayment: typeof v.onlinePayment === "boolean" ? v.onlinePayment : d.onlinePayment,
  };
}

export async function saveInvoiceSettings(actor: Actor, raw: Record<string, unknown>): Promise<InvoiceSettings> {
  adminOnly(actor);
  const issues: string[] = [];
  const limited = (label: string, value: string, max: number) => {
    if (value.length > max) issues.push(`${label}: at most ${max} characters`);
    return value;
  };
  const businessEmail = oneLine(raw.businessEmail).toLowerCase();
  if (businessEmail && (!EMAIL.test(businessEmail) || businessEmail.length > 200)) issues.push("Business email: enter a valid email address or leave it empty");
  const currency = oneLine(raw.currency);
  if (!isCurrency(currency)) issues.push("Default currency: choose one from the list");
  const taxRateBp = parseHundredths(oneLine(raw.taxRate) || "0");
  if (taxRateBp === null || taxRateBp > MAX_TAX_RATE_BP) issues.push("Default tax rate: a percentage from 0 to 100 with at most two decimals");
  const dueDays = Number(oneLine(raw.dueDays) || "0");
  if (!Number.isInteger(dueDays) || dueDays < 0 || dueDays > 365) issues.push("Payment due: a whole number of days from 0 to 365");
  const prefix = oneLine(raw.prefix).toUpperCase();
  if (!PREFIX.test(prefix)) issues.push("Number prefix: 1 to 10 letters or digits");
  const next: InvoiceSettings = {
    businessName: limited("Business name", oneLine(raw.businessName), 120),
    businessAddress: limited("Business address", manyLines(raw.businessAddress), 600),
    businessEmail,
    taxIdLabel: limited("Tax ID label", oneLine(raw.taxIdLabel), 30),
    taxId: limited("Tax ID", oneLine(raw.taxId), 60),
    currency: isCurrency(currency) ? currency : DEFAULT_INVOICE_SETTINGS.currency,
    taxLabel: limited("Default tax label", oneLine(raw.taxLabel), 30),
    taxRateBp: taxRateBp ?? 0,
    dueDays,
    prefix,
    footer: limited("Payment details and terms", manyLines(raw.footer), 1500),
    onlinePayment: raw.onlinePayment === true || raw.onlinePayment === "on" || raw.onlinePayment === "true",
  };
  if (issues.length > 0) throw new PostError("Invoice settings are not valid.", 400, issues);
  const db = await getDb();
  await db
    .insert(schema.setting)
    .values({ key: SETTINGS_KEY, value: next, updatedBy: actor.id })
    .onConflictDoUpdate({ target: schema.setting.key, set: { value: next, updatedBy: actor.id, updatedAt: new Date() } });
  await audit(actor, "invoice.settings", undefined, { prefix: next.prefix, currency: next.currency, onlinePayment: next.onlinePayment });
  return next;
}

const sellerOf = (s: InvoiceSettings): InvoiceSeller => ({ name: s.businessName, address: s.businessAddress, email: s.businessEmail, taxIdLabel: s.taxIdLabel, taxId: s.taxId, footer: s.footer });

type Context = { settings: InvoiceSettings; timeZone: string };

async function context(): Promise<Context> {
  const [settings, published] = await Promise.all([readInvoiceSettings(), getPublishedConfig()]);
  return { settings, timeZone: published.config.general.timezone };
}

/** What the admin pages need to know before offering "Send". */
export async function invoiceReadiness() {
  const [settings, env, storage] = await Promise.all([readInvoiceSettings(), effectiveEnv(), storageReady()]);
  const keys = razorpayKeys(env);
  return {
    settings,
    storage,
    business: settings.businessName !== "",
    razorpay: Boolean(keys.keyId && keys.keySecret),
    webhook: Boolean(keys.webhookSecret),
    online: settings.onlinePayment && Boolean(keys.keyId && keys.keySecret),
  };
}

// --- Drafts ---------------------------------------------------------------------------------------------------------

export type InvoiceFormInput = {
  clientName?: unknown;
  clientEmail?: unknown;
  clientCompany?: unknown;
  clientAddress?: unknown;
  clientTaxId?: unknown;
  currency?: unknown;
  issueDate?: unknown;
  dueDate?: unknown;
  taxLabel?: unknown;
  /** A percentage as typed: "9" or "8.25". */
  taxRate?: unknown;
  notes?: unknown;
  items?: { description?: unknown; quantity?: unknown; unitPrice?: unknown }[];
};

/** The invoice form as posted: line fields repeat, one of each per row. */
export function invoiceInputFromForm(form: FormData): InvoiceFormInput {
  const descriptions = form.getAll("itemDescription");
  const quantities = form.getAll("itemQuantity");
  const prices = form.getAll("itemUnitPrice");
  const field = (name: string) => form.get(name) ?? undefined;
  return {
    clientName: field("clientName"),
    clientEmail: field("clientEmail"),
    clientCompany: field("clientCompany"),
    clientAddress: field("clientAddress"),
    clientTaxId: field("clientTaxId"),
    currency: field("currency"),
    issueDate: field("issueDate"),
    dueDate: field("dueDate"),
    taxLabel: field("taxLabel"),
    taxRate: field("taxRate"),
    notes: field("notes"),
    items: descriptions.map((description, i) => ({ description, quantity: quantities[i], unitPrice: prices[i] })),
  };
}

type Content = Pick<
  InvoiceRow,
  "clientName" | "clientEmail" | "clientCompany" | "clientAddress" | "clientTaxId" | "currency" | "items" | "subtotal" | "taxLabel" | "taxRateBp" | "taxAmount" | "total" | "notes" | "issueDate" | "dueDate"
>;

function parseInvoice(raw: InvoiceFormInput, settings: InvoiceSettings, today: string): Content {
  const issues: string[] = [];
  const limited = (label: string, value: string, max: number, required = false) => {
    if (required && value === "") issues.push(`${label}: required`);
    if (value.length > max) issues.push(`${label}: at most ${max} characters`);
    return value;
  };
  const clientName = limited("Client name", oneLine(raw.clientName), 120, true);
  const clientEmail = oneLine(raw.clientEmail).toLowerCase();
  if (!EMAIL.test(clientEmail) || clientEmail.length > 200) issues.push("Client email: enter a valid email address");
  const currency = oneLine(raw.currency) || settings.currency;
  if (!isCurrency(currency)) issues.push("Currency: choose one from the list");

  const issueDate = oneLine(raw.issueDate) || today;
  if (!isIsoDate(issueDate)) issues.push("Invoice date: use a real date");
  const dueDate = oneLine(raw.dueDate) || (isIsoDate(issueDate) ? addDays(issueDate, settings.dueDays) : "");
  if (!isIsoDate(dueDate)) issues.push("Due date: use a real date");
  else if (isIsoDate(issueDate) && dueDate < issueDate) issues.push("Due date: cannot be before the invoice date");

  const taxRateText = oneLine(raw.taxRate);
  const taxRateBp = taxRateText === "" ? 0 : parseHundredths(taxRateText);
  if (taxRateBp === null || taxRateBp > MAX_TAX_RATE_BP) issues.push("Tax rate: a percentage from 0 to 100 with at most two decimals");

  const rows = (Array.isArray(raw.items) ? raw.items : [])
    .map((r) => ({ description: manyLines(r.description), quantity: oneLine(r.quantity), unitPrice: oneLine(r.unitPrice) }))
    // A row left completely empty in the form is not a line.
    .filter((r) => r.description !== "" || r.quantity !== "" || r.unitPrice !== "");
  if (rows.length === 0) issues.push("Add at least one line");
  if (rows.length > MAX_ITEMS) issues.push(`At most ${MAX_ITEMS} lines`);
  const parsed = rows.slice(0, MAX_ITEMS).map((r, i) => {
    const at = `Line ${i + 1}`;
    if (r.description === "") issues.push(`${at}: describe what is being charged for`);
    if (r.description.length > 500) issues.push(`${at}: description of at most 500 characters`);
    const quantity = parseHundredths(r.quantity === "" ? "1" : r.quantity);
    if (quantity === null || quantity <= 0 || quantity > MAX_QUANTITY) issues.push(`${at}: quantity above 0 and up to ${formatHundredths(MAX_QUANTITY)}, with at most two decimals`);
    const unitPrice = parseHundredths(r.unitPrice);
    if (unitPrice === null || unitPrice > MAX_UNIT_PRICE) issues.push(`${at}: unit price from 0 to ${formatAmount(MAX_UNIT_PRICE)}, with at most two decimals`);
    return { description: r.description, quantity: quantity ?? 0, unitPrice: unitPrice ?? 0 };
  });
  const totals = invoiceTotals(parsed, taxRateBp ?? 0);
  if (totals.total > MAX_TOTAL) issues.push(`Total: at most ${formatAmount(MAX_TOTAL)}`);
  const clientCompany = limited("Company", oneLine(raw.clientCompany), 120);
  const clientAddress = limited("Client address", manyLines(raw.clientAddress), 600);
  const clientTaxId = limited("Client tax ID", oneLine(raw.clientTaxId), 60);
  const taxLabel = limited("Tax label", oneLine(raw.taxLabel), 30);
  const notes = limited("Notes", manyLines(raw.notes), 2000);
  if (issues.length > 0) throw new PostError("Please check the invoice.", 400, issues);

  const items: InvoiceItem[] = parsed.map((p, i) => ({ ...p, amount: totals.lines[i] ?? 0 }));
  return {
    clientName,
    clientEmail,
    clientCompany: clientCompany || null,
    clientAddress: clientAddress || null,
    clientTaxId: clientTaxId || null,
    currency,
    items,
    subtotal: totals.subtotal,
    taxLabel: taxLabel || null,
    taxRateBp: taxRateBp ?? 0,
    taxAmount: totals.taxAmount,
    total: totals.total,
    notes: notes || null,
    issueDate,
    dueDate,
  };
}

export async function getInvoice(id: string): Promise<InvoiceRow | null> {
  if (!UUID.test(id)) return null;
  const db = await getDb();
  const [row] = await db.select().from(schema.invoice).where(eq(schema.invoice.id, id));
  return row ?? null;
}

async function mustGet(id: string): Promise<InvoiceRow> {
  const row = await getInvoice(id);
  if (!row) throw new PostError("Invoice not found.", 404);
  return row;
}

export async function createInvoice(actor: Actor, raw: InvoiceFormInput): Promise<InvoiceRow> {
  adminOnly(actor);
  const { settings, timeZone } = await context();
  const content = parseInvoice(raw, settings, todayIn(timeZone));
  const db = await getDb();
  const [row] = await db
    .insert(schema.invoice)
    .values({ ...content, token: randomBytes(32).toString("base64url"), createdBy: actor.id })
    .returning();
  if (!row) throw new PostError("The invoice could not be saved.", 500);
  await audit(actor, "invoice.create", row.id, { total: row.total, currency: row.currency });
  return row;
}

export async function updateInvoice(actor: Actor, id: string, raw: InvoiceFormInput): Promise<InvoiceRow> {
  adminOnly(actor);
  const before = await mustGet(id);
  if (before.status !== "draft") throw new PostError("A sent invoice cannot be changed. Void it and send a new one.", 409);
  const { settings, timeZone } = await context();
  const content = parseInvoice(raw, settings, todayIn(timeZone));
  const db = await getDb();
  const [row] = await db
    .update(schema.invoice)
    .set({ ...content, updatedAt: new Date() })
    .where(and(eq(schema.invoice.id, id), eq(schema.invoice.status, "draft")))
    .returning();
  if (!row) throw new PostError("A sent invoice cannot be changed. Void it and send a new one.", 409);
  await audit(actor, "invoice.update", id, { total: row.total, currency: row.currency });
  return row;
}

/** Only a draft that never got a number can be deleted; anything numbered is voided instead. */
export async function deleteInvoice(actor: Actor, id: string): Promise<void> {
  adminOnly(actor);
  const before = await mustGet(id);
  if (before.status !== "draft" || before.number) throw new PostError("Only a draft without a number can be deleted. Void this invoice instead.", 409);
  const db = await getDb();
  await db.delete(schema.invoice).where(and(eq(schema.invoice.id, id), eq(schema.invoice.status, "draft"), sql`${schema.invoice.number} is null`));
  await audit(actor, "invoice.delete", id);
}

/** A new draft for the same client with the same lines, dated today. */
export async function duplicateInvoice(actor: Actor, id: string): Promise<InvoiceRow> {
  adminOnly(actor);
  const from = await mustGet(id);
  const { settings, timeZone } = await context();
  const today = todayIn(timeZone);
  const db = await getDb();
  const [row] = await db
    .insert(schema.invoice)
    .values({
      token: randomBytes(32).toString("base64url"),
      createdBy: actor.id,
      clientName: from.clientName,
      clientEmail: from.clientEmail,
      clientCompany: from.clientCompany,
      clientAddress: from.clientAddress,
      clientTaxId: from.clientTaxId,
      currency: from.currency,
      items: from.items,
      subtotal: from.subtotal,
      taxLabel: from.taxLabel,
      taxRateBp: from.taxRateBp,
      taxAmount: from.taxAmount,
      total: from.total,
      notes: from.notes,
      issueDate: today,
      dueDate: addDays(today, settings.dueDays),
    })
    .returning();
  if (!row) throw new PostError("The invoice could not be copied.", 500);
  await audit(actor, "invoice.create", row.id, { copyOf: id });
  return row;
}

// --- Lists ----------------------------------------------------------------------------------------------------------

export const INVOICE_FILTERS = ["all", "draft", "unpaid", "overdue", "paid", "void"] as const;
export type InvoiceFilter = (typeof INVOICE_FILTERS)[number];

export async function listInvoices(filter: InvoiceFilter = "all", today: string = todayIn("UTC")): Promise<InvoiceRow[]> {
  const db = await getDb();
  const i = schema.invoice;
  const where =
    filter === "all" ? undefined : filter === "unpaid" ? eq(i.status, "sent") : filter === "overdue" ? and(eq(i.status, "sent"), lt(i.dueDate, today)) : eq(i.status, filter);
  return db.select().from(i).where(where).orderBy(desc(i.createdAt)).limit(300);
}

export type InvoiceSummary = { counts: Record<InvoiceStatus, number>; overdue: number; outstanding: { currency: string; total: number }[]; paid: { currency: string; total: number }[] };

/** How many invoices are in each state, and the money owed and received per currency. */
export async function invoiceSummary(today: string): Promise<InvoiceSummary> {
  const db = await getDb();
  const i = schema.invoice;
  const [grouped, [late]] = await Promise.all([
    db.select({ status: i.status, currency: i.currency, n: count(), total: sql<number>`coalesce(sum(${i.total}), 0)::float8` }).from(i).groupBy(i.status, i.currency),
    db.select({ n: count() }).from(i).where(and(eq(i.status, "sent"), lt(i.dueDate, today))),
  ]);
  const counts: Record<InvoiceStatus, number> = { draft: 0, sent: 0, paid: 0, void: 0 };
  const outstanding: InvoiceSummary["outstanding"] = [];
  const paid: InvoiceSummary["paid"] = [];
  for (const g of grouped) {
    if ((INVOICE_STATUSES as readonly string[]).includes(g.status)) counts[g.status as InvoiceStatus] += Number(g.n);
    if (g.status === "sent") outstanding.push({ currency: g.currency, total: Number(g.total) });
    if (g.status === "paid") paid.push({ currency: g.currency, total: Number(g.total) });
  }
  return { counts, overdue: Number(late?.n ?? 0), outstanding, paid };
}

// --- The document: what the PDF and the client's page show ----------------------------------------------------------

const statusOf = (row: Pick<InvoiceRow, "status">): InvoiceStatus => ((INVOICE_STATUSES as readonly string[]).includes(row.status) ? (row.status as InvoiceStatus) : "draft");
const lines = (...parts: (string | null | undefined)[]) => parts.flatMap((p) => (p ?? "").split("\n")).map((l) => l.trim()).filter(Boolean);

/** Whether the client can pay this invoice online right now. */
export const payableOnline = (row: Pick<InvoiceRow, "status" | "paymentLinkUrl" | "paymentLinkStatus">): boolean =>
  row.status === "sent" && !!row.paymentLinkUrl && row.paymentLinkStatus === "created";

/**
 * The invoice as text ready to show. `seller` is the snapshot taken when it was sent; before that, the current
 * settings. `online` says whether the link on the PDF may promise online payment.
 */
export function invoiceDocument(row: InvoiceRow, ctx: Context, online: boolean = payableOnline(row)): InvoicePdfInput {
  const seller = row.seller ?? sellerOf(ctx.settings);
  const status = statusOf(row);
  const money = (v: number) => formatMoney(v, row.currency);
  const totals: InvoicePdfInput["totals"] = [{ label: "Subtotal", value: formatAmount(row.subtotal) }];
  if (row.taxRateBp > 0) totals.push({ label: `${row.taxLabel || "Tax"} (${formatRate(row.taxRateBp)})`, value: formatAmount(row.taxAmount) });
  totals.push({ label: "Total", value: money(row.total), strong: true });
  if (status === "paid") totals.push({ label: "Amount paid", value: formatAmount(row.total) }, { label: "Balance due", value: money(0), strong: true });

  const paidOn = row.paidAt ? formatDate(todayIn(ctx.timeZone, row.paidAt)) : "";
  const summary: InvoicePdfInput["summary"] =
    status === "paid"
      ? { label: "Paid", value: money(row.total), note: [paidOn, row.paidVia === "razorpay" && row.paymentId ? `Razorpay ${row.paymentId}` : (row.paymentNote ?? "")].filter(Boolean).join(" · ") || undefined }
      : status === "void"
        ? { label: "Void", value: money(row.total), note: "This invoice was cancelled. Nothing is due." }
        : { label: "Amount due", value: money(row.total), note: row.dueDate ? `Due ${formatDate(row.dueDate)}` : undefined };

  return {
    number: row.number ?? "DRAFT",
    status,
    issueDate: formatDate(row.issueDate),
    dueDate: formatDate(row.dueDate),
    seller: { name: seller.name || "Invoice", lines: lines(seller.address, seller.email, seller.taxId ? `${seller.taxIdLabel || "Tax ID"} ${seller.taxId}` : "") },
    client: { name: row.clientName, lines: lines(row.clientCompany, row.clientAddress, row.clientEmail, row.clientTaxId ? `Tax ID ${row.clientTaxId}` : "") },
    items: row.items.map((it) => ({ description: it.description, quantity: formatHundredths(it.quantity), unitPrice: formatAmount(it.unitPrice), amount: formatAmount(it.amount) })),
    totals,
    summary,
    link: status === "sent" ? { label: online ? "View this invoice and pay online" : "View this invoice online", url: invoiceUrl(row.token) } : undefined,
    notes: row.notes ?? undefined,
    footer: seller.footer || undefined,
  };
}

const renderPdf = (row: InvoiceRow, ctx: Context, online?: boolean): Buffer => Buffer.from(renderInvoicePdf(invoiceDocument(row, ctx, online)));

/** jithendar/www/invoices/{year}/{invoice id}/{random}.pdf: a new name each time, so an old address never shows a newer invoice. */
const pdfKeyFor = (row: Pick<InvoiceRow, "id" | "createdAt">): string => `${INVOICE_ROOT}/${row.createdAt.getUTCFullYear()}/${row.id}/${randomUUID()}.pdf`;

const removeObject = (key: string) => deleteObject(key).catch((err) => log.warn("invoice pdf not removed from storage", { event: "invoice_pdf_orphan", error: String(err) }));

/** Render the invoice as it is now and make that the stored PDF. Null when the invoice moved on meanwhile. */
async function storePdf(row: InvoiceRow, ctx: Context): Promise<Buffer | null> {
  const bytes = renderPdf(row, ctx);
  const key = pdfKeyFor(row);
  await putObject(key, bytes, { contentType: "application/pdf", cacheControl: PRIVATE });
  const db = await getDb();
  const [saved] = await db
    .update(schema.invoice)
    .set({ pdfKey: key, pdfStatus: row.status })
    .where(and(eq(schema.invoice.id, row.id), eq(schema.invoice.status, row.status)))
    .returning({ id: schema.invoice.id });
  if (!saved) {
    await removeObject(key);
    return null;
  }
  if (row.pdfKey) await removeObject(row.pdfKey);
  return bytes;
}

/** After paid or void: the stored PDF should say so. A failure is logged; the next download renders it again. */
async function refreshPdf(row: InvoiceRow): Promise<void> {
  try {
    if (await storageReady()) await storePdf(row, await context());
  } catch (err) {
    log.warn("invoice pdf not refreshed", { event: "invoice_pdf_refresh_failed", error: String(err) });
  }
}

export type InvoiceFile = { bytes: Uint8Array; filename: string; stored: boolean };

/**
 * The PDF to download: the copy in R2 when it shows the invoice's current state, otherwise a fresh render (stored
 * for next time when storage is connected). A draft is rendered on the spot as a preview and never stored.
 */
export async function invoicePdfFile(row: InvoiceRow): Promise<InvoiceFile> {
  const filename = `${(row.number ?? "draft-invoice").replace(/[^A-Za-z0-9._-]/g, "-")}.pdf`;
  const ctx = await context();
  if (row.status !== "draft") {
    try {
      if (await storageReady()) {
        if (row.pdfKey && row.pdfStatus === row.status) {
          const stored = await getObjectBytes(row.pdfKey, MAX_PDF_BYTES);
          if (stored) return { bytes: stored, filename, stored: true };
        }
        const fresh = await storePdf(row, ctx);
        if (fresh) return { bytes: fresh, filename, stored: true };
      }
    } catch (err) {
      log.warn("invoice pdf storage failed; rendering without it", { event: "invoice_pdf_storage_failed", error: String(err) });
    }
  }
  return { bytes: renderPdf(row, ctx), filename, stored: false };
}

// --- Razorpay payment links -----------------------------------------------------------------------------------------

type Keys = ReturnType<typeof razorpayKeys>;
const basic = (keys: Keys) => `Basic ${Buffer.from(`${keys.keyId}:${keys.keySecret}`).toString("base64")}`;
const reasonOf = (body: unknown): string => {
  const d = (body as { error?: { description?: unknown } } | null)?.error?.description;
  return typeof d === "string" ? d.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 200) : "";
};

async function createPaymentLink(row: InvoiceRow, number: string, sellerName: string, keys: Keys, fetchImpl: Fetch): Promise<{ id: string; url: string }> {
  let res: Response;
  try {
    res = await fetchImpl(`${API}/payment_links`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: basic(keys) },
      body: JSON.stringify({
        amount: row.total,
        currency: row.currency,
        accept_partial: false,
        // Unique in Razorpay: a second link for the same invoice (after a void or an expiry) needs a new one.
        reference_id: `${number}-${randomBytes(4).toString("hex")}`.slice(0, 40),
        description: `Invoice ${number} from ${sellerName}`.slice(0, 500),
        customer: { name: row.clientName.slice(0, 100), email: row.clientEmail },
        // The site sends the invoice email itself; Razorpay stays quiet.
        notify: { sms: false, email: false },
        reminder_enable: false,
        notes: { invoice_id: row.id, invoice_number: number },
        callback_url: invoiceUrl(row.token),
        callback_method: "get",
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    log.error("razorpay payment link failed", { event: "razorpay_link_failed", error: String(err) });
    throw new PostError("Razorpay could not be reached, so the payment link was not created. Try again in a moment.", 502);
  }
  const body = (await res.json().catch(() => ({}))) as { id?: unknown; short_url?: unknown; amount?: unknown; currency?: unknown };
  if (!res.ok || typeof body.id !== "string" || typeof body.short_url !== "string" || !/^https:\/\/[^\s]+$/.test(body.short_url) || body.amount !== row.total || body.currency !== row.currency) {
    const reason = reasonOf(body);
    log.error("razorpay payment link failed", { event: "razorpay_link_failed", status: res.status, reason: reason || undefined });
    throw new PostError(`Razorpay did not create the payment link${reason ? `: ${reason}` : "."}`, 502);
  }
  return { id: body.id, url: body.short_url };
}

type Closed = { outcome: "cancelled" } | { outcome: "paid"; paymentId: string | null } | { outcome: "failed"; reason: string };

/**
 * Stop a payment link from being paid. If Razorpay refuses, look at the link: it may be closed already, or paid a
 * moment ago, which the caller must not overwrite.
 */
async function closePaymentLink(linkId: string, keys: Keys, fetchImpl: Fetch): Promise<Closed> {
  const at = `${API}/payment_links/${encodeURIComponent(linkId)}`;
  const headers = { "Content-Type": "application/json", Authorization: basic(keys) };
  try {
    const cancel = await fetchImpl(`${at}/cancel`, { method: "POST", headers, signal: AbortSignal.timeout(15_000) });
    if (cancel.ok) return { outcome: "cancelled" };
    const reason = reasonOf(await cancel.json().catch(() => ({})));
    const look = await fetchImpl(at, { method: "GET", headers, signal: AbortSignal.timeout(15_000) });
    const link = (await look.json().catch(() => ({}))) as { status?: unknown; payments?: unknown };
    if (look.ok && (link.status === "cancelled" || link.status === "expired")) return { outcome: "cancelled" };
    if (look.ok && link.status === "paid") {
      const first = Array.isArray(link.payments) ? (link.payments[0] as { payment_id?: unknown } | undefined) : undefined;
      return { outcome: "paid", paymentId: typeof first?.payment_id === "string" ? first.payment_id.slice(0, 60) : null };
    }
    return { outcome: "failed", reason };
  } catch (err) {
    return { outcome: "failed", reason: String(err).slice(0, 200) };
  }
}

// --- Sending --------------------------------------------------------------------------------------------------------

const subjectLine = (text: string) => text.replace(/[\r\n]+/g, " ").slice(0, 150);

async function emailClient(row: InvoiceRow, ctx: Context, kind: "invoice" | "receipt"): Promise<boolean> {
  const seller = row.seller ?? sellerOf(ctx.settings);
  const from = seller.name || "us";
  const number = row.number ?? "";
  const amount = formatMoney(row.total, row.currency);
  const url = invoiceUrl(row.token);
  const contact = seller.email ? `If you have a question about this invoice, write to ${seller.email}.` : "If you have a question about this invoice, reply to this email.";
  const text =
    kind === "receipt"
      ? [`Hello ${row.clientName},`, "", `Thank you. Your payment of ${amount} for invoice ${number} has been received.`, "", "Your paid invoice is here, to view or download as a PDF:", url, "", seller.name].join("\n")
      : [
          `Hello ${row.clientName},`,
          "",
          `Here is invoice ${number} from ${from} for ${amount}${row.dueDate ? `, due on ${formatDate(row.dueDate)}` : ""}.`,
          "",
          payableOnline(row) ? "View the invoice, download the PDF and pay online:" : "View the invoice and download the PDF:",
          url,
          "",
          contact,
          "",
          seller.name,
        ].join("\n");
  const sent = await sendMail(row.clientEmail, subjectLine(kind === "receipt" ? `Payment received for invoice ${number}` : `Invoice ${number} from ${from}`), text);
  if (sent && kind === "invoice") {
    const db = await getDb();
    await db.update(schema.invoice).set({ emailedAt: new Date() }).where(eq(schema.invoice.id, row.id));
  }
  return sent;
}

/** The next number of the series, given to this invoice once. A draft that already has one keeps it. */
async function numberFor(id: string, prefix: string, year: number): Promise<string> {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const [locked] = await tx.select({ number: schema.invoice.number, status: schema.invoice.status }).from(schema.invoice).where(eq(schema.invoice.id, id)).for("update");
    if (!locked || locked.status !== "draft") throw new PostError("This invoice has already been sent.", 409);
    if (locked.number) return locked.number;
    const series = invoiceSeries(prefix, year);
    const [counter] = await tx
      .insert(schema.invoiceCounter)
      .values({ series, last: 1 })
      .onConflictDoUpdate({ target: schema.invoiceCounter.series, set: { last: sql`${schema.invoiceCounter.last} + 1` } })
      .returning({ last: schema.invoiceCounter.last });
    if (!counter) throw new PostError("The invoice number could not be assigned.", 500);
    const number = invoiceNumber(prefix, year, counter.last);
    await tx.update(schema.invoice).set({ number, updatedAt: new Date() }).where(eq(schema.invoice.id, id));
    return number;
  });
}

export type SendResult = { invoice: InvoiceRow; emailed: boolean; online: boolean };

/**
 * Send a draft: number it, store the PDF, create the payment link, mark it sent, then email the client. Any failure
 * before "mark it sent" leaves a draft (which keeps its number) and nothing behind in R2 or Razorpay. The email comes
 * last: if it fails the invoice is sent and the admin is told to resend it.
 */
export async function sendInvoice(actor: Actor, id: string, fetchImpl: Fetch = fetch): Promise<SendResult> {
  adminOnly(actor);
  const draft = await mustGet(id);
  if (draft.status !== "draft") throw new PostError("This invoice has already been sent.", 409);
  const [ctx, env, storage] = await Promise.all([context(), effectiveEnv(), storageReady()]);
  const { settings } = ctx;
  if (!settings.businessName) throw new PostError("Add your business name in Invoices → Settings before sending an invoice.", 409);
  if (!storage) throw new PostError("Connect file storage first (Admin → Storage & email): the invoice PDF is stored there.", 409);
  if (draft.items.length === 0 || draft.total <= 0) throw new PostError("An invoice needs a total above zero before it can be sent.", 400);
  const keys = razorpayKeys(env);
  const online = settings.onlinePayment && Boolean(keys.keyId && keys.keySecret);
  if (online && draft.total < MIN_AMOUNT) throw new PostError(`Razorpay cannot collect less than ${formatMoney(MIN_AMOUNT, draft.currency)}. Raise the total or switch online payment off in Invoices → Settings.`, 400);

  const today = todayIn(ctx.timeZone);
  const issueDate = draft.issueDate && isIsoDate(draft.issueDate) ? draft.issueDate : today;
  const dueDate = draft.dueDate && isIsoDate(draft.dueDate) ? draft.dueDate : addDays(issueDate, settings.dueDays);
  const number = await numberFor(id, settings.prefix, Number(issueDate.slice(0, 4)));
  const now = new Date();
  const seller = sellerOf(settings);
  const sending: InvoiceRow = { ...draft, number, status: "sent", seller, issueDate, dueDate, sentAt: now };

  const pdfKey = pdfKeyFor(draft);
  await putObject(pdfKey, renderPdf(sending, ctx, online), { contentType: "application/pdf", cacheControl: PRIVATE });
  let link: { id: string; url: string } | null = null;
  let sent: InvoiceRow | undefined;
  try {
    if (online) link = await createPaymentLink(sending, number, seller.name, keys, fetchImpl);
    const db = await getDb();
    [sent] = await db
      .update(schema.invoice)
      .set({ status: "sent", seller, issueDate, dueDate, sentAt: now, updatedAt: now, pdfKey, pdfStatus: "sent", paymentLinkId: link?.id ?? null, paymentLinkUrl: link?.url ?? null, paymentLinkStatus: link ? "created" : null })
      .where(and(eq(schema.invoice.id, id), eq(schema.invoice.status, "draft")))
      .returning();
  } catch (err) {
    await removeObject(pdfKey);
    if (link) await closePaymentLink(link.id, keys, fetchImpl);
    throw err;
  }
  if (!sent) {
    // Sent by another request in the meantime: that one's PDF and link stand, these are withdrawn.
    await removeObject(pdfKey);
    if (link) await closePaymentLink(link.id, keys, fetchImpl);
    throw new PostError("This invoice has already been sent.", 409);
  }
  if (draft.pdfKey) await removeObject(draft.pdfKey);
  await audit(actor, "invoice.send", id, { number, total: sent.total, currency: sent.currency, online: Boolean(link) });
  log.info("invoice sent", { event: "invoice_sent", currency: sent.currency, online: Boolean(link) });
  const emailed = await emailClient(sent, ctx, "invoice").catch((err) => {
    log.warn("invoice email failed", { event: "invoice_email_failed", error: String(err) });
    return false;
  });
  return { invoice: sent, emailed, online: Boolean(link) };
}

/** Email the client their link again: the invoice while it is unpaid, the receipt once it is paid. */
export async function resendInvoice(actor: Actor, id: string): Promise<boolean> {
  adminOnly(actor);
  const row = await mustGet(id);
  if (row.status !== "sent" && row.status !== "paid") throw new PostError("Only a sent or paid invoice can be emailed.", 409);
  const sent = await emailClient(row, await context(), row.status === "paid" ? "receipt" : "invoice");
  await audit(actor, "invoice.resend", id, { number: row.number, sent });
  return sent;
}

/**
 * A new payment link for a sent invoice: when the old one expired or was cancelled in Razorpay, or Razorpay was
 * connected after the invoice went out. The old link is closed first.
 */
export async function renewPaymentLink(actor: Actor, id: string, fetchImpl: Fetch = fetch): Promise<InvoiceRow> {
  adminOnly(actor);
  const row = await mustGet(id);
  if (row.status !== "sent" || !row.number) throw new PostError("Only a sent, unpaid invoice can get a payment link.", 409);
  const keys = razorpayKeys(await effectiveEnv());
  if (!keys.keyId || !keys.keySecret) throw new PostError("Razorpay is not connected (Admin → Advanced settings → Razorpay payments).", 409);
  if (row.total < MIN_AMOUNT) throw new PostError(`Razorpay cannot collect less than ${formatMoney(MIN_AMOUNT, row.currency)}.`, 400);
  if (row.paymentLinkId && row.paymentLinkStatus === "created") {
    const closed = await closePaymentLink(row.paymentLinkId, keys, fetchImpl);
    if (closed.outcome === "paid") {
      await settlePaid(row.id, { via: "razorpay", paymentId: closed.paymentId, linkStatus: "paid" });
      throw new PostError("The client has just paid this invoice online. It is now marked paid.", 409);
    }
    if (closed.outcome === "failed") throw new PostError(`The current payment link could not be cancelled${closed.reason ? `: ${closed.reason}` : "."} Nothing was changed.`, 502);
  }
  const ctx = await context();
  const link = await createPaymentLink(row, row.number, (row.seller ?? sellerOf(ctx.settings)).name, keys, fetchImpl);
  const db = await getDb();
  const [saved] = await db
    .update(schema.invoice)
    .set({ paymentLinkId: link.id, paymentLinkUrl: link.url, paymentLinkStatus: "created", updatedAt: new Date() })
    .where(and(eq(schema.invoice.id, id), eq(schema.invoice.status, "sent")))
    .returning();
  if (!saved) {
    await closePaymentLink(link.id, keys, fetchImpl);
    throw new PostError("The invoice changed while the link was being made. Nothing was changed.", 409);
  }
  await audit(actor, "invoice.link", id, { number: row.number });
  // The PDF may say "view online" only: render it again so it offers online payment.
  await refreshPdf(saved);
  return saved;
}

// --- Paid and void --------------------------------------------------------------------------------------------------

type Payment = { via: "razorpay" | "manual"; paymentId?: string | null; note?: string | null; linkStatus: string | null };

/** sent → paid, once. Returns the invoice when this call made the change, null when it was not waiting for payment. */
async function settlePaid(id: string, how: Payment): Promise<InvoiceRow | null> {
  const db = await getDb();
  const now = new Date();
  const [changed] = await db
    .update(schema.invoice)
    .set({ status: "paid", paidAt: now, paidVia: how.via, paymentId: how.paymentId ?? null, paymentNote: how.note ?? null, paymentLinkStatus: how.linkStatus, updatedAt: now })
    .where(and(eq(schema.invoice.id, id), eq(schema.invoice.status, "sent")))
    .returning();
  if (!changed) return null;
  log.info("invoice paid", { event: "invoice_paid", via: how.via, currency: changed.currency });
  await refreshPdf(changed);
  if (how.via === "razorpay") {
    const ctx = await context();
    await emailClient(changed, ctx, "receipt").catch((err) => log.warn("invoice receipt email failed", { event: "invoice_email_failed", error: String(err) }));
    await notifyAdmins(
      `[Invoice paid] ${changed.number} · ${formatMoney(changed.total, changed.currency)} · ${changed.clientName}`,
      [`${changed.clientName} <${changed.clientEmail}> paid invoice ${changed.number} (${formatMoney(changed.total, changed.currency)}) online.`, ...(changed.paymentId ? [`Razorpay payment: ${changed.paymentId}`] : []), "", "See Admin → Invoices."].join("\n"),
    ).catch((err) => log.warn("invoice paid email failed", { event: "invoice_email_failed", error: String(err) }));
  }
  return changed;
}

async function notifyAdmins(subject: string, text: string) {
  const db = await getDb();
  const admins = await db.select({ email: schema.user.email }).from(schema.user).where(eq(schema.user.role, "admin"));
  await Promise.all(admins.map((a) => sendMail(a.email, subjectLine(subject), text)));
}

/** An admin records a payment that did not go through Razorpay (a bank transfer). The payment link is closed first. */
export async function markInvoicePaid(actor: Actor, id: string, note: unknown, fetchImpl: Fetch = fetch): Promise<{ invoice: InvoiceRow; alreadyOnline: boolean; linkOpen: boolean }> {
  adminOnly(actor);
  const row = await mustGet(id);
  if (row.status !== "sent") throw new PostError("Only a sent, unpaid invoice can be marked paid.", 409);
  const paymentNote = oneLine(note).slice(0, 200) || null;
  let linkStatus = row.paymentLinkStatus;
  let linkOpen = false;
  if (row.paymentLinkId && row.paymentLinkStatus === "created") {
    const keys = razorpayKeys(await effectiveEnv());
    if (!keys.keyId || !keys.keySecret) linkOpen = true; // Cannot reach Razorpay without keys: the admin is told to cancel the link there.
    else {
      const closed = await closePaymentLink(row.paymentLinkId, keys, fetchImpl);
      if (closed.outcome === "paid") {
        const online = await settlePaid(id, { via: "razorpay", paymentId: closed.paymentId, linkStatus: "paid" });
        return { invoice: online ?? (await mustGet(id)), alreadyOnline: true, linkOpen: false };
      }
      if (closed.outcome === "failed") throw new PostError(`The payment link could not be cancelled${closed.reason ? `: ${closed.reason}` : "."} The invoice was not changed, so the client cannot pay twice. Try again in a moment.`, 502);
      linkStatus = "cancelled";
    }
  }
  const paid = await settlePaid(id, { via: "manual", note: paymentNote, linkStatus });
  if (!paid) throw new PostError("This invoice is no longer waiting for payment.", 409);
  await audit(actor, "invoice.paid", id, { number: paid.number, via: "manual", note: paymentNote });
  return { invoice: paid, alreadyOnline: false, linkOpen };
}

/** Cancel an invoice that has a number (sent, or a draft whose send failed). Its payment link is closed first. */
export async function voidInvoice(actor: Actor, id: string, fetchImpl: Fetch = fetch): Promise<InvoiceRow> {
  adminOnly(actor);
  const row = await mustGet(id);
  if (row.status === "paid") throw new PostError("A paid invoice cannot be voided. Refunds are made in the Razorpay dashboard.", 409);
  if (row.status === "void") return row;
  if (!row.number) throw new PostError("This draft has no number yet: delete it instead.", 409);
  let linkStatus = row.paymentLinkStatus;
  if (row.paymentLinkId && row.paymentLinkStatus === "created") {
    const keys = razorpayKeys(await effectiveEnv());
    if (!keys.keyId || !keys.keySecret) throw new PostError("Razorpay is not connected, so the payment link cannot be cancelled. Connect it again or cancel the link in the Razorpay dashboard first.", 409);
    const closed = await closePaymentLink(row.paymentLinkId, keys, fetchImpl);
    if (closed.outcome === "paid") {
      await settlePaid(id, { via: "razorpay", paymentId: closed.paymentId, linkStatus: "paid" });
      throw new PostError("The client has just paid this invoice online, so it was not voided. It is now marked paid.", 409);
    }
    if (closed.outcome === "failed") throw new PostError(`The payment link could not be cancelled${closed.reason ? `: ${closed.reason}` : "."} The invoice was not voided.`, 502);
    linkStatus = "cancelled";
  }
  const db = await getDb();
  const now = new Date();
  const ctx = await context();
  const [voided] = await db
    .update(schema.invoice)
    // A numbered draft never got its seller snapshot: take it now, so the void PDF does not change with the settings.
    .set({ status: "void", voidedAt: now, updatedAt: now, paymentLinkStatus: linkStatus, seller: row.seller ?? sellerOf(ctx.settings) })
    .where(and(eq(schema.invoice.id, id), inArray(schema.invoice.status, ["draft", "sent"])))
    .returning();
  if (!voided) throw new PostError("This invoice changed while it was being voided. Open it again.", 409);
  await audit(actor, "invoice.void", id, { number: voided.number });
  await refreshPdf(voided);
  return voided;
}

// --- From Razorpay --------------------------------------------------------------------------------------------------

type LinkEntity = { id?: unknown; amount?: unknown; amount_paid?: unknown; currency?: unknown };
type LinkPayload = { payment_link?: { entity?: LinkEntity }; payment?: { entity?: { id?: unknown } } } | null | undefined;

/**
 * A payment_link.* webhook event, already verified by handleRazorpayWebhook. Returns the response body. Links this
 * site did not create (other Razorpay products) are ignored.
 */
export async function handlePaymentLinkEvent(name: string, raw: unknown): Promise<string> {
  const payload = (typeof raw === "object" ? raw : null) as LinkPayload;
  const link = payload?.payment_link?.entity ?? {};
  const linkId = typeof link.id === "string" ? link.id : "";
  if (!linkId) return "Ignored.";
  const db = await getDb();
  const [row] = await db.select().from(schema.invoice).where(eq(schema.invoice.paymentLinkId, linkId));
  if (!row) return "Ignored.";

  if (name === "payment_link.paid") {
    if (link.amount !== row.total || link.amount_paid !== row.total || link.currency !== row.currency) {
      log.error("razorpay payment link amount mismatch", { event: "razorpay_amount_mismatch" });
      return "Amount mismatch; not recorded.";
    }
    const paymentId = typeof payload?.payment?.entity?.id === "string" ? payload.payment.entity.id.slice(0, 60) : null;
    const changed = await settlePaid(row.id, { via: "razorpay", paymentId, linkStatus: "paid" });
    if (!changed && row.status === "void") {
      // The link is cancelled when an invoice is voided, so this should not happen; if it does, a person must look.
      log.error("payment received for a voided invoice", { event: "invoice_paid_after_void" });
      await notifyAdmins(`[Invoice] Payment received for voided invoice ${row.number}`, `Razorpay reports a payment${paymentId ? ` (${paymentId})` : ""} for invoice ${row.number}, which is void. Check the Razorpay dashboard and refund it or issue a new invoice.`).catch(() => {});
    }
    return "OK.";
  }
  if (name === "payment_link.cancelled" || name === "payment_link.expired") {
    await db
      .update(schema.invoice)
      .set({ paymentLinkStatus: name === "payment_link.expired" ? "expired" : "cancelled", updatedAt: new Date() })
      .where(and(eq(schema.invoice.id, row.id), eq(schema.invoice.status, "sent"), eq(schema.invoice.paymentLinkId, linkId)));
    return "OK.";
  }
  return "Ignored.";
}

export type ReturnParams = Record<string, string | string[] | undefined>;

/**
 * The client comes back from Razorpay to /invoice/<token>?razorpay_payment_id=…&razorpay_signature=…: when the
 * signature (made with the key secret) is right and says "paid", record the payment without waiting for the webhook.
 * Returns true when the address carried a valid paid signature for this invoice.
 */
export async function confirmInvoiceReturn(token: string, params: ReturnParams): Promise<boolean> {
  const one = (k: string) => (typeof params[k] === "string" ? (params[k] as string) : "");
  const paymentId = one("razorpay_payment_id");
  const linkId = one("razorpay_payment_link_id");
  const status = one("razorpay_payment_link_status");
  const signature = one("razorpay_signature");
  if (!TOKEN.test(token) || !paymentId || !linkId || !signature || status !== "paid") return false;
  if (!/^pay_[A-Za-z0-9]{6,40}$/.test(paymentId)) return false;
  const db = await getDb();
  const [row] = await db.select().from(schema.invoice).where(eq(schema.invoice.token, token));
  if (!row || row.paymentLinkId !== linkId || (row.status !== "sent" && row.status !== "paid")) return false;
  const { keySecret } = razorpayKeys(await effectiveEnv());
  if (!paymentLinkSignatureValid({ linkId, referenceId: one("razorpay_payment_link_reference_id"), status, paymentId }, signature, keySecret)) {
    log.warn("razorpay payment link signature refused", { event: "razorpay_signature_refused" });
    return false;
  }
  if (row.status === "sent") await settlePaid(row.id, { via: "razorpay", paymentId, linkStatus: "paid" });
  return true;
}

// --- The client's page ----------------------------------------------------------------------------------------------

export type ClientInvoice = { row: InvoiceRow; document: InvoicePdfInput; payUrl: string | null; overdue: boolean };

/** The invoice behind a client link. Drafts are never shown: the link works from the moment the invoice is sent. */
export async function clientInvoice(token: string): Promise<ClientInvoice | null> {
  if (!TOKEN.test(token)) return null;
  const db = await getDb();
  const [row] = await db.select().from(schema.invoice).where(eq(schema.invoice.token, token));
  if (!row || row.status === "draft") return null;
  const ctx = await context();
  return { row, document: invoiceDocument(row, ctx), payUrl: payableOnline(row) ? row.paymentLinkUrl : null, overdue: isOverdue(row.status, row.dueDate, todayIn(ctx.timeZone)) };
}

/** For the admin pages: today's date in the site's time zone and the current settings. */
export async function invoiceContext(): Promise<Context & { today: string }> {
  const ctx = await context();
  return { ...ctx, today: todayIn(ctx.timeZone) };
}
