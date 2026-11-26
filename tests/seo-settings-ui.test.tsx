import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { schema, type Db } from "@/db";
import type { SessionUser } from "@/lib/session";
import { freshDb } from "./db-helpers";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ getAll: () => [] }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }), usePathname: () => "/admin/settings/seo", useSearchParams: () => new URLSearchParams(), redirect: () => {}, notFound: () => {} }));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));
const admin: SessionUser = { id: "admin", name: "Admin", email: "admin@example.com", role: "admin", emailVerified: true, image: null, sessionCreatedAt: new Date() };
vi.mock("@/lib/session", () => ({ getSessionUser: async () => admin, requireRole: async () => admin, requireUser: async () => admin }));
// The SEO agent's sections of Settings are listed only while the agent is set up (lib/modules.ts): here it is.
vi.mock("@/lib/modules", async (orig) => ({
  ...(await orig<typeof import("@/lib/modules")>()),
  moduleState: async () => ({ id: "seo-agent", label: "SEO agent", installed: true, available: false, version: null, reason: "Not reachable in tests.", menuGroups: ["ai"], setupHref: "" }),
}));

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

describe("the SEO agent's sections of Settings (AI & SEO → Settings until 2026-11-26)", () => {
  type PageFn = (props: { params: Promise<{ category: string }>; searchParams: Promise<Record<string, string>> }) => Promise<React.ReactElement>;
  const page = async (category: string, section?: string) => {
    const Page = (await import("@/app/admin/settings/[category]/page")).default as unknown as PageFn;
    return renderToStaticMarkup(await Page({ params: Promise.resolve({ category }), searchParams: Promise.resolve<Record<string, string>>(section ? { section } : {}) }));
  };

  it("SEO agent opens on Connection: the agent's endpoint and the connections; every section of the category is listed; no secret values", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "pk-secret-value");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-secret-value");
    const html = await page("agent");
    expect(html).toContain("SEO agent");
    expect(html).toContain("Connections");
    expect(html).toContain("PageSpeed Insights / CrUX");
    for (const id of ["seo-agent", "agent-limits", "runs", "content-fetching", "crewai-repository"]) expect(html, id).toContain(`href="/admin/settings/agent?section=${id}"`);
    expect(html).toMatch(/<a[^>]*aria-current="page"[^>]*><span[^>]*>Connection</);
    expect(html).not.toContain("All changes saved"); // no settings form: that is another section
    expect(html).not.toContain("pk-secret-value");
    expect(html).not.toContain("sk-ant-secret-value");
  });

  it("shows one area of the SEO settings as a section of its own, without the tab strip", async () => {
    const html = await page("seo", "data");
    expect(html).toContain("Google properties");
    expect(html).toContain("All changes saved");
    expect(html).not.toContain('role="tablist"');
    expect(html).not.toContain("Scoring weights"); // another area's card
    expect(html).not.toContain("Connections"); // another section
    expect(html).toMatch(/<a[^>]*aria-current="page"[^>]*><span[^>]*>Data sources/);
    expect(await page("seo", "no-such-section")).toContain("Search engine verification"); // an unknown section opens the first
  });

  it("the form on its own still has the tab strip and every area", async () => {
    const { SettingsForm } = await import("@/components/seo/SettingsForm");
    const html = renderToStaticMarkup(<SettingsForm initial={publicSettings(DEFAULT_SEO_SETTINGS)} />);
    expect(html).toContain('role="tablist"');
    for (const t of meta.SETTINGS_TABS) expect(html).toContain(`>${t.label.replace("&", "&amp;")}`);
    expect(html).toContain("Google properties"); // first tab open
  });

  it("every section has its own file, the SEO areas are the settings tabs, and each is a section of Settings owned by the agent", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { AI_SEO_RENDERS } = await import("@/app/admin/(growth)/automation/sections");
    const { settingsSection } = await import("@/lib/settings-areas");
    const ids = Object.keys(AI_SEO_RENDERS);
    for (const id of ["llm", "agent-limits", "ask-the-blog", "ml", "mcp"]) expect(ids).toContain(id);
    for (const old of ["overview", "llm-providers", "llm-budget", "mcp-access"]) expect(ids, old).not.toContain(old); // merged; lib/settings-areas.ts OLD_ADDRESSES
    for (const t of meta.SETTINGS_TABS) expect(ids, t.id).toContain(t.id); // an old #tab-<id> link maps onto ?section=<id>
    for (const id of ids) expect(settingsSection(id)?.module, id).toBe("seo-agent");
    const dir = path.resolve(import.meta.dirname, "../src/app/admin/(growth)/automation/sections");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".tsx") && f !== "seo-area.tsx").map((f) => f.replace(/\.tsx$/, ""));
    expect(files.sort()).toEqual(ids.map((id) => (meta.SETTINGS_TABS.some((t) => t.id === id) ? `seo-${id}` : id)).sort());
  });

  it("an old address, or an id from before a merge, is sent on to the section that has it now", async () => {
    const { movedTo } = await import("@/lib/settings-areas");
    expect(movedTo("/admin/automation", { section: "llm-budget", scope: "day" })).toBe("/admin/settings/ai?section=llm&scope=day#llm-budget");
    expect(movedTo("/admin/automation", { section: "llm-providers" })).toBe("/admin/settings/ai?section=llm#llm-providers");
    expect(movedTo("/admin/automation", { section: "mcp-access" })).toBe("/admin/settings/assistants?section=mcp#mcp-clients-h");
    expect(movedTo("/admin/automation", { section: "overview" })).toBe("/admin/settings/agent?section=seo-agent");
    expect(movedTo("/admin/automation", {})).toBe("/admin/settings/agent?section=seo-agent");
    expect(movedTo("/admin/automation", { section: "data" })).toBe("/admin/settings/seo?section=data");
  });

  it("LLM providers & budget has the budget, the providers and this site's usage; MCP has the servers, the clients and their settings", async () => {
    const llm = await page("ai", "llm");
    expect(llm).toMatch(/<a[^>]*aria-current="page"[^>]*><span[^>]*>LLM providers &amp; budget/);
    // The ids the old addresses scroll to are there even while the SEO agent cannot be asked (as here).
    expect(llm).toContain('id="llm-budget"');
    expect(llm).toContain('id="llm-providers"');
    expect(llm).toContain("LLM usage this month");
    expect(llm.indexOf('id="llm-budget"')).toBeLessThan(llm.indexOf('id="llm-providers"'));
    expect(llm).toContain('href="/admin/settings/ai?section=llm&amp;scope=day"'); // the budget's Daily tab stays in this section
    const mcp = await page("assistants", "mcp");
    expect(mcp).toMatch(/<a[^>]*aria-current="page"[^>]*><span[^>]*>MCP</);
    expect(mcp).toContain("Admin server");
    expect(mcp).toContain('id="mcp-clients-h"');
    expect(mcp).toContain("No clients connected.");
    expect(mcp).not.toContain("Open MCP access"); // no link to a page that is now the same section
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
