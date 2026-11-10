import { test } from "@playwright/test";

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
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.goto(path, { waitUntil: "networkidle" });
    await page.screenshot({ path: `${process.env.SHOT_DIR}/${name}-${info.project.name}.png`, fullPage: info.project.name === "desktop" ? false : false });
  });
}
