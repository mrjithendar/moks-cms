import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/posts";
import { defaultConfig } from "@/lib/site-config/schema";
import { freshDb } from "./db-helpers";

vi.mock("server-only", () => ({}));
const mails: { to: string; subject: string; body: string }[] = [];
let mailWorks = true;
vi.mock("@/lib/mail", () => ({
  sendMail: async (to: string, subject: string, body: string) => {
    if (!mailWorks) return false;
    mails.push({ to, subject, body });
    return true;
  },
}));
vi.mock("@/lib/turnstile", () => ({ verifyTurnstile: async () => true }));
vi.mock("@/lib/rate-limit", () => ({ hit: async () => true }));
let env: Record<string, string | undefined> = {};
vi.mock("@/lib/runtime-settings", () => ({ effectiveEnv: async () => env }));
vi.mock("@/lib/site-config/store", () => ({ getPublishedConfig: async () => ({ config: defaultConfig(), version: 1, updatedAt: null, fallbacks: [] }) }));
// R2 as a map: what is "in the bucket" is what the tests look at.
const objects = new Map<string, Buffer>();
let storageUp = true;
vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  storageReady: async () => storageUp,
  putObject: async (key: string, body: Buffer) => void objects.set(key, Buffer.from(body)),
  getObjectBytes: async (key: string) => objects.get(key) ?? null,
  deleteObject: async (key: string) => void objects.delete(key),
}));

const {
  clientInvoice,
  confirmInvoiceReturn,
  createInvoice,
  deleteInvoice,
  duplicateInvoice,
  getInvoice,
  INVOICE_ROOT,
  invoicePdfFile,
  invoiceSummary,
  listInvoices,
  markInvoicePaid,
  readInvoiceSettings,
  renewPaymentLink,
  resendInvoice,
  saveInvoiceSettings,
  sendInvoice,
  updateInvoice,
  voidInvoice,
} = await import("@/lib/invoices");
const { handleRazorpayWebhook } = await import("@/lib/razorpay");
const { getDb, schema } = await import("@/db");

const KEY_SECRET = "testkeysecret1234567890";
const WEBHOOK_SECRET = "webhook-secret-123456";
const KEYS = { RAZORPAY_KEY_ID: "rzp_test_ABCDEFGHIJ1234", RAZORPAY_KEY_SECRET: KEY_SECRET, RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET };
const hmac = (secret: string, data: string) => createHmac("sha256", secret).update(data).digest("hex");

// --- A stand-in for Razorpay's Payment Links API ------------------------------------------------------------------

type Link = { status: string; amount: number; currency: string; paymentId?: string };
const links = new Map<string, Link>();
const calls: { method: string; url: string; body: Record<string, unknown> | null }[] = [];
let createFails: string | null = null;
let cancelFails = false;

const razorpay = (async (url: string, init: RequestInit) => {
  const method = init.method ?? "GET";
  const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
  calls.push({ method, url, body });
  const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status });
  if (method === "POST" && url.endsWith("/payment_links")) {
    if (createFails) return json(400, { error: { description: createFails } });
    const id = `plink_TEST${links.size + 1}`;
    links.set(id, { status: "created", amount: Number(body?.amount), currency: String(body?.currency) });
    return json(200, { id, short_url: `https://rzp.io/i/test${links.size}`, amount: body?.amount, currency: body?.currency, status: "created" });
  }
  const id = /payment_links\/([^/]+)/.exec(url)?.[1] ?? "";
  const link = links.get(id);
  if (method === "POST" && url.endsWith("/cancel")) {
    if (!link || cancelFails || link.status !== "created") return json(400, { error: { description: "This payment link cannot be cancelled" } });
    link.status = "cancelled";
    return json(200, { id, status: "cancelled" });
  }
  if (method === "GET" && link) return json(200, { id, status: link.status, payments: link.paymentId ? [{ payment_id: link.paymentId }] : [] });
  return json(404, { error: { description: "Not found" } });
}) as unknown as typeof fetch;

const created = () => calls.filter((c) => c.method === "POST" && c.url.endsWith("/payment_links"));

// --- Fixtures -----------------------------------------------------------------------------------------------------

const admin: Actor = { id: "admin-1", role: "admin", label: "admin@example.test" };

