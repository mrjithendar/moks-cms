/**
 * E2E / demo seed — LOCAL PGlite ONLY (refuses DATABASE_URL and production). Invented data, not jithendar.com traffic.
 *
 * Creates an admin (e2e-admin@example.com / the password in E2E_ADMIN_PASSWORD), a published article that the fake
 * Claude (e2e/fake-services.mjs) knows how to edit, two link targets, recommendations, and Search Console / GA4 fixture
 * rows produced by running the real sync against the fake Google from tests/seo-fixtures.ts.
 *
 *   NODE_OPTIONS=--conditions=react-server PGLITE_DIR=/tmp/e2e-db E2E_ADMIN_PASSWORD='…' npx tsx scripts/e2e-seed.ts
 * (`react-server` lets the server-only modules load outside Next.js.)
 */
if (process.env.DATABASE_URL || process.env.APP_ENV === "production") {
  console.error("Refusing: the E2E seed is for a local PGlite database only.");
  process.exit(1);
}
const password = process.env.E2E_ADMIN_PASSWORD;
if (!password || password.length < 12) {
  console.error("Set E2E_ADMIN_PASSWORD (12+ characters).");
  process.exit(1);
}

const { sql } = await import("drizzle-orm");
const { getDb, schema } = await import("../src/db");
const { hashPassword } = await import("better-auth/crypto");
const { createOrPromoteAdmin } = await import("../src/lib/setup");
const { fakeGoogle, FIXTURE_ENV, settingsInput } = await import("../tests/seo-fixtures");
const { saveSeoSettings } = await import("../src/lib/seo-intel/settings");
const { runSeoJob } = await import("../src/lib/seo-intel/jobs");

const db = await getDb();
const adminId = await createOrPromoteAdmin(db, { name: "E2E Admin", email: "e2e-admin@example.com", hash: await hashPassword(password) });
await db.insert(schema.authorProfile).values({ userId: adminId, slug: "e2e-admin", displayName: "E2E Admin" }).onConflictDoNothing();

export const E2E_BODY = [
  "Kubernetes ingress controllers route external traffic to Services inside the cluster.",
  "",
  "## Install the controller",
  "",
  "Install it with Helm. The chart creates a Deployment, a Service of type LoadBalancer and the IngressClass that routes traffic for every Ingress in the cluster. This section walks through the values I changed and the ones I left at their defaults, because most outages I have seen start with a default nobody looked at.",
  "",
  "```bash",
  "helm install ingress-nginx ingress-nginx/ingress-nginx",
  "```",
  "",
  "## Terminate TLS",
  "",
  "Use cert-manager to issue certificates. A ClusterIssuer talks to Let's Encrypt and stores the certificate in a Secret that the Ingress references. Renewal is automatic, which is the main reason to prefer it over copying certificates by hand into every namespace that needs them.",
].join("\n");

const now = new Date();
const posts = [
  { slug: "e2e-ingress-tls", title: "Ingress and TLS on Kubernetes", seoTitle: "Ingress and TLS on Kubernetes: a worked example", body: E2E_BODY },
  { slug: "e2e-cert-manager", title: "Install a cert-manager ClusterIssuer for Let's Encrypt", seoTitle: null, body: `cert-manager ClusterIssuer setup for Let's Encrypt certificates. ${"Certificates renew automatically and the issuer stores them in a Secret. ".repeat(40)}` },
];
const ids: string[] = [];
for (const p of posts) {
  const [row] = await db
    .insert(schema.post)
    .values({ collection: "blog", slug: p.slug, title: p.title, description: "How to terminate TLS at a Kubernetes ingress controller with cert-manager, with a worked example and the failure modes to check first.", seoTitle: p.seoTitle, body: p.body, category: "kubernetes", tags: ["kubernetes"], contentType: "tutorial", status: "published", publishedAt: new Date(now.getTime() - 30 * 86_400_000), authorId: adminId })
    .onConflictDoNothing()
    .returning();
  if (row) ids.push(row.id);
}
const [article] = await db.select().from(schema.post).where(sql`slug = 'e2e-ingress-tls'`);
await saveSeoSettings({ ...settingsInput(), drafts: { ...settingsInput().drafts, digest: { ...settingsInput().drafts.digest, recipients: [] } } }, adminId);
for (const [category, problem] of [["low_ctr", "“kubernetes ingress tls” has impressions but few clicks (fixture)."], ["striking_distance", "Position ~8 for “ingress tls cert-manager” (fixture)."]] as const) {
  await db.execute(sql`
    insert into seo_recommendations (fingerprint, article_id, url, query, category, rule_key, problem, proposed_action, analysis_date, priority_score, priority_band, confidence, expected_impact)
    values (${`e2e-${category}`}, ${article!.id}, ${"https://jithendar.com/blog/e2e-ingress-tls"}, ${"kubernetes ingress tls"}, ${category}, ${`${category}.e2e`}, ${problem}, 'Improve the title and meta description.', ${now.toISOString().slice(0, 10)}, 0.8, 'high', 'medium', 'Qualitative')
    on conflict (fingerprint) do nothing`);
}
await db.execute(sql`insert into seo_url_map (url, path, article_id) values ('https://jithendar.com/blog/e2e-ingress-tls', '/blog/e2e-ingress-tls', ${article!.id}) on conflict (url) do nothing`);

// Search Console + GA4 fixture rows through the real sync code and the fake Google.
const end = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
const start = new Date(now.getTime() - 120 * 86_400_000).toISOString().slice(0, 10);
const deps = { fetchImpl: fakeGoogle().fetch, sleep: async () => {}, env: FIXTURE_ENV };
for (const type of ["gsc_backfill", "ga4_backfill"] as const) {
  const r = await runSeoJob({ type, trigger: "backfill", start, end, actor: "e2e-seed" }, deps);
  console.log(`${type}: ${r.status}, ${r.rows} fixture rows`);
}
const { refreshKeywords } = await import("../src/lib/seo-intel/keywords");
console.log("keywords:", await refreshKeywords());
console.log(`Seeded admin e2e-admin@example.com, article ${article!.id}.`);
process.exit(0);
