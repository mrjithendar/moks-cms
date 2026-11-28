import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { schema } from "@/db";
import type { SessionUser } from "@/lib/session";
import { freshDb } from "./db-helpers";

/**
 * The Settings area (owner, 2026-11-26: "reorganize all CMS settings into one centralized settings experience"):
 * lib/settings-areas.ts says where every section lives, app/admin/settings/sections what each draws, and
 * app/admin/settings/[category]/page.tsx draws one at a time. These tests keep the three in step, keep every form in one
 * place, and check the old addresses.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ getAll: () => [], get: () => undefined }) }));
const redirects: string[] = [];
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => "/admin/settings",
  useSearchParams: () => new URLSearchParams(),
  redirect: (to: string) => {
    redirects.push(to);
    throw Object.assign(new Error("NEXT_REDIRECT"), { digest: `NEXT_REDIRECT;replace;${to};307;` });
  },
  notFound: () => {
    throw Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
  },
}));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));
const admin: SessionUser = { id: "admin", name: "Admin", email: "admin@example.com", role: "admin", emailVerified: true, image: null, sessionCreatedAt: new Date() };
vi.mock("@/lib/session", () => ({ getSessionUser: async () => admin, requireRole: async () => admin, requireUser: async () => admin }));
let agentInstalled = true;
vi.mock("@/lib/modules", async (orig) => ({
  ...(await orig<typeof import("@/lib/modules")>()),
  moduleState: async () => ({ id: "seo-agent", label: "SEO agent", installed: agentInstalled, available: false, version: null, reason: "Not reachable in tests.", menuGroups: ["ai"], setupHref: "" }),
}));

const areas = await import("@/lib/settings-areas");
const { SETTINGS_CATEGORIES, SETTINGS_SECTIONS, settingsHref, movedTo, OLD_ADDRESSES, visibleCategories, settingsMenuItems, searchSettings } = areas;

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (f: string) => readFileSync(path.join(ROOT, f), "utf8");
function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(path.join(ROOT, dir))) {
    const rel = path.join(dir, name);
    if (statSync(path.join(ROOT, rel)).isDirectory()) files(rel, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(rel);
  }
  return out;
}

type PageFn = (props: { params: Promise<{ category: string }>; searchParams: Promise<Record<string, string>> }) => Promise<React.ReactElement>;
async function page(category: string, section?: string) {
  const Page = (await import("@/app/admin/settings/[category]/page")).default as unknown as PageFn;
  return renderToStaticMarkup(await Page({ params: Promise.resolve({ category }), searchParams: Promise.resolve<Record<string, string>>(section ? { section } : {}) }));
}

beforeAll(async () => {
  const db = await freshDb();
  await db.insert(schema.user).values({ id: "admin", name: "Admin", email: "admin@example.com", role: "admin" });
});
beforeEach(() => {
  redirects.length = 0;
  agentInstalled = true;
});

describe("where every setting lives (lib/settings-areas.ts)", () => {
  it("has unique section ids, known categories, and no empty category", () => {
    const ids = SETTINGS_SECTIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    const cats = new Set(SETTINGS_CATEGORIES.map((c) => c.id));
    for (const s of SETTINGS_SECTIONS) expect(cats.has(s.category), s.id).toBe(true);
    for (const c of SETTINGS_CATEGORIES) expect(SETTINGS_SECTIONS.some((s) => s.category === c.id), c.id).toBe(true);
    // Sections of one category are next to each other, in the order the menu lists the categories.
    const order = SETTINGS_SECTIONS.map((s) => s.category).filter((c, i, a) => a[i - 1] !== c);
    expect(order).toEqual(SETTINGS_CATEGORIES.map((c) => c.id));
  });

  it("draws every section and nothing else (app/admin/settings/sections)", async () => {
    const { SECTION_RENDERS } = await import("@/app/admin/settings/sections");
    expect(Object.keys(SECTION_RENDERS).sort()).toEqual(SETTINGS_SECTIONS.map((s) => s.id).sort());
  });

  it("gives every runtime-settings group its own section, and saving one returns to it", async () => {
    const { GROUPS, settingHref } = await import("@/lib/runtime-settings");
    for (const g of GROUPS) expect(settingHref(g.id), g.id).toBe(settingsHref(g.id));
    expect(settingHref("razorpay")).toBe("/admin/settings/payments?section=razorpay");
    expect(settingHref("calcom")).toBe("/admin/settings/payments?section=calcom");
    expect(read("src/app/admin/_actions/runtime-settings.ts")).toContain("flash(group ? settingHref(group.id)");
  });

  it("makes an address for a section and refuses an unknown one", () => {
    expect(settingsHref("social")).toBe("/admin/settings/access?section=social");
    expect(settingsHref("llm", "llm-budget")).toBe("/admin/settings/ai?section=llm#llm-budget");
    expect(() => settingsHref("nope")).toThrow(/Unknown settings section/);
  });

  it("hides the SEO agent's sections, and a category with nothing else, while the agent is not set up", () => {
    const without = visibleCategories({ seoAgent: false });
    expect(without.map((c) => c.id)).not.toContain("assistants");
    // LiteLLM's section is the web app's own (D-110): shown with or without the agent.
    expect(without.find((c) => c.id === "ai")!.sections.map((s) => s.id)).toEqual(["llm", "gemini", "image-limits", "video-generation"]);
    expect(without.find((c) => c.id === "agent")!.sections.map((s) => s.id)).toEqual(["seo-agent"]); // where it is set up
    expect(without.find((c) => c.id === "seo")!.sections.map((s) => s.id)).toEqual(["verification", "search-console"]);
    expect(visibleCategories({ seoAgent: true }).map((c) => c.id)).toEqual(SETTINGS_CATEGORIES.map((c) => c.id));
    expect(settingsMenuItems({ seoAgent: false }).map((i) => i.href)).not.toContain("/admin/settings/assistants");
    expect(settingsMenuItems({ seoAgent: true })[0]).toEqual({ href: "/admin/settings", label: "All settings", section: "Settings" });
  });

  it("finds a section by its name, category, keywords or the fields in it", () => {
    const ids = (q: string, extra?: Record<string, string[]>) => searchSettings(SETTINGS_SECTIONS, q, extra).map((s) => s.id);
    expect(ids("adsense")).toEqual(["analytics"]);
    expect(ids("smtp")).toEqual(["email"]);
    expect(ids("razorpay")).toContain("razorpay");
    expect(ids("payments webhook")).toEqual(["razorpay", "calcom"]);
    expect(ids("Largest side", { avatars: ["Largest side (px)"] })).toEqual(["avatars"]);
    expect(ids("  ")).toEqual([]);
  });
});

describe("one home per form", () => {
  it("draws runtime-settings groups and the moved forms only in Settings", () => {
    const outside = files("src/app").filter((f) => !f.startsWith(path.join("src", "app", "admin", "settings")));
    for (const f of outside) {
      const src = read(f);
      expect(src, f).not.toContain("<RuntimeSettings");
      expect(src, f).not.toContain("PromotionSettingsForm settings=");
      expect(src, f).not.toContain("<RepoSettingsForm");
      expect(src, f).not.toContain('JobSettingsCard group="fetching"');
      expect(src, f).not.toContain("savePracticeSettings(");
      expect(src, f).not.toContain("saveInvoiceSettings(");
      expect(src, f).not.toMatch(/\bsaveGeneral\(|\bsaveDestination\(/);
    }
  });

  it("links every settings address in the code to a section of its own category", () => {
    const bad: string[] = [];
    for (const f of [...files("src"), ...files("tests")]) {
      for (const m of read(f).matchAll(/\/admin\/settings\/([a-z]+)\?section=([a-z0-9-]+)/g)) {
        const s = areas.settingsSection(m[2]!);
        if (!s || s.category !== m[1]) bad.push(`${f}: ${m[0]}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("lists no settings page outside the Settings group of the menu", async () => {
    const { MENU_PLACES } = await import("@/lib/admin-menu");
    const settingsPages = MENU_PLACES.filter(([href]) => /^\/admin\/(settings|integrations|storage|email|automation(\?|$)|invoices\/settings)/.test(href));
    for (const [href, place] of settingsPages) expect(place.group, href).toBe("settings");
    expect(MENU_PLACES.filter(([, p]) => p.group === "settings").map(([href]) => href)).toEqual(["/admin/settings", ...SETTINGS_CATEGORIES.map((c) => `/admin/settings/${c.id}`)]);
  });
});

describe("the Settings pages", () => {
  it("draw every section under its category: the open one marked, the category's others listed, no error", async () => {
    for (const s of SETTINGS_SECTIONS) {
      if (s.id === "move-media") continue; // listed only with media on the old S3 bucket; drawn below by address
      const html = await page(s.category, s.id);
      // A category of one section is one entry in the list: the category is the open one.
      const single = SETTINGS_SECTIONS.filter((x) => x.category === s.category).length === 1;
      const marked = single ? areas.settingsCategory(s.category)!.label : s.label;
      expect(html, s.id).toMatch(new RegExp(`aria-current="page"[^>]*>(<span[^>]*>)?${marked.replace("&", "&amp;").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}<`));
      if (!single) for (const other of SETTINGS_SECTIONS.filter((x) => x.category === s.category && x.id !== "move-media")) expect(html, `${s.id} lists ${other.id}`).toContain(`href="${settingsHref(other.id).replace("&", "&amp;")}"`);
      for (const c of SETTINGS_CATEGORIES) expect(html, `${s.id} lists ${c.id}`).toContain(`href="/admin/settings/${c.id}"`);
    }
    expect(await page("storage", "move-media")).toContain("Move existing media from S3 to R2");
  }, 60_000);

  it("open a category on its first section, and send a section asked under another category to its own address", async () => {
    expect(await page("access")).toMatch(/aria-current="page"[^>]*><span[^>]*>Social sign-in</);
    await expect(page("access", "smtp-nope")).resolves.toMatch(/aria-current="page"[^>]*><span[^>]*>Social sign-in</);
    await expect(page("access", "razorpay")).rejects.toThrow("NEXT_REDIRECT");
    expect(redirects).toEqual(["/admin/settings/payments?section=razorpay"]);
    await expect(page("nope")).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("say how to set up the SEO agent when one of its sections is opened while it is not set up", async () => {
    agentInstalled = false;
    const html = await page("assistants", "mcp");
    expect(html).toContain("The SEO agent is not set up");
    expect(html).toContain(`href="${settingsHref("seo-agent")}"`);
    expect(html).not.toContain("Admin server");
    const ai = await page("ai");
    expect(ai).toMatch(/aria-current="page"[^>]*><span[^>]*>LiteLLM</); // the first section it can show
    expect(ai).not.toContain("LLM providers &amp; budget");
  });

  it("show every category with its sections on the overview, and the field names for its search", async () => {
    const Page = (await import("@/app/admin/settings/page")).default as unknown as (p: { searchParams: Promise<{ q?: string }> }) => Promise<React.ReactElement>;
    const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve({}) }));
    for (const c of SETTINGS_CATEGORIES) expect(html, c.id).toContain(`href="/admin/settings/${c.id}"`);
    for (const s of SETTINGS_SECTIONS) expect(html, s.id).toContain(`href="${settingsHref(s.id)}"`);
    expect(html).toContain("Search settings");
  });
});

describe("old addresses", () => {
  it("send every old section to the section that has it now, keeping the rest of the query", () => {
    for (const [old, map] of Object.entries(OLD_ADDRESSES)) for (const id of Object.values(map)) expect(areas.settingsSection(id), `${old} → ${id}`).toBeDefined();
    expect(movedTo("/admin/integrations", {})).toBe("/admin/settings/access?section=social");
    expect(movedTo("/admin/integrations", { section: "rag", q: "kubernetes ingress" })).toBe("/admin/settings/integrations?section=rag&q=kubernetes+ingress");
    expect(movedTo("/admin/integrations", { section: "gemini-title" })).toBe("/admin/settings/ai?section=gemini");
    expect(movedTo("/admin/storage", { section: "move", plan: "1" })).toBe("/admin/settings/storage?section=move-media&plan=1");
    expect(movedTo("/admin/email", { section: "test", ok: "Sent." })).toBe("/admin/settings/email?section=email-test&ok=Sent.");
    expect(movedTo("/admin/invoices/settings", {})).toBe("/admin/settings/payments?section=invoices");
    expect(movedTo("/admin/integrations", { section: "unknown" })).toBe("/admin/settings/access?section=social");
    expect(() => movedTo("/admin/nope", {})).toThrow();
  });

  it("redirect from the old pages", async () => {
    const pages: [string, string, Record<string, string>, string][] = [
      ["/admin/integrations", "@/app/admin/integrations/page", { section: "analytics" }, "/admin/settings/integrations?section=analytics"],
      ["/admin/storage", "@/app/admin/storage/page", {}, "/admin/settings/storage?section=media-storage"],
      ["/admin/email", "@/app/admin/email/page", { section: "provider" }, "/admin/settings/email?section=email"],
      ["/admin/invoices/settings", "@/app/admin/invoices/settings/page", {}, "/admin/settings/payments?section=invoices"],
      ["/admin/automation", "@/app/admin/(growth)/automation/page", { section: "llm-budget", scope: "day" }, "/admin/settings/ai?section=llm&scope=day"], // D-110: the budget card is gone, so no anchor
    ];
    for (const [old, mod, query, to] of pages) {
      redirects.length = 0;
      const Page = (await import(/* @vite-ignore */ mod)).default as (p: { searchParams: Promise<Record<string, string>> }) => Promise<void>;
      await expect(Page({ searchParams: Promise.resolve(query) }), old).rejects.toThrow("NEXT_REDIRECT");
      expect(redirects, old).toEqual([to]);
    }
    redirects.length = 0;
    const Mcp = (await import("@/app/admin/(growth)/automation/mcp/page")).default as () => void;
    expect(() => Mcp()).toThrow("NEXT_REDIRECT");
    expect(redirects).toEqual(["/admin/settings/assistants?section=mcp#mcp-clients-h"]);
    const Advanced = (await import("@/app/admin/advanced/page")).default as () => void;
    expect(() => Advanced()).toThrow("NEXT_REDIRECT");
    expect(redirects.at(-1)).toBe("/admin/settings");
  });
});