const input = (patch: Record<string, unknown> = {}) => ({
  clientName: "Ada Lovelace",
  clientEmail: "Ada@Example.test",
  clientCompany: "Analytical Engines Ltd",
  clientAddress: "1 Babbage Street\nLondon",
  currency: "USD",
  issueDate: "2026-11-15",
  dueDate: "",
  taxLabel: "GST",
  taxRate: "9",
  notes: "PO 4411",
  // 12.5 × 150.00 + 2 × 1,200.00 = 4,275.00; 9% = 384.75; total 4,659.75. The empty row is what an unused form row posts.
  items: [
    { description: "Platform review", quantity: "12.5", unitPrice: "150" },
    { description: "Workshop", quantity: "2", unitPrice: "1,200.00" },
    { description: "", quantity: "", unitPrice: "" },
  ],
  ...patch,
});
const TOTAL = 465_975;

const settings = (patch: Record<string, unknown> = {}) => ({
  businessName: "Example Consulting",
  businessAddress: "1 Example Road\nSingapore 123456",
  businessEmail: "billing@example.test",
  taxIdLabel: "GST Reg. No.",
  taxId: "M1234567X",
  currency: "USD",
  taxLabel: "GST",
  taxRate: "9",
  dueDays: "14",
  prefix: "inv",
  footer: "Bank transfer: Example Bank, account 000-111.",
  onlinePayment: "on",
  ...patch,
});

const pdfText = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");
/** The one PDF stored for an invoice, as text. */
function storedPdf(id: string): string {
  const keys = [...objects.keys()].filter((k) => k.includes(`/${id}/`));
  expect(keys, "one stored PDF per invoice").toHaveLength(1);
  return pdfText(objects.get(keys[0]!)!);
}
const paidEvent = (linkId: string, patch: Record<string, unknown> = {}, paymentId = "pay_WHPAID0001") =>
  JSON.stringify({ event: "payment_link.paid", payload: { payment_link: { entity: { id: linkId, amount: TOTAL, amount_paid: TOTAL, currency: "USD", status: "paid", ...patch } }, payment: { entity: { id: paymentId } } } });
const deliver = (body: string, secret = WEBHOOK_SECRET) => handleRazorpayWebhook(body, hmac(secret, body), WEBHOOK_SECRET);

beforeEach(async () => {
  await freshDb();
  mails.length = 0;
  calls.length = 0;
  links.clear();
  objects.clear();
  mailWorks = true;
  storageUp = true;
  createFails = null;
  cancelFails = false;
  env = { ...KEYS };
  const db = await getDb();
  await db.insert(schema.user).values({ id: "admin-1", name: "Admin", email: "admin@example.test", emailVerified: true, role: "admin" });
  await saveInvoiceSettings(admin, settings());
});

