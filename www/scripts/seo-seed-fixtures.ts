/**
 * DEMO / FIXTURE DATA — local development only.
 *
 * Fills the local PGlite database (.data/pglite) with invented Search Console and GA4 rows by running the real sync
 * code against the fake Google in tests/seo-fixtures.ts, so /admin/seo can be developed without credentials.
 * None of these numbers are jithendar.com's traffic. Refuses to run against a real database.
 *
 *   npx tsx scripts/seo-seed-fixtures.ts
 */
if (process.env.DATABASE_URL || process.env.APP_ENV === "production" || process.env.NODE_ENV === "production") {
  console.error("Refusing: fixture data is for the local PGlite database only (unset DATABASE_URL, APP_ENV=development).");
  process.exit(1);
}

const { fakeGoogle, FIXTURE_ENV, settingsInput } = await import("../tests/seo-fixtures");
const { saveSeoSettings } = await import("../src/lib/seo-intel/settings");
const { runSeoJob } = await import("../src/lib/seo-intel/jobs");

const today = new Date();
const end = new Date(today.getTime() - 86_400_000).toISOString().slice(0, 10);
const start = new Date(today.getTime() - 120 * 86_400_000).toISOString().slice(0, 10);
await saveSeoSettings(settingsInput(), "fixture-seed");
const deps = { fetchImpl: fakeGoogle().fetch, sleep: async () => {}, env: FIXTURE_ENV };
for (const type of ["gsc_backfill", "ga4_backfill"] as const) {
  const r = await runSeoJob({ type, trigger: "backfill", start, end, actor: "fixture-seed" }, deps);
  console.log(`${type}: ${r.status}, ${r.rows} fixture rows`);
}
console.log("Done. Start `npm run dev` with GOOGLE_SEO_SERVICE_ACCOUNT_JSON unset to see the 'disconnected' banner over fixture data,");
console.log("or with the fixture key to see the connected state. This is demo data only.");
export {};
