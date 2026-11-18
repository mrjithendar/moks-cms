import { describe, expect, it } from "vitest";
import {
  addDays,
  formatAmount,
  formatDate,
  formatHundredths,
  formatMoney,
  formatRate,
  invoiceNumber,
  invoiceTotals,
  isIsoDate,
  isOverdue,
  lineAmount,
  parseHundredths,
  taxOn,
  todayIn,
} from "@/lib/invoice-math";
import { renderInvoicePdf, textWidth, winAnsi, wrap, type InvoicePdfInput } from "@/lib/invoice-pdf";

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");

const doc = (patch: Partial<InvoicePdfInput> = {}): InvoicePdfInput => ({
  number: "INV-2026-0007",
  status: "sent",
  issueDate: "15 Nov 2026",
  dueDate: "29 Nov 2026",
  seller: { name: "Example Consulting", lines: ["1 Example Road", "Singapore 123456", "billing@example.test"] },
  client: { name: "Ada Lovelace", lines: ["Analytical Engines Ltd", "ada@example.test"] },
  items: [{ description: "Platform review", quantity: "12.5", unitPrice: "150.00", amount: "1,875.00" }],
  totals: [{ label: "Subtotal", value: "1,875.00" }, { label: "Total", value: "USD 1,875.00", strong: true }],
  summary: { label: "Amount due", value: "USD 1,875.00", note: "Due 29 Nov 2026" },
  link: { label: "View this invoice and pay online", url: "https://example.test/invoice/abc" },
  ...patch,
});

describe("invoice arithmetic (integers only)", () => {
  it("reads amounts, quantities and rates typed with at most two decimals", () => {
    expect(parseHundredths("1,500.50")).toBe(150_050);
    expect(parseHundredths(" 12 ")).toBe(1_200);
    expect(parseHundredths("1.5")).toBe(150);
    expect(parseHundredths("0")).toBe(0);
    for (const bad of ["", "abc", "-1", "1.234", "1e3", "1.", ".5", "1 000 000 0000"]) expect(parseHundredths(bad), bad).toBeNull();
  });

  it("rounds a line and the tax half up, without floating point", () => {
    expect(lineAmount(150, 3_333)).toBe(5_000); // 1.5 × 33.33 = 49.995 → 50.00
    expect(lineAmount(1, 50)).toBe(1); // 0.01 × 0.50 = 0.005 → 0.01
    expect(lineAmount(1, 49)).toBe(0);
    expect(lineAmount(10_000_000, 1_000_000_000)).toBe(100_000_000_000_000); // beyond 2^53 before dividing
    expect(taxOn(10_005, 900)).toBe(900); // 9.0045 → 9.00
    expect(taxOn(10_006, 900)).toBe(901); // 9.0054 → 9.01
    expect(taxOn(50, 100)).toBe(1); // 0.005 → 0.01
    expect(invoiceTotals([{ quantity: 1_250, unitPrice: 15_000 }, { quantity: 200, unitPrice: 120_000 }], 900)).toEqual({ lines: [187_500, 240_000], subtotal: 427_500, taxAmount: 38_475, total: 465_975 });
  });

  it("formats money with the ISO code, quantities and rates without trailing zeros, dates unambiguously", () => {
    expect(formatAmount(150_050)).toBe("1,500.50");
    expect(formatAmount(5)).toBe("0.05");
    expect(formatAmount(123_456_789_012)).toBe("1,234,567,890.12");
    expect(formatMoney(150_000, "INR")).toBe("INR 1,500.00");
    expect([100, 150, 125, 5].map(formatHundredths)).toEqual(["1", "1.5", "1.25", "0.05"]);
    expect(formatRate(900)).toBe("9%");
    expect(formatRate(825)).toBe("8.25%");
    expect(formatDate("2026-11-05")).toBe("5 Nov 2026");
    expect(formatDate("soon")).toBe("soon");
    expect(invoiceNumber("INV", 2026, 7)).toBe("INV-2026-0007");
    expect(invoiceNumber("INV", 2026, 12_345)).toBe("INV-2026-12345");
  });

  it("works with calendar dates in the site's time zone", () => {
    expect(isIsoDate("2026-02-28")).toBe(true);
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("28/02/2026")).toBe(false);
    expect(addDays("2026-12-25", 14)).toBe("2027-01-08");
    expect(todayIn("Asia/Singapore", new Date("2026-11-14T17:30:00Z"))).toBe("2026-11-15");
    expect(todayIn("America/Los_Angeles", new Date("2026-11-15T02:00:00Z"))).toBe("2026-11-14");
    expect(todayIn("Not/AZone", new Date("2026-11-15T02:00:00Z"))).toBe("2026-11-15");
    expect(isOverdue("sent", "2026-11-14", "2026-11-15")).toBe(true);
    expect(isOverdue("sent", "2026-11-15", "2026-11-15")).toBe(false);
    expect(isOverdue("paid", "2026-11-14", "2026-11-15")).toBe(false);
  });
});

