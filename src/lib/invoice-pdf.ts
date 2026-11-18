/**
 * The invoice as a PDF, written by hand: no PDF library is installed and this one page layout does not need one.
 *
 * - A4, the two built-in fonts every PDF reader has (Helvetica and Helvetica-Bold, WinAnsi encoding), so nothing is
 *   embedded and the file is a few kilobytes. Characters those fonts do not have (₹, CJK, emoji) cannot be drawn:
 *   accents that have a plain form lose the accent and anything else becomes "?". Amounts therefore use ISO currency
 *   codes ("INR 1,500.00"), never symbols.
 * - Pure: text in, bytes out. No clock and no randomness unless `createdAt` is given, so the same invoice always
 *   renders to the same bytes (tests compare them).
 * - The address of the client's page is a real link (a /Link annotation), so the client can click it in the PDF.
 */

export type InvoicePdfInput = {
  /** "INV-2026-0007", or "DRAFT" for a preview. */
  number: string;
  status: "draft" | "sent" | "paid" | "void";
  /** Already formatted for reading ("5 Nov 2026"). */
  issueDate: string;
  dueDate: string;
  seller: { name: string; lines: string[] };
  client: { name: string; lines: string[] };
  items: { description: string; quantity: string; unitPrice: string; amount: string }[];
  /** Bottom-right rows, in order: subtotal, tax, total, … `strong` rows are bold with a rule above. */
  totals: { label: string; value: string; strong?: boolean }[];
  /** Next to the client: "Amount due" with the total, or "Paid" / "Void". */
  summary: { label: string; value: string; note?: string };
  /** The client's page, as a clickable line while the invoice is waiting for payment. */
  link?: { label: string; url: string };
  notes?: string;
  /** Payment instructions and terms from the settings, at the end of the invoice. */
  footer?: string;
  createdAt?: Date;
};

// --- Text: Unicode → WinAnsi bytes, and how wide they are ---------------------------------------------------------

/** Windows-1252 code points 0x80–0x9F that differ from Latin-1. */
const CP1252: Record<string, number> = {
  "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87, "ˆ": 0x88, "‰": 0x89, "Š": 0x8a, "‹": 0x8b, "Œ": 0x8c, "Ž": 0x8e,
  "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "˜": 0x98, "™": 0x99, "š": 0x9a, "›": 0x9b, "œ": 0x9c, "ž": 0x9e, "Ÿ": 0x9f,
};

/** Readable stand-ins for common characters the built-in fonts lack. */
const SUBSTITUTE: Record<string, string> = { "₹": "Rs.", "₨": "Rs.", "→": "->", "←": "<-", "≤": "<=", "≥": ">=", "−": "-", "‐": "-", "‑": "-", "‒": "-", "―": "-", " ": " ", " ": " ", " ": " ", "\t": "    " };

/** The bytes of `text` in WinAnsi. Line breaks are the caller's job (see wrap). */
export function winAnsi(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const sub = SUBSTITUTE[ch];
    if (sub !== undefined) {
      for (const c of sub) out.push(c.charCodeAt(0));
      continue;
    }
    const code = ch.codePointAt(0) ?? 63;
    if ((code >= 32 && code <= 126) || (code >= 161 && code <= 255)) out.push(code);
    else if (CP1252[ch] !== undefined) out.push(CP1252[ch]);
    else if (code < 32 || (code >= 127 && code <= 160)) continue; // control characters draw nothing
    else {
      // "ś" → "s", "Ł" stays unknown: keep what the fonts can draw of the decomposed form.
      const plain = [...ch.normalize("NFKD")].filter((c) => {
        const k = c.codePointAt(0) ?? 0;
        return k >= 32 && k <= 126;
      });
      if (plain.length > 0) for (const c of plain) out.push(c.charCodeAt(0));
      else if (!/\p{M}/u.test(ch)) out.push(63); // "?"; a lone combining mark is dropped
    }
  }
  return out;
}

