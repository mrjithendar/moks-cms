// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Regression (2026-11-10): on the SEO admin pages the admin menu showed its phone layout on desktop (two columns,
 * bordered box, wrapped labels). seo.css loads after globals.css and its utilities are unlayered, so its copies of
 * base utilities beat globals.css's responsive overrides. It scanned only the SEO folders, so it had `p-3`,
 * `sm:grid-cols-2`… but not the admin nav's `lg:p-0`, `lg:grid-cols-1`…. It must contain every class that renders on
 * those pages, in Tailwind's order. This compiles the real stylesheet and checks the admin shell's pairs.
 */
const SEO_CSS = path.resolve(__dirname, "../src/app/admin/(growth)/seo.css");

async function compileSeoCss(): Promise<string> {
  const { compile } = await import("@tailwindcss/node");
  const { Scanner } = await import("@tailwindcss/oxide");
  const c = await compile(fs.readFileSync(SEO_CSS, "utf8"), { base: path.dirname(SEO_CSS), onDependency() {} });
  return c.build(new Scanner({ sources: c.sources }).scan());
}

const at = (css: string, cls: string) => css.search(new RegExp(`(^|\\n)\\s*${cls.replace(/[\\.:[\]/]/g, (m) => `\\${m}`)}\\s*\\{`));

describe("seo.css covers everything rendered on SEO admin pages", () => {
  it("has the admin shell's responsive overrides after the base utilities they override", async () => {
    const css = await compileSeoCss();
    const pairs: [string, string][] = [
      [".flex", ".lg\\:hidden"],
      [".hidden", ".lg\\:grid"],
      [".sm\\:grid-cols-2", ".lg\\:grid-cols-1"],
      [".p-3", ".lg\\:p-0"],
      [".border", ".lg\\:border-0"],
      [".bg-surface", ".lg\\:bg-transparent"],
      [".mt-1", ".lg\\:mt-0"],
      [".border-b", ".lg\\:border-b-0"],
    ];
    for (const [base, override] of pairs) {
      expect(at(css, base), base).toBeGreaterThanOrEqual(0);
      expect(at(css, override), `${override} must be in seo.css (else ${base} wins on desktop)`).toBeGreaterThan(at(css, base));
    }
  }, 60_000);
});