describe("invoice drafts", () => {
  it("works the totals out on the server, in the smallest unit, and ignores empty rows", async () => {
    const draft = await createInvoice(admin, input());
    expect(draft).toMatchObject({ status: "draft", number: null, clientEmail: "ada@example.test", currency: "USD", subtotal: 427_500, taxLabel: "GST", taxRateBp: 900, taxAmount: 38_475, total: TOTAL });
    expect(draft).toMatchObject({ issueDate: "2026-11-15", dueDate: "2026-11-29", notes: "PO 4411", pdfKey: null, paymentLinkId: null });
    expect(draft.items).toEqual([
      { description: "Platform review", quantity: 1_250, unitPrice: 15_000, amount: 187_500 },
      { description: "Workshop", quantity: 200, unitPrice: 120_000, amount: 240_000 },
    ]);
    expect(draft.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // An empty quantity means one; no tax rate means no tax.
    const edited = await updateInvoice(admin, draft.id, input({ taxRate: "", items: [{ description: "Only line", quantity: "", unitPrice: "99.99" }] }));
    expect(edited).toMatchObject({ taxRateBp: 0, taxAmount: 0, subtotal: 9_999, total: 9_999 });
  });

  it("says what is wrong with each field, and is for admins only", async () => {
    const bad = createInvoice(admin, input({ clientEmail: "not-an-email", dueDate: "2026-11-01", taxRate: "150", items: [{ description: "x", quantity: "0", unitPrice: "1.234" }] }));
    await expect(bad).rejects.toMatchObject({
      status: 400,
      issues: expect.arrayContaining([expect.stringMatching(/^Client email/), expect.stringMatching(/^Due date: cannot be before/), expect.stringMatching(/^Tax rate/), expect.stringMatching(/^Line 1: quantity/), expect.stringMatching(/^Line 1: unit price/)]),
    });
    await expect(createInvoice(admin, input({ items: [] }))).rejects.toMatchObject({ issues: ["Add at least one line"] });
    await expect(createInvoice(admin, input({ items: [{ description: "Too much", quantity: "100000", unitPrice: "9999999" }] }))).rejects.toMatchObject({ issues: [expect.stringMatching(/^Total: at most 10,000,000\.00/)] });
    for (const role of ["author", "demo", "user"] as const) await expect(createInvoice({ ...admin, role }, input())).rejects.toThrow(/Only admins/);
  });

  it("can be copied and deleted; a draft has no client link", async () => {
    const draft = await createInvoice(admin, input());
    expect(await clientInvoice(draft.token)).toBeNull();
    const copy = await duplicateInvoice(admin, draft.id);
    expect(copy).toMatchObject({ status: "draft", number: null, clientName: "Ada Lovelace", total: TOTAL });
    expect(copy.token).not.toBe(draft.token);
    await deleteInvoice(admin, draft.id);
    expect(await getInvoice(draft.id)).toBeNull();
    expect((await listInvoices("draft")).map((r) => r.id)).toEqual([copy.id]);
  });

  it("keeps settings as typed, with the prefix in capitals, and refuses bad ones", async () => {
    expect(await readInvoiceSettings()).toMatchObject({ businessName: "Example Consulting", prefix: "INV", taxRateBp: 900, dueDays: 14, onlinePayment: true, currency: "USD" });
    await expect(saveInvoiceSettings(admin, settings({ prefix: "IN V", currency: "XXX", businessEmail: "nope", dueDays: "400" }))).rejects.toMatchObject({ issues: expect.arrayContaining([expect.stringMatching(/^Number prefix/), expect.stringMatching(/^Default currency/), expect.stringMatching(/^Business email/), expect.stringMatching(/^Payment due/)]) });
    // An unticked checkbox is not posted at all.
    expect((await saveInvoiceSettings(admin, settings({ onlinePayment: undefined }))).onlinePayment).toBe(false);
  });
});

describe("sending an invoice", () => {
  it("numbers it, stores the PDF in R2, creates a payment link for the exact amount and emails the client their link", async () => {
    const draft = await createInvoice(admin, input());
    const { invoice, emailed, online } = await sendInvoice(admin, draft.id, razorpay);
    expect({ emailed, online }).toEqual({ emailed: true, online: true });
    expect(invoice).toMatchObject({ status: "sent", number: "INV-2026-0001", paymentLinkId: "plink_TEST1", paymentLinkUrl: "https://rzp.io/i/test1", paymentLinkStatus: "created", pdfStatus: "sent" });
    expect(invoice.seller).toMatchObject({ name: "Example Consulting", taxId: "M1234567X" });
    expect(invoice.sentAt).toBeInstanceOf(Date);
    expect(invoice.emailedAt).toBeNull(); // the row returned is from before the email; the stored one has it
    expect((await getInvoice(draft.id))!.emailedAt).toBeInstanceOf(Date);

    const [call] = created();
    expect(call!.url).toBe("https://api.razorpay.com/v1/payment_links");
    expect(call!.body).toMatchObject({ amount: TOTAL, currency: "USD", accept_partial: false, notify: { sms: false, email: false }, reminder_enable: false, callback_method: "get", callback_url: `https://jithendar.com/invoice/${invoice.token}` });
    expect(String(call!.body!.reference_id)).toMatch(/^INV-2026-0001-[0-9a-f]{8}$/);
    expect(call!.body!.description).toBe("Invoice INV-2026-0001 from Example Consulting");

    // In the bucket: one PDF under an unguessable name, saying what the invoice says.
    expect(invoice.pdfKey).toMatch(new RegExp(`^${INVOICE_ROOT}/20\\d\\d/${draft.id}/[0-9a-f-]{36}\\.pdf$`));
    const pdf = storedPdf(draft.id);
    for (const s of ["(INV-2026-0001)", "(Example Consulting)", "(GST Reg. No. M1234567X)", "(Ada Lovelace)", "(USD 4,659.75)", "(GST \\(9%\\))", "(View this invoice and pay online)", `/URI (https://jithendar.com/invoice/${invoice.token})`]) expect(pdf, s).toContain(s);

    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: "ada@example.test", subject: "Invoice INV-2026-0001 from Example Consulting" });
    expect(mails[0]!.body).toContain(`https://jithendar.com/invoice/${invoice.token}`);
    expect(mails[0]!.body).toContain("USD 4,659.75, due on 29 Nov 2026");
    expect(mails[0]!.body).toContain("pay online");

    // Sent means settled: no edits, no second send, no delete.
    await expect(updateInvoice(admin, draft.id, input())).rejects.toThrow(/cannot be changed/);
    await expect(sendInvoice(admin, draft.id, razorpay)).rejects.toThrow(/already been sent/);
    await expect(deleteInvoice(admin, draft.id)).rejects.toThrow(/Void this invoice/);
    expect(created()).toHaveLength(1);
  });

  it("gives numbers in order, one sequence per year, and a failed send keeps its number without leaving anything behind", async () => {
    const a = await createInvoice(admin, input());
    const b = await createInvoice(admin, input({ clientName: "Grace Hopper" }));
    const next = await createInvoice(admin, input({ issueDate: "2027-01-02" }));

    createFails = "Currency is not enabled for this account";
    await expect(sendInvoice(admin, a.id, razorpay)).rejects.toThrow(/Razorpay did not create the payment link: Currency is not enabled/);
    // Still a draft, now holding INV-2026-0001; the PDF that was uploaded first is gone again and nobody was emailed.
    expect(await getInvoice(a.id)).toMatchObject({ status: "draft", number: "INV-2026-0001", pdfKey: null, paymentLinkId: null, sentAt: null });
    expect(objects.size).toBe(0);
    expect(mails).toHaveLength(0);
    await expect(deleteInvoice(admin, a.id)).rejects.toThrow(/Void this invoice/);

    createFails = null;
    expect((await sendInvoice(admin, b.id, razorpay)).invoice.number).toBe("INV-2026-0002");
    expect((await sendInvoice(admin, a.id, razorpay)).invoice.number).toBe("INV-2026-0001");
    expect((await sendInvoice(admin, next.id, razorpay)).invoice.number).toBe("INV-2027-0001");
    expect(objects.size).toBe(3);
  });

  it("needs the business name and storage, and reports an email that did not go out", async () => {
    const draft = await createInvoice(admin, input());
    await saveInvoiceSettings(admin, settings({ businessName: "" }));
    await expect(sendInvoice(admin, draft.id, razorpay)).rejects.toThrow(/business name/);
    await saveInvoiceSettings(admin, settings());
    storageUp = false;
    await expect(sendInvoice(admin, draft.id, razorpay)).rejects.toThrow(/Connect file storage/);
    expect(await getInvoice(draft.id)).toMatchObject({ status: "draft", number: null });
    expect(calls).toHaveLength(0);

    storageUp = true;
    mailWorks = false;
    const r = await sendInvoice(admin, draft.id, razorpay);
    expect(r).toMatchObject({ emailed: false, online: true });
    expect(await getInvoice(draft.id)).toMatchObject({ status: "sent", emailedAt: null });
    mailWorks = true;
    expect(await resendInvoice(admin, draft.id)).toBe(true);
    expect((await getInvoice(draft.id))!.emailedAt).toBeInstanceOf(Date);
    expect(mails).toHaveLength(1);
  });

  it("goes out without a payment link when Razorpay is not connected or online payment is off, and gets one later", async () => {
    env = {};
    const first = await createInvoice(admin, input());
    const sent = await sendInvoice(admin, first.id, razorpay);
    expect(sent).toMatchObject({ online: false, emailed: true });
    expect(sent.invoice).toMatchObject({ status: "sent", paymentLinkId: null, paymentLinkUrl: null });
    expect(calls).toHaveLength(0);
    expect(storedPdf(first.id)).toContain("(View this invoice online)");
    expect(mails[0]!.body).not.toContain("pay online");
    expect((await clientInvoice(sent.invoice.token))!.payUrl).toBeNull();

    await expect(renewPaymentLink(admin, first.id, razorpay)).rejects.toThrow(/not connected/);
    env = { ...KEYS };
    const linked = await renewPaymentLink(admin, first.id, razorpay);
    expect(linked).toMatchObject({ paymentLinkId: "plink_TEST1", paymentLinkStatus: "created" });
    expect((await clientInvoice(linked.token))!.payUrl).toBe("https://rzp.io/i/test1");
    expect(storedPdf(first.id)).toContain("(View this invoice and pay online)");

    await saveInvoiceSettings(admin, settings({ onlinePayment: "" }));
    const second = await createInvoice(admin, input());
    expect((await sendInvoice(admin, second.id, razorpay)).online).toBe(false);
    expect(created()).toHaveLength(1);
  });
});

