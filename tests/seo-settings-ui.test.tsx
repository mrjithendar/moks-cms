import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { schema, type Db } from "@/db";
import type { SessionUser } from "@/lib/session";
import { freshDb } from "./db-helpers";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ getAll: () => [] }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }), usePathname: () => "/admin/automation", useSearchParams: () => new URLSearchParams(), redirect: () => {}, notFound: () => {} }));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));
const admin: SessionUser = { id: "admin", name: "Admin", email: "admin@example.com", role: "admin", emailVerified: true, image: null, sessionCreatedAt: new Date() };
vi.mock("@/lib/session", () => ({ getSessionUser: async () => admin, requireRole: async () => admin, requireUser: async () => admin }));

const meta = await import("@/lib/seo-intel/settings-meta");
const { DEFAULT_SEO_SETTINGS, publicSettings } = await import("@/lib/seo-intel/settings");

let db: Db;
beforeAll(async () => {
  db = await freshDb();
  await db.insert(schema.user).values({ id: "admin", name: "Admin", email: "admin@example.com", role: "admin" });
});
afterEach(() => vi.unstubAllEnvs());

describe("settings metadata", () => {
  const d = publicSettings(DEFAULT_SEO_SETTINGS) as unknown as Parameters<typeof meta.leafPaths>[0];

  it("every settings section has a tab and every help text points at a real field", () => {
    const sections = Object.keys(DEFAULT_SEO_SETTINGS).filter((k) => k !== "llmKey");
    for (const s of sections) expect(meta.tabOf(s), s).not.toBe("other");
    for (const p of Object.keys(meta.FIELD_HELP)) expect(meta.getIn(d, p), p).not.toBeUndefined();
  });

  it("changedPaths finds leaf differences, arrays as leaves", () => {
    const changed = { ...(d as object), thresholds: { ...DEFAULT_SEO_SETTINGS.thresholds, lowCtrRatio: 0.5, brandTerms: ["jithendar", "jd"] } } as never;
    expect(meta.changedPaths(d, changed)).toEqual(["thresholds.brandTerms", "thresholds.lowCtrRatio"]);
    expect(meta.changedPaths(d, d)).toEqual([]);
  });

  it("issuesByPath maps server validation issues to fields", () => {
    expect(meta.issuesByPath(["thresholds.lowCtrRatio: Number must be greater than or equal to 0.05", "something general"])).toEqual({
      "thresholds.lowCtrRatio": ["Number must be greater than or equal to 0.05"],
      "": ["something general"],
    });
  });
});

