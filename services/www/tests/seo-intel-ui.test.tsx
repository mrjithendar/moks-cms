import { sql } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { schema, type Db } from "@/db";
import type { SessionUser } from "@/lib/session";
import { freshDb } from "./db-helpers";
import { NOW } from "./helpers";
import { fakeGoogle, FIXTURE_ENV, settingsInput } from "./seo-fixtures";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ getAll: () => [] }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }), usePathname: () => "/admin", redirect: () => {}, notFound: () => {} }));
const admin: SessionUser = { id: "admin", name: "Admin", email: "admin@example.com", role: "admin", emailVerified: true, image: null, sessionCreatedAt: new Date() };
vi.mock("@/lib/session", () => ({ getSessionUser: async () => admin, requireRole: async () => admin, requireUser: async () => admin }));

type PageFn = (p: { searchParams: Promise<Record<string, string | undefined>> }) => Promise<React.ReactElement>;
const PAGES: [string, () => Promise<{ default: unknown }>][] = [
  ["overview", () => import("@/components/seo/merged/SeoOverview").then((m) => ({ default: ({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) => searchParams.then((sp) => m.SeoOverview({ sp })) }))],
  ["search", () => import("@/app/admin/(growth)/search/page")],
  ["analytics", () => import("@/app/admin/(growth)/analytics/page")],
  ["pages", () => import("@/app/admin/(growth)/page-insights/page")],
  ["keywords", () => import("@/app/admin/(growth)/keywords/page")],
  ["integrations", () => import("@/components/seo/merged/SeoIntegrations").then((m) => ({ default: () => m.SeoIntegrations() }))],
  ["sync", () => import("@/app/admin/(growth)/sync/page")],
  ["settings", () => import("@/app/admin/(growth)/automation/page")],
  ["recommendations", () => import("@/app/admin/(growth)/recommendations/page")],
  ["content", () => import("@/app/admin/(growth)/content-audit/page")],
  ["links", () => import("@/app/admin/(growth)/links/page")],
  ["calendar", () => import("@/app/admin/(growth)/calendar/page")],
  ["technical", () => import("@/app/admin/(growth)/technical/page")],
  ["reports", () => import("@/app/admin/(growth)/reports/page")],
  ["models", () => import("@/app/admin/(growth)/models/page")],
  ["labels", () => import("@/app/admin/(growth)/models/labels/page")],
];
async function render(load: () => Promise<{ default: unknown }>, sp: Record<string, string> = {}) {
  const Page = (await load()).default as PageFn;
  return renderToStaticMarkup(await Page({ searchParams: Promise.resolve(sp) }));
}

let db: Db;
beforeAll(async () => {
  db = await freshDb();
  await db.insert(schema.user).values({ id: "admin", name: "Admin", email: "admin@example.com", role: "admin" });
});
afterEach(() => vi.unstubAllEnvs());

describe("search, analytics and calendar admin pages", () => {
  it.each(PAGES)("%s renders the disconnected / empty state without credentials", async (name, load) => {
    const html = await render(load);
    expect(html.length).toBeGreaterThan(200);
    if (["overview", "search", "analytics"].includes(name)) expect(html).toContain("Disconnected");
  });

  it("renders fixture data after a mocked sync (demo data, not real traffic)", async () => {
    const { saveSeoSettings } = await import("@/lib/seo-intel/settings");
    const { runSeoJob } = await import("@/lib/seo-intel/jobs");
    await saveSeoSettings(settingsInput(), "admin");
    const deps = { fetchImpl: fakeGoogle().fetch, sleep: async () => {}, env: FIXTURE_ENV, now: () => NOW };
    await runSeoJob({ type: "gsc_backfill", trigger: "backfill", start: "2026-09-27", end: "2026-10-26" }, deps);
    await runSeoJob({ type: "ga4_backfill", trigger: "backfill", start: "2026-09-27", end: "2026-10-26" }, deps);
    vi.stubEnv("GOOGLE_SEO_SERVICE_ACCOUNT_JSON", FIXTURE_ENV.GOOGLE_SEO_SERVICE_ACCOUNT_JSON);
    const overview = await render(PAGES[0]![1], { range: "28" });
    expect(overview).toContain("Organic clicks");
    expect(overview).toMatch(/Source: <\/dt><dd[^>]*>Search Console/);
    expect(overview).toMatch(/vs previous period|no comparison/);
    const search = await render(PAGES[1]![1], { range: "28" });
    expect(search).toContain("/blog/argo-cd-gitops");
    expect(search).toContain("partial coverage");
    const sync = await render(PAGES[6]![1]);
    expect(sync).toContain("gsc_backfill");
    for (const [, load] of PAGES) expect(await render(load, { range: "28" })).not.toMatch(/PRIVATE KEY|fixture-token/);
    // Article panel against a real post row.
    const [post] = await db.insert(schema.post).values({ collection: "blog", slug: "argo-cd-gitops", title: "Argo CD GitOps", description: "A description that is comfortably long for the meta description check in tests.", body: "## A\n\ntext", category: "kubernetes", contentType: "tutorial", status: "published", publishedAt: new Date("2026-05-01T00:00:00Z"), authorId: "admin" }).returning();
    const Panel = (await import("@/app/admin/posts/[id]/insights/page")).default as (p: { params: Promise<{ id: string }> }) => Promise<React.ReactElement>;
    const html = renderToStaticMarkup(await Panel({ params: Promise.resolve({ id: post!.id }) }));
    expect(html).toContain("Open in editor");
    expect(html).toContain("Ranking queries");
    const { generateReport } = await import("@/lib/seo-intel/reports");
    const rep = await generateReport("weekly", "manual", NOW);
    const ReportPage = (await import("@/app/admin/(growth)/reports/[id]/page")).default as (p: { params: Promise<{ id: string }> }) => Promise<React.ReactElement>;
    expect(renderToStaticMarkup(await ReportPage({ params: Promise.resolve({ id: rep.id }) }))).toContain("Organic performance");
    // The list shows the R2 PDF once report_flow stored one (the payload pointer storeReportPdf writes).
    const ReportsList = (await import("@/app/admin/(growth)/reports/page")).default as () => Promise<React.ReactElement>;
    expect(renderToStaticMarkup(await ReportsList())).toContain("Not generated");
    await db.execute(sql`update seo_reports set payload = payload || ${JSON.stringify({ pdf: { key: "jithendar/www/reports/seo/weekly/x.pdf", bytes: 48_000, generatedAt: NOW.toISOString(), filename: "seo-weekly-report.pdf" }, narrative: "ok" })}::jsonb where id = ${rep.id}`);
    const list = renderToStaticMarkup(await ReportsList());
    expect(list).toContain(`/api/admin/seo/reports/${rep.id}/pdf`);
    expect(list).toContain("47 KB · summary checked");
  });
});

