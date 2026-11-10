import { diffArrays, diffLines } from "diff";
import type { BaseSnapshot, Change, ChangeType } from "./changeset";

/**
 * Diffs for the review UI (isomorphic: server for the first render, browser after inline edits). Uses jsdiff.
 *
 * Prose is compared as *rendered* tokens, not Markdown source: emphasis markers, line wrapping and link syntax are
 * stripped, and each word carries the link it belongs to, so `*a*` → `_a_` or a re-wrapped paragraph shows no change,
 * while wrapping a phrase in a new link shows exactly that phrase as "linked". Code is diffed by line; title/meta by
 * field (word-level inside).
 */
export type Token = { text: string; href?: string };
export type Seg = { op: "eq" | "ins" | "del"; text: string; href?: string; linkChange?: "added" | "removed" };
export type ChangeDiff = { kind: "prose" | "code" | "field"; segments: Seg[]; lines?: { op: "eq" | "ins" | "del"; text: string }[]; plusWords: number; minusWords: number; linksAdded: number };

/** Inline Markdown → rendered word tokens (each with the link it sits in). Block markers (#, -, >, 1.) are dropped. */
export function renderTokens(md: string): Token[] {
  const out: Token[] = [];
  const text = md
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const re = /!\[([^\]]*)\]\(([^)\s]+)[^)]*\)|\[([^\]]+)\]\(([^)\s]+)[^)]*\)|(\S+)/g;
  for (const m of text.matchAll(re)) {
    if (m[1] !== undefined) {
      out.push({ text: `[image: ${m[1] || "no alt text"}]` });
      continue;
    }
    const href = m[4];
    const words = (m[3] ?? m[5] ?? "").replace(/(\*\*|__|\*|_|~~|`)/g, "").split(/\s+/).filter(Boolean);
    for (const w of words) out.push(href ? { text: w, href } : { text: w });
  }
  return out;
}

const key = (t: Token) => `${t.text}\u0000${t.href ?? ""}`;
const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** Word-level diff of rendered prose. A word that only gains or loses a link is shown as a link change, not as text. */
export function proseDiff(before: string, after: string): ChangeDiff {
  const a = renderTokens(before);
  const b = renderTokens(after);
  const parts = diffArrays(a.map(key), b.map(key));
  const segs: Seg[] = [];
  let plus = 0;
  let minus = 0;
  const hrefsBefore = new Set(a.map((t) => t.href).filter(Boolean));
  const linksAdded = new Set(b.map((t) => t.href).filter((h): h is string => Boolean(h) && !hrefsBefore.has(h)));
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    const toks = p.value.map((k) => ({ text: k.split("\u0000")[0]!, href: k.split("\u0000")[1] || undefined }));
    const next = parts[i + 1];
    // removed X + added X-with-link (same words) → one "linked" segment
    if (p.removed && next?.added) {
      const nt = next.value.map((k) => ({ text: k.split("\u0000")[0]!, href: k.split("\u0000")[1] || undefined }));
      if (nt.map((t) => t.text).join(" ") === toks.map((t) => t.text).join(" ")) {
        segs.push({ op: "eq", text: nt.map((t) => t.text).join(" "), href: nt[0]?.href, linkChange: nt[0]?.href ? "added" : "removed" });
        i++;
        continue;
      }
    }
    const op = p.added ? "ins" : p.removed ? "del" : "eq";
    if (op === "ins") plus += toks.length;
    if (op === "del") minus += toks.length;
    // Group runs of tokens with the same link into segments.
    for (const t of toks) {
      const last = segs[segs.length - 1];
      if (last && last.op === op && last.href === t.href && !last.linkChange) last.text += ` ${t.text}`;
      else segs.push({ op, text: t.text, ...(t.href ? { href: t.href } : {}) });
    }
  }
  return { kind: "prose", segments: segs, plusWords: plus, minusWords: minus, linksAdded: linksAdded.size };
}

export function codeDiff(before: string, after: string): ChangeDiff {
  const lines: { op: "eq" | "ins" | "del"; text: string }[] = [];
  let plus = 0;
  let minus = 0;
  for (const p of diffLines(before.replace(/\s+$/, "") + "\n", after.replace(/\s+$/, "") + "\n")) {
    const op = p.added ? "ins" : p.removed ? "del" : "eq";
    for (const l of p.value.replace(/\n$/, "").split("\n")) {
      lines.push({ op, text: l });
      if (op === "ins") plus += wordCount(l);
      if (op === "del") minus += wordCount(l);
    }
  }
  return { kind: "code", segments: [], lines, plusWords: plus, minusWords: minus, linksAdded: 0 };
}

export function changeDiff(c: Pick<Change, "type" | "before" | "after" | "edited">): ChangeDiff {
  const after = c.edited ?? c.after;
  if (c.type === "code_block") return codeDiff(c.before, after);
  const d = proseDiff(c.before, after);
  return c.type === "title" || c.type === "meta_description" ? { ...d, kind: "field" } : d;
}

const LABEL: Record<ChangeType, [string, string]> = {
  title: ["title", "titles"],
  meta_description: ["meta", "meta"],
  heading: ["heading", "headings"],
  paragraph_edit: ["edit", "edits"],
  paragraph_add: ["addition", "additions"],
  code_block: ["code block", "code blocks"],
  internal_link: ["link", "links"],
  external_link: ["docs link", "docs links"],
  link_fix: ["link fix", "link fixes"],
  alt_text: ["alt text", "alt texts"],
  schema: ["schema", "schema"],
};
const ORDER: ChangeType[] = ["paragraph_edit", "paragraph_add", "heading", "internal_link", "external_link", "link_fix", "title", "meta_description", "alt_text", "code_block", "schema"];

export type Summary = { total: number; byType: Partial<Record<ChangeType, number>>; breakdownLabel: string; plusWords: number; minusWords: number; linksAdded: number; metadataChanged: number; reviewMinutes: number };

/** "3 edits · 2 links · 1 meta", word counts and an estimated review time (~20 s per change + reading the new words). */
export function summarize(_base: BaseSnapshot | null, changes: Change[]): Summary {
  const byType: Partial<Record<ChangeType, number>> = {};
  let plus = 0;
  let minus = 0;
  let links = 0;
  for (const c of changes) {
    byType[c.type] = (byType[c.type] ?? 0) + 1;
    const d = changeDiff(c);
    plus += d.plusWords;
    minus += d.minusWords;
    links += c.type === "internal_link" ? 1 : d.linksAdded;
  }
  const breakdownLabel = ORDER.filter((t) => byType[t]).map((t) => `${byType[t]} ${byType[t] === 1 ? LABEL[t][0] : LABEL[t][1]}`).join(" · ");
  const seconds = changes.length * 20 + (plus + minus) / 3;
  return { total: changes.length, byType, breakdownLabel, plusWords: plus, minusWords: minus, linksAdded: links, metadataChanged: (byType.title ?? 0) + (byType.meta_description ?? 0), reviewMinutes: Math.max(1, Math.round(seconds / 60)) };
}

// --- SERP preview -------------------------------------------------------------------------------------------

/** Rough glyph widths (em) for a Google-like sans-serif; good enough to show where truncation will happen. */
function glyphEm(ch: string): number {
  if (/[iljtfI.,:;'!|]/.test(ch)) return 0.28;
  if (/[rs]/.test(ch)) return 0.42;
  if (/[mwMW]/.test(ch)) return 0.85;
  if (/[A-Z]/.test(ch)) return 0.66;
  if (ch === " ") return 0.28;
  return 0.55;
}

/** Truncate to an approximate pixel width at a font size, adding "…" like the results page does. */
export function truncateToWidth(text: string, maxPx: number, fontPx: number): { text: string; truncated: boolean } {
  let w = 0;
  for (let i = 0; i < text.length; i++) {
    w += glyphEm(text[i]!) * fontPx;
    if (w > maxPx) {
      const cut = text.slice(0, i);
      const sp = cut.lastIndexOf(" ");
      return { text: `${(sp > cut.length * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:–-]+$/, "")} …`, truncated: true };
    }
  }
  return { text, truncated: false };
}

/** Desktop: title ~600px at 20px, snippet ~2 lines × 600px at 14px. Mobile: title 2 lines at 18px, snippet ~3 lines. */
export function serpPreview(title: string, description: string) {
  return {
    desktop: { title: truncateToWidth(title, 600, 20), description: truncateToWidth(description, 1180, 14) },
    mobile: { title: truncateToWidth(title, 2 * 320, 18), description: truncateToWidth(description, 3 * 330, 14) },
  };
}
