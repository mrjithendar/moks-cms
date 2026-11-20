import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Keeps the user guide (Admin → User manual, public /user-manual) in step with the product: a new admin page, form field,
 * setting or diagram that the guide does not cover fails here, with a message naming it. See docs/USER_GUIDE.md.
 */

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
const norm = (s: string) => s.toLowerCase().replace(/[‘’“”]/g, "'").replace(/\s+/g, " ");

/** Every /admin route that has a page.tsx (route groups like (growth) do not appear in the URL). */
function adminRoutes(): Set<string> {
  const out = new Set<string>();
  const walk = (dir: string, url: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (!statSync(full).isDirectory()) {
        if (name === "page.tsx") out.add(url || "/admin");
        continue;
      }
      walk(full, /^\(.*\)$/.test(name) ? url : `${url}/${name}`);
    }
  };
  walk(path.join(ROOT, "src/app/admin"), "/admin");
  return out;
}

const pathOf = (href: string) => href.split(/[?#]/)[0]!;

describe("user guide content", () => {
  it("has unique ids, a known section and a body for every entry", async () => {
    const { GUIDE, GUIDE_SECTIONS } = await import("@/lib/user-guide");
    const ids = GUIDE.map((e) => e.id);
    expect(new Set(ids).size, `duplicate ids: ${ids.filter((id, i) => ids.indexOf(id) !== i).join(", ")}`).toBe(ids.length);
    for (const e of GUIDE) {
      expect(GUIDE_SECTIONS, e.id).toContain(e.section);
      expect(e.body.length, e.id).toBeGreaterThan(0);
      expect(e.summary.trim(), e.id).not.toBe("");
    }
  });

  it("covers every page in the admin menu", async () => {
    const { GUIDE } = await import("@/lib/user-guide");
    const { settingsReference } = await import("@/lib/user-guide-settings");
    const nav = [...read("src/app/admin/layout.tsx").matchAll(/href: "(\/admin[^"]*)"/g)].map((m) => pathOf(m[1]!));
    expect(nav.length).toBeGreaterThan(20);
    const covered = new Set([...GUIDE.map((e) => e.href), ...settingsReference().map((g) => g.href)].filter(Boolean).map((h) => pathOf(h!)));
    // A page is covered by an entry for it, or mentioned by name in one (several pages share an article).
    const text = norm(GUIDE.map((e) => `${e.title} ${e.body.join(" ")}`).join(" "));
    const labels = new Map([...read("src/app/admin/layout.tsx").matchAll(/href: "(\/admin[^"]*)", label: "([^"]+)"/g)].map((m) => [pathOf(m[1]!), m[2]!]));
    const missing = nav.filter((h) => !covered.has(h) && !text.includes(norm(labels.get(h) ?? "\u0000")));
    expect(missing, `Admin pages without a guide entry (add one to src/lib/user-guide.ts): ${missing.join(", ")}`).toEqual([]);
  });

  it("links only to admin pages that exist", async () => {
    const { GUIDE } = await import("@/lib/user-guide");
    const { settingsReference } = await import("@/lib/user-guide-settings");
    const routes = adminRoutes();
    const hrefs = [...GUIDE.map((e) => e.href), ...settingsReference().map((g) => g.href)].filter((h): h is string => !!h);
    const broken = [...new Set(hrefs.map(pathOf))].filter((h) => !routes.has(h));
    expect(broken, `Guide links to admin pages that no longer exist: ${broken.join(", ")}`).toEqual([]);
  });

  it("has a draw.io source and an exported SVG for every diagram", async () => {
    const { GUIDE } = await import("@/lib/user-guide");
    const names = [...new Set(GUIDE.flatMap((e) => (e.diagram ? [e.diagram.name] : [])))];
    expect(names.length).toBeGreaterThan(5);
    for (const n of names) {
      expect(existsSync(path.join(ROOT, `docs/guide/diagrams/${n}.drawio`)), `docs/guide/diagrams/${n}.drawio`).toBe(true);
      const svg = path.join(ROOT, `public/guide/${n}.drawio.svg`);
      expect(existsSync(svg), `public/guide/${n}.drawio.svg (run scripts/export-guide-diagrams.sh)`).toBe(true);
      const body = readFileSync(svg, "utf8");
      expect(body, `${n}: the SVG must embed its draw.io source`).toContain("content=\"&lt;mxfile");
      expect(body, `${n}: use plain-text labels (no HTML labels) so the SVG has no PNG fallbacks`).not.toContain("data:image/png");
    }
  });
});

describe("pages of the manual", () => {
  it("gives every entry an id that can be the last part of its address", async () => {
    const { GUIDE, GUIDE_RESERVED_IDS, guideArticlePath, GUIDE_ADMIN_BASE, GUIDE_PUBLIC_BASE } = await import("@/lib/user-guide");
    for (const e of GUIDE) {
      expect(e.id, e.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(GUIDE_RESERVED_IDS, `${e.id} is a page of the manual itself`).not.toContain(e.id);
    }
    // The reserved segments are the pages that exist next to [id] in both copies of the manual.
    for (const base of ["src/app/admin/user-manual", "src/app/user-manual"]) {
      const pages = readdirSync(path.join(ROOT, base)).filter((n) => statSync(path.join(ROOT, base, n)).isDirectory() && n !== "[id]");
      expect(pages.sort(), base).toEqual([...GUIDE_RESERVED_IDS].sort());
      expect(existsSync(path.join(ROOT, base, "[id]/page.tsx")), `${base}/[id]/page.tsx`).toBe(true);
    }
    expect(guideArticlePath(GUIDE_ADMIN_BASE, "posts")).toBe("/admin/user-manual/posts");
    expect(guideArticlePath(GUIDE_PUBLIC_BASE, "posts")).toBe("/user-manual/posts");
  });

  it("lists every entry once in the contents, guides before questions in each category", async () => {
    const { GUIDE, GUIDE_SECTIONS, guideFor, guideReadingOrder, guideToc } = await import("@/lib/user-guide");
    const order = guideReadingOrder(GUIDE);
    expect(order.map((e) => e.id).sort()).toEqual(GUIDE.map((e) => e.id).sort());
    const toc = guideToc(GUIDE);
    expect(toc.map((s) => s.section)).toEqual(GUIDE_SECTIONS.filter((s) => GUIDE.some((e) => e.section === s)));
    for (const s of toc) {
      expect(s.guides.every((e) => e.kind === "guide" && e.section === s.section), s.section).toBe(true);
      expect(s.faqs.every((e) => e.kind === "faq" && e.section === s.section), s.section).toBe(true);
    }
    // An author's contents hold nothing an author may not read, and no empty category.
    const authors = guideToc(guideFor(false));
    expect(authors.flatMap((s) => [...s.guides, ...s.faqs]).some((e) => e.adminOnly)).toBe(false);
    expect(authors.every((s) => s.guides.length + s.faqs.length > 0)).toBe(true);
  });

  it("links each entry to the one before and the one after it in reading order", async () => {
    const { GUIDE, guideNeighbours, guideReadingOrder } = await import("@/lib/user-guide");
    const order = guideReadingOrder(GUIDE);
    expect(guideNeighbours(GUIDE, order[0]!.id)).toEqual({ previous: undefined, next: order[1] });
    expect(guideNeighbours(GUIDE, order.at(-1)!.id)).toEqual({ previous: order.at(-2), next: undefined });
    expect(guideNeighbours(GUIDE, order[5]!.id)).toEqual({ previous: order[4], next: order[6] });
    expect(guideNeighbours(GUIDE, "no-such-entry")).toEqual({ previous: undefined, next: undefined });
  });

  it("suggests entries about the same admin page first, then the rest of the category, never the entry itself", async () => {
    const { GUIDE, guideRelated, sameAdminPage } = await import("@/lib/user-guide");
    const backups = GUIDE.find((e) => e.id === "backups")!;
    const related = guideRelated(GUIDE, backups);
    expect(related.length).toBeGreaterThan(0);
    expect(related.map((e) => e.id)).not.toContain("backups");
    const samePage = related.filter((e) => e.href && sameAdminPage(backups, e.href));
    expect(related.slice(0, samePage.length)).toEqual(samePage);
    expect(related.slice(samePage.length).every((e) => e.section === backups.section)).toBe(true);
    expect(sameAdminPage(backups, "/admin/backups?tab=x")).toBe(true);
    expect(sameAdminPage(backups, "/admin/storage")).toBe(false);
  });
});

describe("settings reference", () => {
  it("lists every Automation & AI (SEO agent) setting, runtime setting and MCP scope", async () => {
    const { settingsReference, seoSettingPaths } = await import("@/lib/user-guide-settings");
    const { GROUPS } = await import("@/lib/runtime-settings");
    const { SCOPES } = await import("@/lib/mcp-oauth/oauth");
    const keys = new Set(settingsReference().flatMap((g) => g.rows.map((r) => r.key)));
    const missing = [...seoSettingPaths(), ...GROUPS.flatMap((g) => g.fields.map((f) => f.env)), ...Object.keys(SCOPES)].filter((k) => !keys.has(k));
    expect(missing).toEqual([]);
  });

  it("mentions every field label of the Appearance, Integrations, Storage and Email forms", async () => {
    const { settingsReference } = await import("@/lib/user-guide-settings");
    const text = norm(settingsReference().map((g) => `${g.title} ${g.description ?? ""} ${g.rows.map((r) => `${r.name} ${r.help ?? ""}`).join(" ")}`).join(" "));
    const files = ["src/app/admin/appearance/panels.tsx", "src/app/admin/integrations/page.tsx", "src/app/admin/storage/page.tsx", "src/app/admin/storage/StorageForm.tsx", "src/app/admin/email/EmailSettings.tsx"];
    const missing: string[] = [];
    for (const f of files) {
      for (const m of read(f).matchAll(/\blabel="([^"]{3,})"/g)) {
        const label = m[1]!;
        if (!text.includes(norm(label))) missing.push(`${f}: ${label}`);
      }
    }
    expect(missing, "Form fields the settings reference does not mention (add them to src/lib/user-guide-settings.ts)").toEqual([]);
  });

  it("shows defaults only, never a stored value", async () => {
    const { settingsReference } = await import("@/lib/user-guide-settings");
    const runtime = settingsReference().filter((g) => g.id.startsWith("runtime-")).flatMap((g) => g.rows);
    expect(runtime.length).toBeGreaterThan(0);
    expect(runtime.every((r) => r.default === "off" || r.default === "from the environment")).toBe(true);
  });

  it("puts every runtime setting under the page that shows it, with no Advanced settings page left", async () => {
    const { settingsReference, RUNTIME_SETTINGS_AREA } = await import("@/lib/user-guide-settings");
    const { GROUPS } = await import("@/lib/runtime-settings");
    const { GUIDE } = await import("@/lib/user-guide");
    for (const g of GROUPS) {
      expect(RUNTIME_SETTINGS_AREA[g.page], `${g.id}: ${g.page} needs a guide area`).toBeTruthy();
      const page = read(`src/app${g.page}/page.tsx`);
      expect(page, `${g.page} must render the ${g.id} group`).toMatch(new RegExp(`<RuntimeSettings ids=\\{\\[[^\\]]*"${g.id}"`));
    }
    const ref = settingsReference().filter((g) => g.id.startsWith("runtime-"));
    expect(ref.map((g) => g.href)).toEqual(GROUPS.map((g) => `${g.page}#${g.id}`));
    expect(GUIDE.some((e) => e.href === "/admin/advanced")).toBe(false);
    expect(read("src/app/admin/layout.tsx")).not.toContain("/admin/advanced");
    expect(read("src/components/guide/GuideBrowser.tsx")).not.toContain("Advanced settings");
  });
});

describe("search and access", () => {
  it("finds entries by synonyms and narrows by area and kind", async () => {
    const { GUIDE, searchGuide } = await import("@/lib/user-guide");
    expect(searchGuide(GUIDE, "backup").map((e) => e.id)).toContain("backups");
    expect(searchGuide(GUIDE, "crewai")[0]!.id).toBe("crewai");
    expect(searchGuide(GUIDE, "sandbox gvisor").map((e) => e.id)).toContain("executor");
    expect(searchGuide(GUIDE, "", "SEO agent, AI & ML").every((e) => e.section === "SEO agent, AI & ML")).toBe(true);
    expect(searchGuide(GUIDE, "", undefined, "faq").every((e) => e.kind === "faq")).toBe(true);
    expect(searchGuide(GUIDE, "zzzz-no-such-word")).toEqual([]);
  });

  it("gives authors only the pages they can open", async () => {
    const { guideFor } = await import("@/lib/user-guide");
    expect(guideFor(false).some((e) => e.adminOnly)).toBe(false);
    expect(guideFor(true).some((e) => e.adminOnly)).toBe(true);
  });

  it("keeps the public guide off by default and reserves its path", async () => {
    const { defaultConfig } = await import("@/lib/site-config/schema");
    expect(defaultConfig().general.features.publicGuide).toBe(false);
    const { RESERVED_PAGE_SLUGS } = await import("@/lib/site-pages");
    expect(RESERVED_PAGE_SLUGS.has("user-manual")).toBe(true);
    // A client's invoice link is /invoice/<token>: a page cannot take that address either.
    expect(RESERVED_PAGE_SLUGS.has("invoice")).toBe(true);
  });
});
