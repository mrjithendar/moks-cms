import { expect, test, type Page } from "@playwright/test";
import { noHorizontalScroll, signIn } from "./helpers";

/**
 * News desk admin UI against a production build seeded by scripts/e2e-seed.ts + scripts/news-e2e-seed.ts (demo data,
 * local PGlite). The seo-agent is not running in this setup: actions that start flows (run, dry run, regenerate) are
 * expected to report that the agent is unreachable; the agent's side is covered by moks-seo-agent tests.
 * NEWS_SCREENSHOTS=1 writes the PR screenshots to docs/news/ui/.
 */
const shot = async (page: Page, name: string) => {
  if (process.env.NEWS_SCREENSHOTS === "1") await page.screenshot({ path: `docs/news/ui/${name}-${test.info().project.name}.png`, fullPage: true });
};

test("jobs, editor with versions, diff and rollback", async ({ page }) => {
  await signIn(page);
  await page.goto("/admin/news");
  await expect(page.getByRole("heading", { name: "News desk" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Demo · Cloud native daily" }).first()).toBeVisible();
  await noHorizontalScroll(page);
  await shot(page, "jobs");
  await page.getByRole("link", { name: "Demo · Cloud native daily" }).first().click();
  // State-independent: read the current version, save a change, expect version + 1, then roll back to the old one.
  const v = Number(/Version (\d+)\./.exec((await page.getByText(/^Version \d+\./).first().textContent()) ?? "")?.[1]);
  expect(v).toBeGreaterThanOrEqual(2);
  await page.getByRole("tab", { name: "Schedule & limits" }).click();
  const max = page.getByLabel("Max articles per run");
  await max.fill((await max.inputValue()) === "1" ? "2" : "1");
  await page.getByRole("button", { name: "Save new version" }).click();
  await expect(page.getByText(`Saved as version ${v + 1}.`)).toBeVisible();
  await expect(page.getByText("config.max_articles_per_run").first()).toBeVisible();
  await shot(page, "job-editor");
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: `Roll back to v${v}` }).click();
  await expect(page.getByText(`rollback to v${v}`).first()).toBeVisible();
});

test("run detail: timeline, log, candidates with reasons", async ({ page }) => {
  await signIn(page);
  await page.goto("/admin/news/runs");
  await shot(page, "runs");
  await page.getByRole("link").filter({ hasText: /\d{2}\/\d{2}\/\d{4}/ }).first().click();
  await expect(page.getByRole("heading", { name: "Timeline" })).toBeVisible();
  await expect(page.getByText("robots.txt of www.hashicorp.com").first()).toBeVisible();
  await expect(page.getByText("per-run cap (2) reached")).toBeVisible();
  await expect(page.getByText("excluded keyword “webinar”")).toBeVisible();
  await page.getByText("breakdown").first().click();
  await expect(page.getByText("topic match").first()).toBeVisible();
  await page.getByLabel("Level").selectOption("warning");
  await expect(page.getByText("fetch: started")).toBeHidden();
  await shot(page, "run-detail");
});

test("sources health and review of a news draft", async ({ page }) => {
  await signIn(page);
  await page.goto("/admin/news/sources");
  await expect(page.getByText("CISA Known Exploited Vulnerabilities")).toBeVisible();
  await shot(page, "sources");
  await page.goto("/admin/review?tab=news");
  await expect(page.getByText("News", { exact: true }).first()).toBeVisible();
  await page.getByRole("link", { name: "Kubernetes 1.35 makes in-place pod resize stable" }).click();
  await expect(page.getByRole("heading", { name: "Why this story was picked" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sources and claims" })).toBeVisible();
  await expect(page.getByText("42 enhancements in the release")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Quality gates" })).toBeVisible();
  await expect(page.getByRole("img", { name: /Blue gradient cover/ })).toBeVisible();
  await noHorizontalScroll(page);
  await shot(page, "review");
  await page.getByLabel(/^Dek/).fill("Operators can change CPU and memory on running pods, no restart needed.");
  await page.getByRole("button", { name: "Save edits" }).click();
  await expect(page.getByText(/Edits saved/)).toBeVisible();
  await page.getByRole("button", { name: "Reject…" }).click();
  await page.getByLabel("Reason").selectOption("low_value");
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  await expect(page.getByText("Rejected.")).toBeVisible();
});

test("profiles, topics, analytics and settings render", async ({ page }) => {
  await signIn(page);
  for (const [path, heading, name] of [["/admin/news/profiles", "Profiles & playground", "profiles"], ["/admin/news/topics", "Topics & categories", "topics"], ["/admin/news/analytics", "News analytics", "analytics"], ["/admin/news/settings", "News desk settings", "settings"]] as const) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    await noHorizontalScroll(page);
    await shot(page, name);
  }
});
