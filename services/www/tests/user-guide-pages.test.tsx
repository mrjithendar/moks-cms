import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => <a href={href} {...rest}>{children}</a> }));

const { GuideArticle, GuidePrint, GUIDE_PRINT_CSS, guideCrumbs } = await import("@/components/guide/GuideArticle");
const { GuideLayout, GuideSidebar } = await import("@/components/guide/GuideSidebar");
const { GUIDE, GUIDE_ADMIN_BASE, GUIDE_PUBLIC_BASE, guideFor, guideNeighbours, guideReadingOrder } = await import("@/lib/user-guide");
type SettingsGroup = import("@/lib/user-guide-settings").SettingsGroup;

/**
 * The manual's pages as HTML (Admin → User manual → an entry, public /user-manual/<id>, and the printable manual):
 * the contents tree, the article layout and the print page. See docs/USER_GUIDE.md.
 */

/** Markup with the entities React writes for text turned back into characters, to compare with titles. */
const plain = (html: string) => html.replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const hrefs = (html: string) => [...html.matchAll(/<a[^>]* href="([^"]+)"/g)].map((m) => plain(m[1]!));

const entry = (id: string) => GUIDE.find((e) => e.id === id)!;
const GROUP: SettingsGroup = { id: "set-backups", area: "Operations", title: "Backup schedule", description: "When backups run.", href: "/admin/backups", rows: [{ name: "Retention", key: "retention", help: "Backups kept.", default: "14" }] };

describe("contents tree", () => {
  it("links every entry, marks the page being read and opens its category only", () => {
    const html = renderToStaticMarkup(<GuideSidebar entries={GUIDE} base={GUIDE_ADMIN_BASE} current="backups" />);
    expect(hrefs(html).sort()).toEqual([GUIDE_ADMIN_BASE, ...GUIDE.map((e) => `${GUIDE_ADMIN_BASE}/${e.id}`)].sort());
    expect([...html.matchAll(/<a[^>]*aria-current="page"[^>]*>/g)].map((m) => /href="([^"]+)"/.exec(m[0])![1])).toEqual([`${GUIDE_ADMIN_BASE}/backups`]);
    // One <details> per category; only the category of "backups" (Operations) is open.
    const open = [...html.matchAll(/<details([^>]*)><summary[^>]*><span>([^<]+)<\/span>/g)].filter((m) => m[1]!.includes("open")).map((m) => plain(m[2]!));
    expect(open).toEqual([entry("backups").section]);
  });

  it("on the manual's home marks the home link and opens the first category", () => {
    const html = renderToStaticMarkup(<GuideSidebar entries={GUIDE} base={GUIDE_PUBLIC_BASE} />);
    expect([...html.matchAll(/<a[^>]*aria-current="page"[^>]*>/g)].map((m) => /href="([^"]+)"/.exec(m[0])![1])).toEqual([GUIDE_PUBLIC_BASE]);
    const open = [...html.matchAll(/<details([^>]*)><summary[^>]*><span>([^<]+)<\/span>/g)].filter((m) => m[1]!.includes("open")).map((m) => plain(m[2]!));
    expect(open).toEqual([guideReadingOrder(GUIDE)[0]!.section]);
  });

  it("holds only what an author may read", () => {
    const html = renderToStaticMarkup(<GuideSidebar entries={guideFor(false)} base={GUIDE_ADMIN_BASE} />);
    const linked = new Set(hrefs(html));
    for (const e of GUIDE) expect(linked.has(`${GUIDE_ADMIN_BASE}/${e.id}`), e.id).toBe(!e.adminOnly);
  });

  it("is shown once at any width and never printed", () => {
    const html = renderToStaticMarkup(<GuideLayout sidebar={<nav>tree</nav>}><p>page</p></GuideLayout>);
    // Two copies of the tree: one folded away below the lg breakpoint, the other hidden until it.
    expect(html.match(/<nav>tree<\/nav>/g)).toHaveLength(2);
    expect(html).toMatch(/<details class="[^"]*lg:hidden[^"]*">/);
    expect(html).toMatch(/<div class="hidden [^"]*lg:block[^"]*"><nav>tree<\/nav><\/div>/);
    expect(html).toMatch(/^<div[^>]*><div class="print:hidden">/);
  });
});