describe("getting paid", () => {
  async function sentInvoice(patch: Record<string, unknown> = {}) {
    const draft = await createInvoice(admin, input(patch));
    const { invoice } = await sendInvoice(admin, draft.id, razorpay);
    mails.length = 0;
    return invoice;
  }

  it("webhook payment_link.paid marks it paid once, re-renders the PDF, thanks the client and tells the admins", async () => {
    const inv = await sentInvoice();
    const forged = paidEvent(inv.paymentLinkId!);
    expect((await deliver(forged, "attacker-secret-xx")).status).toBe(401);
    expect(await deliver(paidEvent(inv.paymentLinkId!, { amount_paid: 100 }))).toEqual({ status: 200, body: "Amount mismatch; not recorded." });
    expect(await deliver(paidEvent(inv.paymentLinkId!, { currency: "INR" }))).toEqual({ status: 200, body: "Amount mismatch; not recorded." });
    expect(await deliver(paidEvent("plink_SOMEONEELSE"))).toEqual({ status: 200, body: "Ignored." });
    expect((await getInvoice(inv.id))!.status).toBe("sent");

    expect(await deliver(paidEvent(inv.paymentLinkId!))).toEqual({ status: 200, body: "OK." });
    const paid = (await getInvoice(inv.id))!;
    expect(paid).toMatchObject({ status: "paid", paidVia: "razorpay", paymentId: "pay_WHPAID0001", paymentLinkStatus: "paid", pdfStatus: "paid" });
    expect(paid.paidAt).toBeInstanceOf(Date);
    const pdf = storedPdf(inv.id);
    expect(pdf).toContain("(PAID)");
    expect(pdf).toContain("(Balance due)");
    expect(pdf).not.toContain("/Subtype /Link");
    expect(paid.pdfKey).not.toBe(inv.pdfKey);
    expect(mails.map((m) => [m.to, m.subject])).toEqual([
      ["ada@example.test", "Payment received for invoice INV-2026-0001"],
      ["admin@example.test", "[Invoice paid] INV-2026-0001 · USD 4,659.75 · Ada Lovelace"],
    ]);

    // Razorpay retries deliveries: the second one changes nothing and emails nobody.
    expect(await deliver(paidEvent(inv.paymentLinkId!, {}, "pay_WHPAID0002"))).toEqual({ status: 200, body: "OK." });
    expect((await getInvoice(inv.id))!.paymentId).toBe("pay_WHPAID0001");
    expect(mails).toHaveLength(2);
    const view = (await clientInvoice(inv.token))!;
    expect(view.payUrl).toBeNull();
    expect(view.document.summary.label).toBe("Paid");
  });

  it("the signed address Razorpay sends the client back to marks it paid; anything else does not", async () => {
    const inv = await sentInvoice();
    const linkId = inv.paymentLinkId!;
    const ref = "INV-2026-0001-ab12cd34";
    const back = (patch: Record<string, string> = {}) => {
      const p = { razorpay_payment_id: "pay_RETURN00001", razorpay_payment_link_id: linkId, razorpay_payment_link_reference_id: ref, razorpay_payment_link_status: "paid", ...patch };
      return { ...p, razorpay_signature: hmac(KEY_SECRET, `${p.razorpay_payment_link_id}|${p.razorpay_payment_link_reference_id}|${p.razorpay_payment_link_status}|${p.razorpay_payment_id}`) };
    };
    expect(await confirmInvoiceReturn(inv.token, { ...back(), razorpay_signature: "0".repeat(64) })).toBe(false);
    expect(await confirmInvoiceReturn(inv.token, { ...back(), razorpay_payment_id: "pay_SOMEONEELSE1" })).toBe(false); // signed for another payment
    expect(await confirmInvoiceReturn(inv.token, back({ razorpay_payment_link_status: "partially_paid" }))).toBe(false);
    expect(await confirmInvoiceReturn(inv.token, back({ razorpay_payment_link_id: "plink_OTHER" }))).toBe(false); // a real signature for another link
    expect(await confirmInvoiceReturn("x".repeat(43), back())).toBe(false);
    expect((await getInvoice(inv.id))!.status).toBe("sent");

    expect(await confirmInvoiceReturn(inv.token, back())).toBe(true);
    expect(await getInvoice(inv.id)).toMatchObject({ status: "paid", paidVia: "razorpay", paymentId: "pay_RETURN00001" });
    // The webhook for the same payment arrives afterwards: nothing changes, and a reload of the address still says thanks.
    await deliver(paidEvent(linkId));
    expect(await confirmInvoiceReturn(inv.token, back())).toBe(true);
    expect((await getInvoice(inv.id))!.paymentId).toBe("pay_RETURN00001");
    expect(mails.filter((m) => m.subject.startsWith("[Invoice paid]"))).toHaveLength(1);
  });

  it("an admin records a bank transfer: the payment link is cancelled first, and an online payment is never overwritten", async () => {
    const inv = await sentInvoice();
    cancelFails = true;
    await expect(markInvoicePaid(admin, inv.id, "Bank transfer", razorpay)).rejects.toThrow(/could not be cancelled/);
    expect((await getInvoice(inv.id))!.status).toBe("sent");

    cancelFails = false;
    const r = await markInvoicePaid(admin, inv.id, "  Bank transfer,\nref 4411  ", razorpay);
    expect(r).toMatchObject({ alreadyOnline: false, linkOpen: false });
    expect(r.invoice).toMatchObject({ status: "paid", paidVia: "manual", paymentNote: "Bank transfer, ref 4411", paymentId: null, paymentLinkStatus: "cancelled" });
    expect(links.get(inv.paymentLinkId!)!.status).toBe("cancelled");
    expect(storedPdf(inv.id)).toContain("(PAID)");
    expect(mails).toHaveLength(0); // the admin did it; nobody is emailed until they press "Email the receipt"
    expect(await resendInvoice(admin, inv.id)).toBe(true);
    expect(mails[0]!.subject).toBe("Payment received for invoice INV-2026-0001");

    // The client paid online a moment before the admin pressed the button: Razorpay refuses to cancel, and the
    // invoice is recorded as the Razorpay payment it was.
    const other = await sentInvoice({ clientName: "Grace Hopper" });
    Object.assign(links.get(other.paymentLinkId!)!, { status: "paid", paymentId: "pay_JUSTPAID0001" });
    const late = await markInvoicePaid(admin, other.id, "Cheque", razorpay);
    expect(late.alreadyOnline).toBe(true);
    expect(late.invoice).toMatchObject({ status: "paid", paidVia: "razorpay", paymentId: "pay_JUSTPAID0001", paymentNote: null });
  });

  it("void cancels the payment link and keeps the number; paid invoices and online payments are not voided", async () => {
    const inv = await sentInvoice();
    const voided = await voidInvoice(admin, inv.id, razorpay);
    expect(voided).toMatchObject({ status: "void", number: "INV-2026-0001", paymentLinkStatus: "cancelled" });
    expect(links.get(inv.paymentLinkId!)!.status).toBe("cancelled");
    expect(storedPdf(inv.id)).toContain("(VOID)");
    const view = (await clientInvoice(inv.token))!;
    expect(view.payUrl).toBeNull();
    expect(view.document.summary.note).toMatch(/cancelled/);
    await expect(markInvoicePaid(admin, inv.id, "", razorpay)).rejects.toThrow(/Only a sent, unpaid invoice/);
    // A payment for a voided invoice (it should be impossible) is not recorded as paid, and the admins hear of it.
    expect(await deliver(paidEvent(inv.paymentLinkId!))).toEqual({ status: 200, body: "OK." });
    expect((await getInvoice(inv.id))!.status).toBe("void");
    expect(mails.map((m) => m.subject)).toEqual(["[Invoice] Payment received for voided invoice INV-2026-0001"]);

    const paid = await sentInvoice({ clientName: "Grace Hopper" });
    await deliver(paidEvent(paid.paymentLinkId!));
    await expect(voidInvoice(admin, paid.id, razorpay)).rejects.toThrow(/paid invoice cannot be voided/);

    const racing = await sentInvoice({ clientName: "Katherine Johnson" });
    Object.assign(links.get(racing.paymentLinkId!)!, { status: "paid", paymentId: "pay_JUSTPAID0002" });
    await expect(voidInvoice(admin, racing.id, razorpay)).rejects.toThrow(/just paid this invoice online/);
    expect(await getInvoice(racing.id)).toMatchObject({ status: "paid", paymentId: "pay_JUSTPAID0002" });

    // The next number is not reused after a void.
    const after = await createInvoice(admin, input());
    expect((await sendInvoice(admin, after.id, razorpay)).invoice.number).toBe("INV-2026-0004");
  });

  it("a link that expired or was cancelled in Razorpay takes the Pay button away until a new one is made", async () => {
    const inv = await sentInvoice();
    const expired = JSON.stringify({ event: "payment_link.expired", payload: { payment_link: { entity: { id: inv.paymentLinkId, status: "expired" } } } });
    expect(await deliver(expired)).toEqual({ status: 200, body: "OK." });
    expect(await getInvoice(inv.id)).toMatchObject({ status: "sent", paymentLinkStatus: "expired" });
    expect((await clientInvoice(inv.token))!.payUrl).toBeNull();
    links.get(inv.paymentLinkId!)!.status = "expired";

    const renewed = await renewPaymentLink(admin, inv.id, razorpay);
    expect(renewed).toMatchObject({ paymentLinkId: "plink_TEST2", paymentLinkStatus: "created" });
    expect((await clientInvoice(inv.token))!.payUrl).toBe("https://rzp.io/i/test2");
    // The old link's events no longer touch the invoice.
    expect(await deliver(paidEvent(inv.paymentLinkId!))).toEqual({ status: 200, body: "Ignored." });
    expect((await getInvoice(inv.id))!.status).toBe("sent");
  });
});

