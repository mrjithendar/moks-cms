import { test } from "@playwright/test";
import { signIn } from "./helpers";

/**
 * Before/after screenshots of the key public pages for the owner's UI review (docs/seo/ui-review/).
 * Only runs when SHOT_DIR is set:  SHOT_DIR=docs/seo/ui-review/after npx playwright test e2e/screenshots.spec.ts
 */
const PAGES = [
  ["home", "/"],
  ["category-kubernetes", "/category/kubernetes"],
  ["article-eks", "/blog/deploy-roboshop-ai-amazon-eks"],
  ["article-istio", "/blog/istio-service-mesh-minikube-features-setup-troubleshooting"],
  ["search", "/search?q=kubernetes"],
] as const;

test.skip(!process.env.SHOT_DIR, "set SHOT_DIR to capture screenshots");

for (const [name, path] of PAGES) {
  test(`screenshot ${name}`, async ({ page }, info) => {
    test.skip(Boolean(process.env.ADMIN_SHOTS), "public pages are captured against the fixture-content instance");
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.goto(path, { waitUntil: "networkidle" });
    await page.screenshot({ path: `${process.env.SHOT_DIR}/${name}-${info.project.name}.png`, fullPage: info.project.name === "desktop" ? false : false });
  });
}

/** Admin pages (after only): SHOT_DIR + ADMIN_SHOTS=1 against the seeded E2E instance. */
const ADMIN_PAGES = [
  ["admin-overview", "/admin/seo?compare=1"],
  ["admin-review-queue", "/admin/seo/review"],
  ["admin-keywords", "/admin/seo/keywords?view=striking"],
  ["admin-content", "/admin/seo/content"],
  ["admin-links", "/admin/seo/links"],
] as const;

test("admin screenshots", async ({ page }, info) => {
  test.skip(!process.env.ADMIN_SHOTS, "set ADMIN_SHOTS=1");
  test.setTimeout(120_000);
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await signIn(page);
  for (const [name, path] of ADMIN_PAGES) {
    await page.goto(path, { waitUntil: "networkidle" });
    await page.screenshot({ path: `${process.env.SHOT_DIR}/${name}-${info.project.name}.png`, fullPage: true });
  }
  // The diff view of the first draft in the queue, if any.
  await page.goto("/admin/seo/review?tab=done");
  const first = page.locator('a[href^="/admin/seo/review/"]').first();
  if (await first.count()) {
    await first.click();
    await page.waitForLoadState("networkidle");
    await page.screenshot({ path: `${process.env.SHOT_DIR}/admin-diff-${info.project.name}.png`, fullPage: true });
  }
});