describe("invoice PDF text", () => {
  it("encodes what Helvetica has, and stands in for what it does not", () => {
    expect(winAnsi("Aé")).toEqual([65, 233]);
    expect(winAnsi("€—")).toEqual([0x80, 0x97]);
    expect(winAnsi("₹5")).toEqual([82, 115, 46, 53]); // "Rs.5"
    expect(winAnsi("ś")).toEqual([115]); // the letter without its accent
    expect(winAnsi("日")).toEqual([63]); // "?"
    expect(winAnsi("a\u0000b")).toEqual([97, 98]);
  });

  it("measures with Helvetica's widths and wraps at spaces, line breaks and, if it must, inside a word", () => {
    expect(textWidth("Hello", "F1", 10)).toBeCloseTo(22.78, 2);
    expect(textWidth("Hello", "F2", 10)).toBeGreaterThan(textWidth("Hello", "F1", 10));
    expect(wrap("one two three", "F1", 10, 40)).toEqual(["one two", "three"]);
    expect(wrap("x\n\ny", "F1", 10, 100)).toEqual(["x", "", "y"]);
    const cut = wrap("https://example.test/a-very-long-address-without-any-space", "F1", 10, 60);
    expect(cut.length).toBeGreaterThan(1);
    expect(cut.join("")).toBe("https://example.test/a-very-long-address-without-any-space");
    expect(wrap("a b", "F1", 10, 1)).toEqual(["a", "b"]); // narrower than a letter: still ends
  });
});

describe("invoice PDF file", () => {
  it("is a well-formed PDF: every object is where the cross-reference table says", () => {
    const pdf = text(renderInvoicePdf(doc()));
    expect(pdf.startsWith("%PDF-1.4\n")).toBe(true);
    expect(pdf.endsWith("%%EOF\n")).toBe(true);
    const start = Number(/startxref\n(\d+)\n%%EOF/.exec(pdf)?.[1]);
    expect(pdf.slice(start, start + 4)).toBe("xref");
    const table = /xref\n0 (\d+)\n([\s\S]*?)trailer/.exec(pdf.slice(start));
    const entries = (table?.[2] ?? "").trim().split("\n");
    expect(entries).toHaveLength(Number(table?.[1]));
    entries.slice(1).forEach((entry, i) => {
      const offset = Number(entry.slice(0, 10));
      expect(pdf.slice(offset, offset + `${i + 1} 0 obj`.length), `object ${i + 1}`).toBe(`${i + 1} 0 obj`);
    });
    // Each content stream is exactly as long as it says.
    for (const m of pdf.matchAll(/<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/g)) expect(m[2]!.length).toBe(Number(m[1]));
  });

  it("carries the invoice's words, a clickable link, and the same bytes for the same invoice", () => {
    const pdf = text(renderInvoicePdf(doc()));
    for (const s of ["(INV-2026-0007)", "(Example Consulting)", "(Ada Lovelace)", "(Platform review)", "(USD 1,875.00)", "(AMOUNT DUE)", "(Page 1 of 1)"]) expect(pdf, s).toContain(s);
    expect(pdf).toContain("/Subtype /Link");
    expect(pdf).toContain("/URI (https://example.test/invoice/abc)");
    expect(text(renderInvoicePdf(doc()))).toBe(pdf);
    expect(pdf).not.toContain("/CreationDate");
    expect(text(renderInvoicePdf(doc({ createdAt: new Date("2026-11-15T10:00:00Z") })))).toContain("/CreationDate (D:20261115100000Z)");
  });

  it("escapes brackets and backslashes, and writes accented letters as octal", () => {
    const pdf = text(renderInvoicePdf(doc({ client: { name: "ACME (India) \\ Café", lines: [] } })));
    expect(pdf).toContain("(ACME \\(India\\) \\\\ Caf\\351)");
    // Nothing outside ASCII after the binary marker on line two.
    expect(/[^\x00-\x7f]/.test(pdf.slice(pdf.indexOf("\n", 9) + 1))).toBe(false);
  });

  it("shows paid and void, and leaves the link out once nothing is due", () => {
    const paid = text(renderInvoicePdf(doc({ status: "paid", link: undefined, summary: { label: "Paid", value: "USD 1,875.00", note: "15 Nov 2026" } })));
    expect(paid).toContain("(PAID)");
    expect(paid).not.toContain("/Subtype /Link");
    expect(text(renderInvoicePdf(doc({ status: "void", link: undefined, summary: { label: "Void", value: "USD 1,875.00" } })))).toContain("(VOID)");
    expect(text(renderInvoicePdf(doc({ status: "draft", number: "DRAFT", link: undefined })))).toContain("(DRAFT INVOICE)");
  });

  it("continues on more pages, repeating the column headings and never splitting a line", () => {
    const items = Array.from({ length: 60 }, (_, i) => ({ description: `Line ${i + 1}: support hours for the week, including on-call cover`, quantity: "1.5", unitPrice: "150.00", amount: "225.00" }));
    const pdf = text(renderInvoicePdf(doc({ items, notes: "Thank you.", footer: "Bank transfer details. ".repeat(60) })));
    const pages = Number(/\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/.exec(pdf)?.[1]);
    expect(pages).toBeGreaterThan(2);
    expect(pdf.match(/\(DESCRIPTION\)/g)!.length).toBeGreaterThan(1);
    expect(pdf.match(/\(DESCRIPTION\)/g)!.length).toBeLessThanOrEqual(pages);
    for (let i = 1; i <= 60; i++) expect(pdf.match(new RegExp(`\\(Line ${i}: `, "g")), `line ${i}`).toHaveLength(1);
    expect(pdf).toContain(`(Page ${pages} of ${pages})`);
    // The first page has one set of headings, drawn below the letterhead (not at the top of the page).
    const first = /stream\n([\s\S]*?)\nendstream/.exec(pdf)?.[1] ?? "";
    expect(first.match(/\(DESCRIPTION\)/g)).toHaveLength(1);
    expect(first.indexOf("(Example Consulting)")).toBeLessThan(first.indexOf("(DESCRIPTION)"));
  });
});