describe("settings page", () => {
  type PageFn = (props?: { searchParams?: Promise<{ section?: string }> }) => Promise<React.ReactElement>;
  const page = async (section?: string) => {
    const Page = (await import("@/app/admin/(growth)/automation/page")).default as PageFn;
    return renderToStaticMarkup(await Page(section ? { searchParams: Promise.resolve({ section }) } : undefined));
  };

  it("opens on Overview with the list of sections; no secret values", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "pk-secret-value");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-secret-value");
    const html = await page();
    expect(html).toContain("AI &amp; SEO settings");
    expect(html).toContain("Connections");
    expect(html).toContain("PageSpeed Insights / CrUX");
    // Every section is in the list (links on a wide screen, a select on a narrow one), and Overview is the open one.
    const { AI_SEO_SECTIONS } = await import("@/app/admin/(growth)/automation/sections");
    for (const s of AI_SEO_SECTIONS) expect(html, s.id).toContain(`href="/admin/automation?section=${s.id}"`);
    expect(html).toMatch(/<a[^>]*aria-current="page"[^>]*>Overview/);
    expect(html).not.toContain("Google properties");
    expect(html).not.toContain("pk-secret-value");
    expect(html).not.toContain("sk-ant-secret-value");
  });

  it("shows one area of the SEO settings as a section of its own, without the tab strip", async () => {
    const html = await page("data");
    expect(html).toContain("Google properties");
    expect(html).toContain("All changes saved");
    expect(html).not.toContain('role="tablist"');
    expect(html).not.toContain("Scoring weights"); // another area's card
    expect(html).not.toContain("Connections"); // another section
    expect(html).toMatch(/<a[^>]*aria-current="page"[^>]*>Data sources/);
    expect(await page("no-such-section")).toContain("Connections"); // an unknown section opens the first
  });

  it("the form on its own still has the tab strip and every area", async () => {
    const { SettingsForm } = await import("@/components/seo/SettingsForm");
    const html = renderToStaticMarkup(<SettingsForm initial={publicSettings(DEFAULT_SEO_SETTINGS)} />);
    expect(html).toContain('role="tablist"');
    for (const t of meta.SETTINGS_TABS) expect(html).toContain(`>${t.label.replace("&", "&amp;")}`);
    expect(html).toContain("Google properties"); // first tab open
  });

  it("every section has its own file, a unique id, and the SEO areas are the settings tabs", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { AI_SEO_SECTIONS } = await import("@/app/admin/(growth)/automation/sections");
    const ids = AI_SEO_SECTIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ["overview", "llm-providers", "llm-budget", "agent-limits", "ask-the-blog", "ml", "mcp"]) expect(ids).toContain(id);
    for (const t of meta.SETTINGS_TABS) expect(ids, t.id).toContain(t.id); // an old #tab-<id> link maps onto ?section=<id>
    const dir = path.resolve(import.meta.dirname, "../src/app/admin/(growth)/automation/sections");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".tsx") && f !== "seo-area.tsx").map((f) => f.replace(/\.tsx$/, ""));
    expect(files.sort()).toEqual(ids.map((id) => (meta.SETTINGS_TABS.some((t) => t.id === id) ? `seo-${id}` : id)).sort());
  });

  it("an area saved on its own is laid over the stored document; the rest is not touched", async () => {
    const { saveSeoSettings, getSeoSettings } = await import("@/lib/seo-intel/settings");
    const { saveBody } = await import("@/components/seo/SettingsForm");
    const { llmKeySet: _k, ...doc } = publicSettings(DEFAULT_SEO_SETTINGS) as unknown as Record<string, unknown>;
    void _k;
    await saveSeoSettings({ ...doc, crawler: { ...DEFAULT_SEO_SETTINGS.crawler, maxPages: 123 } }, "admin");
    // Another admin's page was loaded before that save: its copy of the crawler section is stale, and is not sent.
    const stale = { ...doc, reports: { ...DEFAULT_SEO_SETTINGS.reports, emailEnabled: !DEFAULT_SEO_SETTINGS.reports.emailEnabled } } as never;
    const body = saveBody(stale, ["reports"], "", false);
    expect(Object.keys(body).sort()).toEqual(["only", "reports"]);
    await saveSeoSettings(body, "admin");
    const now = await getSeoSettings();
    expect(now.crawler.maxPages).toBe(123);
    expect(now.reports.emailEnabled).toBe(!DEFAULT_SEO_SETTINGS.reports.emailEnabled);
    // The whole-document body is unchanged, and the key travels only with the section that shows it.
    expect(saveBody(stale, null, "sk-x", false)).toMatchObject({ llmApiKey: "sk-x", clearLlmKey: false, crawler: doc.crawler });
    expect(saveBody(stale, ["llm"], "sk-x", true)).toMatchObject({ only: ["llm"], llmApiKey: "sk-x", clearLlmKey: true });
    expect(saveBody(stale, ["reports"], "sk-x", true)).not.toHaveProperty("llmApiKey");
    for (const bad of [{ only: [] }, { only: ["nope"], nope: {} }, { only: ["reports", 7], reports: doc.reports }]) await expect(saveSeoSettings(bad, "admin")).rejects.toThrow(/not valid/);
    await expect(saveSeoSettings({ only: ["reports"] }, "admin")).rejects.toThrow(/not valid/); // the named section must be sent
  });

  it("connection rows reflect configuration (PageSpeed on with a key = ok; agent without token = down)", async () => {
    const { saveSeoSettings } = await import("@/lib/seo-intel/settings");
    const { loadConnections } = await import("@/components/seo/IntegrationStatus");
    const base = publicSettings(DEFAULT_SEO_SETTINGS) as unknown as Record<string, unknown> & { google: typeof DEFAULT_SEO_SETTINGS.google };
    const { llmKeySet: _k, ...doc } = base;
    void _k;
    await saveSeoSettings({ ...doc, google: { ...base.google, pageSpeed: { enabled: true } } }, "admin");
    const rows = await loadConnections({ PAGESPEED_API_KEY: "k", SEO_ORCHESTRATOR: "crewai" });
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(by.pagespeed!.status).toBe("ok");
    expect(by.agent!.status).toBe("down");
    expect(by.claude!.status).toBe("not configured");
    const noKey = Object.fromEntries((await loadConnections({ SEO_ORCHESTRATOR: "legacy" })).map((r) => [r.key, r]));
    expect(noKey.pagespeed!.status).toBe("degraded");
    expect(noKey.agent!.status).toBe("not configured");
  });
});