// Advance widths (1/1000 em) of codes 32–126 from Adobe's Helvetica and Helvetica-Bold metrics.
const W_REGULAR = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const W_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];
/** Codes above 126 that are not an accented letter (those take their base letter's width). */
const W_HIGH: Record<number, number> = {
  0x80: 556, 0x82: 222, 0x83: 556, 0x84: 333, 0x85: 1000, 0x86: 556, 0x87: 556, 0x88: 333, 0x89: 1000, 0x8a: 667, 0x8b: 333, 0x8c: 1000, 0x8e: 611,
  0x91: 222, 0x92: 222, 0x93: 333, 0x94: 333, 0x95: 350, 0x96: 556, 0x97: 1000, 0x98: 333, 0x99: 1000, 0x9a: 500, 0x9b: 333, 0x9c: 944, 0x9e: 500, 0x9f: 667,
  0xa1: 333, 0xa2: 556, 0xa3: 556, 0xa4: 556, 0xa5: 556, 0xa6: 260, 0xa7: 556, 0xa8: 333, 0xa9: 737, 0xaa: 370, 0xab: 556, 0xac: 584, 0xad: 333, 0xae: 737, 0xaf: 333,
  0xb0: 400, 0xb1: 584, 0xb2: 333, 0xb3: 333, 0xb4: 333, 0xb5: 556, 0xb6: 537, 0xb7: 278, 0xb8: 333, 0xb9: 333, 0xba: 365, 0xbb: 556, 0xbc: 834, 0xbd: 834, 0xbe: 834, 0xbf: 611,
  0xc6: 1000, 0xd0: 722, 0xd7: 584, 0xd8: 778, 0xde: 667, 0xdf: 611, 0xe6: 889, 0xf0: 556, 0xf7: 584, 0xf8: 611, 0xfe: 556,
};

type Font = "F1" | "F2";

function codeWidth(code: number, font: Font): number {
  const table = font === "F2" ? W_BOLD : W_REGULAR;
  if (code >= 32 && code <= 126) return table[code - 32] ?? 556;
  const high = W_HIGH[code];
  if (high !== undefined) return high;
  // À–ÿ: the width of the letter under the accent.
  const base = String.fromCharCode(code).normalize("NFD").charCodeAt(0);
  return base >= 32 && base <= 126 ? (table[base - 32] ?? 556) : 556;
}

/** Width of `text` in points at `size`. */
export function textWidth(text: string, font: Font, size: number): number {
  let units = 0;
  for (const code of winAnsi(text)) units += codeWidth(code, font);
  return (units * size) / 1000;
}

