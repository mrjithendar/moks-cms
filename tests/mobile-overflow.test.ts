import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Phone layout guards (static): the patterns that made an admin page wider than the screen on 2026-11-18.
 * A page that is wider than the screen zooms out on a phone, so the header and every card look cut off.
 */
const SRC = path.resolve(import.meta.dirname, "../src");

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? tsxFiles(full) : e.name.endsWith(".tsx") ? [full] : [];
  });
}

const files = tsxFiles(SRC).map((file) => ({ name: path.relative(SRC, file), text: readFileSync(file, "utf8") }));

describe("phone layout", () => {
  it("every file that draws a table gives it a region that scrolls sideways", () => {
    // The shared Table (components/admin/ui.tsx) and the article tables (rehypeTableScroll) bring their own.
    const bare = files.filter((f) => f.text.includes("<table") && !/overflow-(x-|y-)?auto/.test(f.text)).map((f) => f.name);
    expect(bare).toEqual([]);
  });

  it("chips drawn from a list wrap: no row of inline chips spaced with a margin", () => {
    // Adjacent inline elements have no space between them in React output, so the browser cannot break the line.
    const rows = files.flatMap((f) => (/<dd>\{[^\n]*\.map\(\([^)]*\) => <(code|span|kbd)\b[^>]*\bm[rl]-\d/.test(f.text) ? [f.name] : []));
    expect(rows).toEqual([]);
  });

  it("a definition list's flexible column may shrink (minmax(0,1fr), never a bare 1fr)", () => {
    const rigid = files.flatMap((f) => (/<dl className="[^"]*grid-cols-\[[^\]"]*(?<!minmax\(0,)1fr\]/.test(f.text) ? [f.name] : []));
    expect(rigid).toEqual([]);
  });

  it("a row of buttons wraps: a bare `flex gap-N` row never holds two or more buttons", () => {
    // Side by side, two long buttons squeeze each other into several lines on a phone; a row that wraps keeps them readable.
    const rows = files.flatMap((f) => (/<div className="flex gap-\d">\n\s*<Button\b[\s\S]{0,600}?\n\s*<Button\b/.test(f.text) ? [f.name] : []));
    expect(rows).toEqual([]);
  });

  it("a table cell that may break inside a word has a minimum width", () => {
    // `overflow-wrap: anywhere` lets a column shrink to one or two letters per line; with a floor the table scrolls instead.
    const thin = files.flatMap((f) => [...f.text.matchAll(/<td className=(?:"[^"]*"|\{`[^`]*`\})/g)].filter((m) => m[0].includes("[overflow-wrap:anywhere]") && !m[0].includes("min-w-")).map(() => f.name));
    expect(thin).toEqual([]);
  });
});