describe("article page", () => {
  it("shows the trail, the text, where the page is, its settings, related entries and the neighbours", () => {
    const e = entry("backups");
    const html = renderToStaticMarkup(<GuideArticle entry={e} entries={GUIDE} base={GUIDE_ADMIN_BASE} linkToAdmin settings={[GROUP]} />);
    const text = plain(html);
    expect(text).toContain(`<h1 class="mt-1 text-2xl font-semibold tracking-tight text-fg [overflow-wrap:anywhere]">${e.title}</h1>`);
    expect(text).toContain(e.summary);
    for (const line of e.body) expect(text, line).toContain(line.replace(/^- /, ""));
    // Breadcrumbs: the manual, the category (the home page filtered to it), then the entry itself (not a link).
    expect(guideCrumbs(e, GUIDE_ADMIN_BASE).map((c) => c.path)).toEqual([GUIDE_ADMIN_BASE, `${GUIDE_ADMIN_BASE}?area=${encodeURIComponent(e.section)}`, `${GUIDE_ADMIN_BASE}/backups`]);
    const links = hrefs(html);
    expect(links).toContain(GUIDE_ADMIN_BASE);
    expect(links).toContain(`${GUIDE_ADMIN_BASE}?area=${encodeURIComponent(e.section)}`);
    // On this page: one link per section that is there.
    expect(links.filter((h) => h.startsWith("#"))).toEqual(["#overview", "#where", "#settings", "#related"]);
    for (const id of ["overview", "where", "settings", "related"]) expect(html).toContain(`<section id="${id}"`);
    // The admin page it describes, as a link; its settings with their defaults.
    expect(links).toContain(e.href);
    expect(text).toContain("Backup schedule");
    expect(text).toMatch(/Retention<span[^>]*>retention<\/span><\/td><td[^>]*>Backups kept\.<\/td><td[^>]*>14<\/td>/);
    // Previous and next in reading order.
    const { previous, next } = guideNeighbours(GUIDE, "backups");
    expect(links).toContain(`${GUIDE_ADMIN_BASE}/${previous!.id}`);
    expect(links).toContain(`${GUIDE_ADMIN_BASE}/${next!.id}`);
    expect(text).toContain("For: admins<");
    expect(text).toContain(`Page ${guideReadingOrder(GUIDE).findIndex((x) => x.id === "backups") + 1} of ${GUIDE.length}`);
  });

  it("on the public manual names the admin page without linking into the admin", () => {
    const e = entry("posts");
    const html = renderToStaticMarkup(<GuideArticle entry={e} entries={GUIDE} base={GUIDE_PUBLIC_BASE} linkToAdmin={false} settings={[]} />);
    expect(hrefs(html).filter((h) => h.startsWith("/admin"))).toEqual([]);
    expect(plain(html)).toContain(`<span class="font-mono text-fg">${e.href}</span>`);
    expect(html).not.toContain('id="settings"');
    expect(plain(html)).toContain("For: admins and authors<");
  });

  it("shows a diagram where the entry has one, and an answer for a question", () => {
    const tour = renderToStaticMarkup(<GuideArticle entry={entry("tour")} entries={GUIDE} base={GUIDE_PUBLIC_BASE} linkToAdmin={false} settings={[]} />);
    expect(tour).toContain('<section id="diagram"');
    expect(tour).toContain(`src="/guide/${entry("tour").diagram!.name}.drawio.svg"`);
    expect(tour).toContain('loading="eager"');
    const faq = GUIDE.find((e) => e.kind === "faq")!;
    const html = renderToStaticMarkup(<GuideArticle entry={faq} entries={GUIDE} base={GUIDE_PUBLIC_BASE} linkToAdmin={false} settings={[]} />);
    expect(plain(html)).toMatch(/Question · /);
    expect(html).toContain(">Answer</h2>");
  });

  it("leaves an author's neighbours and related entries inside what an author may read", () => {
    const entries = guideFor(false);
    const e = entries.find((x) => x.id === "posts")!;
    const html = renderToStaticMarkup(<GuideArticle entry={e} entries={entries} base={GUIDE_ADMIN_BASE} linkToAdmin settings={[]} />);
    const adminOnly = new Set(GUIDE.filter((x) => x.adminOnly).map((x) => `${GUIDE_ADMIN_BASE}/${x.id}`));
    expect(hrefs(html).filter((h) => adminOnly.has(h))).toEqual([]);
  });
});

describe("printing", () => {
  it("has the whole manual on one page: contents, every entry, the settings reference", () => {
    const html = renderToStaticMarkup(<GuidePrint entries={GUIDE} settings={[GROUP]} base={GUIDE_ADMIN_BASE} linkToAdmin siteName="Example" />);
    const text = plain(html);
    for (const e of GUIDE) {
      expect(text, e.id).toContain(`>${e.title}</h3>`);
      expect(html, e.id).toContain(`<a href="#${e.id}"`);
      expect(html, e.id).toContain(`id="${e.id}"`);
    }
    expect(text).toContain("Settings reference");
    expect(text).toContain("Backup schedule");
    expect(text).toContain(`${GUIDE.length} pages and 1 settings`);
  });

  it("hides the site's and the admin's chrome, and the manual's own markup is not caught by that rule", () => {
    expect(GUIDE_PRINT_CSS).toContain("@media print");
    expect(GUIDE_PRINT_CSS).toMatch(/header, footer/);
    const pages = [
      renderToStaticMarkup(<GuideArticle entry={entry("backups")} entries={GUIDE} base={GUIDE_ADMIN_BASE} linkToAdmin settings={[GROUP]} />),
      renderToStaticMarkup(<GuidePrint entries={GUIDE} settings={[GROUP]} base={GUIDE_PUBLIC_BASE} linkToAdmin={false} siteName="Example" />),
    ];
    for (const html of pages) {
      expect(html).not.toMatch(/<(header|footer)[\s>]/);
      expect(html).not.toContain('class="announcement');
    }
  });
});