/** Break `text` into lines no wider than `width`: at spaces, at its own line breaks, and inside a word only if it must. */
export function wrap(text: string, font: Font, size: number, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r\n?/g, "\n").split("\n")) {
    let line = "";
    for (const word of paragraph.split(/[ \t]+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (textWidth(candidate, font, size) <= width) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      line = word;
      // A single word wider than the column (a long URL): cut it where it stops fitting.
      while (textWidth(line, font, size) > width) {
        const chars = [...line];
        if (chars.length <= 1) break;
        let cut = chars.length - 1;
        while (cut > 1 && textWidth(chars.slice(0, cut).join(""), font, size) > width) cut--;
        lines.push(chars.slice(0, cut).join(""));
        line = chars.slice(cut).join("");
      }
    }
    lines.push(line);
  }
  // No blank lines at the end; blank lines inside are kept (they separate paragraphs).
  while (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** A PDF literal string: WinAnsi bytes, with the three special characters and everything outside ASCII escaped. */
function literal(text: string): string {
  let out = "(";
  for (const code of winAnsi(text)) {
    if (code === 40 || code === 41 || code === 92) out += `\\${String.fromCharCode(code)}`;
    else if (code > 126) out += `\\${code.toString(8).padStart(3, "0")}`;
    else out += String.fromCharCode(code);
  }
  return `${out})`;
}

// --- Page drawing ---------------------------------------------------------------------------------------------------

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const LEFT = 50;
const RIGHT = PAGE_W - 50;
const TOP = 54;
/** Content stops here; the page footer sits below. */
const BOTTOM = PAGE_H - 70;

type Rgb = [number, number, number];
const INK: Rgb = [0.09, 0.11, 0.15];
const MUTED: Rgb = [0.4, 0.44, 0.5];
const RULE: Rgb = [0.84, 0.86, 0.89];
const BAND: Rgb = [0.955, 0.96, 0.97];
const LINK: Rgb = [0.1, 0.33, 0.78];
const GOOD: Rgb = [0.04, 0.47, 0.29];
const BAD: Rgb = [0.72, 0.14, 0.14];

const n = (v: number) => (Math.round(v * 100) / 100).toString();
const rgb = (c: Rgb) => c.map(n).join(" ");

type LinkBox = { x1: number; y1: number; x2: number; y2: number; url: string };

/** One page: `y` values are measured from the top edge, like reading, and converted to PDF's bottom-up axis here. */
class Sheet {
  readonly ops: string[] = [];
  readonly links: LinkBox[] = [];

  text(x: number, y: number, text: string, opts: { font?: Font; size?: number; color?: Rgb; align?: "left" | "right" } = {}): number {
    const font = opts.font ?? "F1";
    const size = opts.size ?? 10;
    const width = textWidth(text, font, size);
    const left = opts.align === "right" ? x - width : x;
    this.ops.push(`BT /${font} ${n(size)} Tf ${rgb(opts.color ?? INK)} rg 1 0 0 1 ${n(left)} ${n(PAGE_H - y)} Tm ${literal(text)} Tj ET`);
    return width;
  }

  rule(x1: number, x2: number, y: number, color: Rgb = RULE, weight = 0.6) {
    this.ops.push(`${rgb(color)} RG ${n(weight)} w ${n(x1)} ${n(PAGE_H - y)} m ${n(x2)} ${n(PAGE_H - y)} l S`);
  }

  fill(x: number, y: number, width: number, height: number, color: Rgb) {
    this.ops.push(`${rgb(color)} rg ${n(x)} ${n(PAGE_H - y - height)} ${n(width)} ${n(height)} re f`);
  }

  link(x: number, y: number, width: number, size: number, url: string) {
    this.links.push({ x1: x, y1: PAGE_H - y - size * 0.3, x2: x + width, y2: PAGE_H - y + size * 0.9, url });
  }
}

const COL_QTY = 372;
const COL_PRICE = 462;
const DESC_WIDTH = COL_QTY - 48 - LEFT;

function tableHead(sheet: Sheet, y: number): number {
  sheet.fill(LEFT, y, RIGHT - LEFT, 22, BAND);
  const opts = { font: "F2" as const, size: 8.5, color: MUTED };
  sheet.text(LEFT + 8, y + 14.5, "DESCRIPTION", opts);
  sheet.text(COL_QTY, y + 14.5, "QTY", { ...opts, align: "right" });
  sheet.text(COL_PRICE, y + 14.5, "UNIT PRICE", { ...opts, align: "right" });
  sheet.text(RIGHT - 8, y + 14.5, "AMOUNT", { ...opts, align: "right" });
  return y + 22;
}

/** The lines of a block of free text, with the height they need. */
function block(text: string, size: number, width: number) {
  const lines = wrap(text, "F1", size, width);
  return { lines, leading: size + 3.5, height: lines.length * (size + 3.5) };
}

function layout(doc: InvoicePdfInput): Sheet[] {
  const sheets: Sheet[] = [new Sheet()];
  let sheet = sheets[0] as Sheet;
  const newPage = () => {
    sheet = new Sheet();
    sheets.push(sheet);
    return TOP;
  };

  // Header: who it is from on the left, what it is on the right.
  const nameLines = wrap(doc.seller.name, "F2", 15, 285);
  let left = TOP + 12;
  for (const line of nameLines) {
    sheet.text(LEFT, left, line, { font: "F2", size: 15 });
    left += 19;
  }
  left -= 4;
  for (const raw of doc.seller.lines) {
    for (const line of wrap(raw, "F1", 9, 285)) {
      sheet.text(LEFT, left, line, { size: 9, color: MUTED });
      left += 12.5;
    }
  }
  sheet.text(RIGHT, TOP + 16, doc.status === "draft" ? "DRAFT INVOICE" : "INVOICE", { font: "F2", size: 20, align: "right" });
  let right = TOP + 38;
  for (const [label, value] of [["Invoice no.", doc.number], ["Issued", doc.issueDate], ["Due", doc.dueDate]] as const) {
    if (!value) continue;
    sheet.text(RIGHT - 118, right, label, { size: 9, color: MUTED, align: "right" });
    sheet.text(RIGHT, right, value, { size: 10, align: "right" });
    right += 15;
  }
  let y = Math.max(left, right) + 10;
  sheet.rule(LEFT, RIGHT, y);
  y += 24;

  // Bill to (left) and the one number the reader is looking for (right).
  const top = y;
  sheet.text(LEFT, y, "BILL TO", { font: "F2", size: 8, color: MUTED });
  y += 16;
  for (const line of wrap(doc.client.name, "F2", 11, 285)) {
    sheet.text(LEFT, y, line, { font: "F2", size: 11 });
    y += 15;
  }
  for (const raw of doc.client.lines) {
    for (const line of wrap(raw, "F1", 9.5, 285)) {
      sheet.text(LEFT, y, line, { size: 9.5, color: MUTED });
      y += 13;
    }
  }
  const tone = doc.status === "paid" ? GOOD : doc.status === "void" ? BAD : INK;
  sheet.text(RIGHT, top, doc.summary.label.toUpperCase(), { font: "F2", size: 8, color: doc.status === "sent" || doc.status === "draft" ? MUTED : tone, align: "right" });
  sheet.text(RIGHT, top + 22, doc.summary.value, { font: "F2", size: 17, color: tone, align: "right" });
  let summaryBottom = top + 22;
  if (doc.summary.note) {
    for (const line of wrap(doc.summary.note, "F1", 9, 190)) {
      summaryBottom += 13;
      sheet.text(RIGHT, summaryBottom, line, { size: 9, color: MUTED, align: "right" });
    }
  }
  y = Math.max(y, summaryBottom + 13) + 16;

  // Lines. A row never splits across pages; the column headings repeat on each page.
  y = tableHead(sheet, y);
  for (const item of doc.items) {
    const lines = wrap(item.description, "F1", 10, DESC_WIDTH);
    const height = Math.max(1, lines.length) * 13.5 + 12;
    if (y + height > BOTTOM) {
      // Two statements: newPage() replaces `sheet`, and an argument list would still hold the old one.
      y = newPage();
      y = tableHead(sheet, y);
    }
    let line = y + 17;
    for (const text of lines) {
      sheet.text(LEFT + 8, line, text, { size: 10 });
      line += 13.5;
    }
    sheet.text(COL_QTY, y + 17, item.quantity, { size: 10, align: "right" });
    sheet.text(COL_PRICE, y + 17, item.unitPrice, { size: 10, align: "right" });
    sheet.text(RIGHT - 8, y + 17, item.amount, { size: 10, align: "right" });
    y += height;
    sheet.rule(LEFT, RIGHT, y);
  }

  // Totals, kept together.
  const totalsHeight = doc.totals.length * 19 + 14;
  if (y + totalsHeight > BOTTOM) y = newPage();
  y += 8;
  for (const row of doc.totals) {
    if (row.strong) {
      sheet.rule(RIGHT - 215, RIGHT, y + 3, INK, 0.8);
      y += 5;
    }
    y += 16;
    sheet.text(RIGHT - 207, y, row.label, { font: row.strong ? "F2" : "F1", size: row.strong ? 11 : 10, color: row.strong ? INK : MUTED });
    sheet.text(RIGHT - 8, y, row.value, { font: row.strong ? "F2" : "F1", size: row.strong ? 11 : 10, align: "right" });
    y += 3;
  }
  y += 26;

  // How to pay.
  if (doc.link) {
    const urlLines = wrap(doc.link.url, "F1", 9.5, RIGHT - LEFT - 24);
    const height = 34 + urlLines.length * 13;
    if (y + height > BOTTOM) y = newPage();
    sheet.fill(LEFT, y, RIGHT - LEFT, height, BAND);
    sheet.text(LEFT + 12, y + 18, doc.link.label, { font: "F2", size: 10 });
    let line = y + 33;
    for (const text of urlLines) {
      const width = sheet.text(LEFT + 12, line, text, { size: 9.5, color: LINK });
      sheet.link(LEFT + 12, line, width, 9.5, doc.link.url);
      line += 13;
    }
    y += height + 22;
  }

  for (const [title, text] of [["Notes", doc.notes], ["Payment details and terms", doc.footer]] as const) {
    if (!text?.trim()) continue;
    const body = block(text.trim(), 9.5, RIGHT - LEFT);
    if (y + 18 + Math.min(body.height, 3 * body.leading) > BOTTOM) y = newPage();
    sheet.text(LEFT, y, title.toUpperCase(), { font: "F2", size: 8, color: MUTED });
    y += 15;
    for (const line of body.lines) {
      if (y > BOTTOM) y = newPage() + 10;
      sheet.text(LEFT, y, line, { size: 9.5 });
      y += body.leading;
    }
    y += 14;
  }

  // Page footer.
  sheets.forEach((s, i) => {
    s.rule(LEFT, RIGHT, PAGE_H - 46);
    s.text(LEFT, PAGE_H - 32, `${doc.seller.name}  ·  ${doc.number}`.slice(0, 110), { size: 8, color: MUTED });
    s.text(RIGHT, PAGE_H - 32, `Page ${i + 1} of ${sheets.length}`, { size: 8, color: MUTED, align: "right" });
  });
  return sheets;
}

// --- File -----------------------------------------------------------------------------------------------------------

const pdfDate = (d: Date) => `D:${d.toISOString().replace(/[-:T]/g, "").slice(0, 14)}Z`;

/** Render the invoice. The result is a complete PDF 1.4 file. */
export function renderInvoicePdf(doc: InvoicePdfInput): Uint8Array {
  const sheets = layout(doc);
  // 1 catalog, 2 page tree, 3 and 4 fonts, 5 info; then per page: the page, its content, its link annotations.
  const objects: string[] = [];
  const add = (body: string) => objects.push(body);
  const pageIds: number[] = [];
  let next = 6;
  const plan = sheets.map((s) => {
    const page = next;
    const content = next + 1;
    const annots = s.links.map((_, i) => next + 2 + i);
    next += 2 + s.links.length;
    pageIds.push(page);
    return { page, content, annots };
  });

  add("<< /Type /Catalog /Pages 2 0 R >>");
  add(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`);
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  const title = doc.status === "draft" ? "Draft invoice" : `Invoice ${doc.number}`;
  add(`<< /Title ${literal(title)} /Author ${literal(doc.seller.name)} /Creator ${literal("moks-cms invoices")}${doc.createdAt ? ` /CreationDate ${literal(pdfDate(doc.createdAt))}` : ""} >>`);
  sheets.forEach((s, i) => {
    const ids = plan[i];
    if (!ids) return;
    const stream = s.ops.join("\n");
    add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(PAGE_W)} ${n(PAGE_H)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${ids.content} 0 R` +
        `${ids.annots.length ? ` /Annots [${ids.annots.map((id) => `${id} 0 R`).join(" ")}]` : ""} >>`,
    );
    add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    for (const l of s.links) {
      add(`<< /Type /Annot /Subtype /Link /Rect [${n(l.x1)} ${n(l.y1)} ${n(l.x2)} ${n(l.y2)}] /Border [0 0 0] /A << /S /URI /URI ${literal(l.url)} >> >>`);
    }
  });

  // Every character written is below 256 (text is escaped to ASCII), so string length is byte length.
  let file = "%PDF-1.4\n%âãÏÓ\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(file.length);
    file += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = file.length;
  file += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  file += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  const bytes = new Uint8Array(file.length);
  for (let i = 0; i < file.length; i++) bytes[i] = file.charCodeAt(i) & 0xff;
  return bytes;
}