describe("the client's link and the PDF", () => {
  it("shows a sent invoice to whoever has the token, with what is owed and where to pay", async () => {
    const draft = await createInvoice(admin, input({ issueDate: "2020-01-01", dueDate: "2020-01-15" }));
    const { invoice } = await sendInvoice(admin, draft.id, razorpay);
    const view = (await clientInvoice(invoice.token))!;
    expect(view).toMatchObject({ payUrl: "https://rzp.io/i/test1", overdue: true });
    expect(view.document).toMatchObject({ number: "INV-2020-0001", status: "sent", issueDate: "1 Jan 2020", dueDate: "15 Jan 2020", summary: { label: "Amount due", value: "USD 4,659.75" } });
    expect(view.document.seller).toEqual({ name: "Example Consulting", lines: ["1 Example Road", "Singapore 123456", "billing@example.test", "GST Reg. No. M1234567X"] });
    expect(view.document.client).toEqual({ name: "Ada Lovelace", lines: ["Analytical Engines Ltd", "1 Babbage Street", "London", "ada@example.test"] });
    expect(view.document.totals).toEqual([{ label: "Subtotal", value: "4,275.00" }, { label: "GST (9%)", value: "384.75" }, { label: "Total", value: "USD 4,659.75", strong: true }]);
    for (const token of ["", "short", invoice.token.slice(0, 42), `${invoice.token}x`, "../../admin"]) expect(await clientInvoice(token), token).toBeNull();

    // Changing the business details later does not rewrite an invoice that was already sent.
    await saveInvoiceSettings(admin, settings({ businessName: "Renamed Ltd" }));
    expect((await clientInvoice(invoice.token))!.document.seller.name).toBe("Example Consulting");
  });

  it("downloads the stored copy, renders and stores it again when it is missing, and never stores a draft preview", async () => {
    const draft = await createInvoice(admin, input());
    const preview = await invoicePdfFile(draft);
    expect(preview).toMatchObject({ filename: "draft-invoice.pdf", stored: false });
    expect(pdfText(preview.bytes)).toContain("(DRAFT INVOICE)");
    expect(objects.size).toBe(0);

    const { invoice } = await sendInvoice(admin, draft.id, razorpay);
    const file = await invoicePdfFile(invoice);
    expect(file).toMatchObject({ filename: "INV-2026-0001.pdf", stored: true });
    expect(Buffer.from(file.bytes).equals(objects.get(invoice.pdfKey!)!)).toBe(true);

    objects.clear(); // someone emptied the bucket
    const again = await invoicePdfFile(invoice);
    expect(again.stored).toBe(true);
    expect(storedPdf(invoice.id)).toContain("(INV-2026-0001)");
    expect((await getInvoice(invoice.id))!.pdfKey).not.toBe(invoice.pdfKey);

    storageUp = false; // storage is down: the client still gets their invoice
    const direct = await invoicePdfFile((await getInvoice(invoice.id))!);
    expect(direct.stored).toBe(false);
    expect(pdfText(direct.bytes)).toContain("(INV-2026-0001)");
  });

  it("lists and counts by state, with what is owed per currency", async () => {
    const a = await createInvoice(admin, input());
    const b = await createInvoice(admin, input({ currency: "INR", issueDate: "2020-01-01", dueDate: "2020-01-15" }));
    await createInvoice(admin, input());
    const sentA = (await sendInvoice(admin, a.id, razorpay)).invoice;
    await sendInvoice(admin, b.id, razorpay);
    await deliver(paidEvent(sentA.paymentLinkId!));
    const summary = await invoiceSummary("2026-11-15");
    expect(summary.counts).toEqual({ draft: 1, sent: 1, paid: 1, void: 0 });
    expect(summary.overdue).toBe(1);
    expect(summary.outstanding).toEqual([{ currency: "INR", total: TOTAL }]);
    expect(summary.paid).toEqual([{ currency: "USD", total: TOTAL }]);
    expect((await listInvoices("unpaid")).map((r) => r.id)).toEqual([b.id]);
    expect((await listInvoices("overdue", "2026-11-15")).map((r) => r.id)).toEqual([b.id]);
    expect((await listInvoices("overdue", "2020-01-10")).map((r) => r.id)).toEqual([]);
    expect(await listInvoices("paid")).toHaveLength(1);
    expect(await listInvoices("all")).toHaveLength(3);
  });

  it("leaves a trail in the audit log, without the client's details", async () => {
    const draft = await createInvoice(admin, input());
    const { invoice } = await sendInvoice(admin, draft.id, razorpay);
    await voidInvoice(admin, invoice.id, razorpay);
    const db = await getDb();
    const entries = await db.select().from(schema.auditLog).where(eq(schema.auditLog.target, draft.id));
    expect(entries.map((e) => e.action).sort()).toEqual(["invoice.create", "invoice.send", "invoice.void"]);
    expect(entries.every((e) => e.severity === "notice")).toBe(true);
    expect(JSON.stringify(entries.map((e) => e.detail))).not.toMatch(/ada@example\.test|Babbage/);
  });

  it("keeps the client's link out of maintenance mode and its token out of the logs", async () => {
    const { MAINTENANCE_EXEMPT } = await import("@/lib/site-config/maintenance");
    const { loggedPath } = await import("@/lib/request-log");
    expect(MAINTENANCE_EXEMPT.test("/invoice/abc")).toBe(true);
    expect(MAINTENANCE_EXEMPT.test("/invoices")).toBe(false);
    expect(loggedPath("/invoice/kJ8sQ2xYb7Lr0PzVn4TqWm1Ue9Ac3Df6Gh5Ij8Kl2Mo")).toBe("/invoice/:token");
    expect(loggedPath("/invoice/kJ8sQ2xYb7Lr0PzVn4TqWm1Ue9Ac3Df6Gh5Ij8Kl2Mo/pdf")).toBe("/invoice/:token/pdf");
    expect(loggedPath("/admin/invoices/3f0c")).toBe("/admin/invoices/3f0c");
  });
});
