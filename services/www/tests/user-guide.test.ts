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

describe("settings reference", () => {
  it("lists every Automation & AI (SEO agent) setting, Advanced setting and MCP scope", async () => {
    const { settingsReference, seoSettingPaths } = await import("@/lib/user-guide-settings");
    const { GROUPS } = await import("@/lib/runtime-settings");
    const { SCOPES } = await import("@/lib/mcp-oauth/oauth");
    const keys = new Set(settingsReference().flatMap((g) => g.rows.map((r) => r.key)));
    const missing = [...seoSettingPaths(), ...GROUPS.flatMap((g) => g.fields.map((f) => f.env)), ...Object.keys(SCOPES)].filter((k) => !keys.has(k));
    expect(missing).toEqual([]);
  });

  it("mentions every field label of the Appearance, Integrations and Storage & email forms", async () => {
    const { settingsReference } = await import("@/lib/user-guide-settings");
    const text = norm(settingsReference().map((g) => `${g.title} ${g.description ?? ""} ${g.rows.map((r) => `${r.name} ${r.help ?? ""}`).join(" ")}`).join(" "));
    const files = ["src/app/admin/appearance/panels.tsx", "src/app/admin/integrations/page.tsx", "src/app/admin/storage/page.tsx", "src/app/admin/storage/EmailSettings.tsx"];
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
    const advanced = settingsReference().filter((g) => g.area === "Advanced settings").flatMap((g) => g.rows);
    expect(advanced.every((r) => r.default === "off" || r.default === "from the environment")).toBe(true);
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
  });
});
