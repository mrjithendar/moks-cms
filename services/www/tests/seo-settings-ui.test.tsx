import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { schema, type Db } from "@/db";
import type { SessionUser } from "@/lib/session";
import { freshDb } from "./db-helpers";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ getAll: () => [] }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }), usePathname: () => "/admin/seo/settings", redirect: () => {}, notFound: () => {} }));
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
  it("renders connections, the tab bar and the first tab; no secret values", async () => {
    vi.stubEnv("PAGESPEED_API_KEY", "pk-secret-value");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-secret-value");
    const Page = (await import("@/app/admin/seo/settings/page")).default as () => Promise<React.ReactElement>;
    const html = renderToStaticMarkup(await Page());
    expect(html).toContain("Connections");
    expect(html).toContain("PageSpeed Insights / CrUX");
    expect(html).toContain('role="tablist"');
    for (const t of meta.SETTINGS_TABS) expect(html).toContain(`>${t.label.replace("&", "&amp;")}`);
    expect(html).toContain("Google properties"); // first tab open
    expect(html).not.toContain("pk-secret-value");
    expect(html).not.toContain("sk-ant-secret-value");
    expect(html).toContain("All changes saved");
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
