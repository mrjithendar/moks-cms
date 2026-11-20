import { expect, test, type Page } from "@playwright/test";
import { noHorizontalScroll, signIn } from "./helpers";

/**
 * The admin bar (lib/admin-bar.ts): staff see it on public pages and in the admin, readers never do, it does not move
 * the page when it appears, and its Cache menu purges the page being viewed.
 */
test.skip(!process.env.E2E_ADMIN_PASSWORD, "E2E environment not configured");

const bar = (page: Page) => page.getByRole("navigation", { name: "Admin toolbar" });

test("readers never get the bar or its reserved space", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("header").first()).toBeVisible();
  await page.waitForTimeout(1500); // the session check has answered
  await expect(bar(page)).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.classList.contains("has-adminbar"))).toBe(false);
  expect(await page.evaluate(() => document.cookie)).not.toContain("moks-adminbar");
});

test("staff: on every page, no layout jump, edit link, purge this page", async ({ page }, info) => {
  await signIn(page);
  await expect(bar(page)).toBeVisible(); // in the admin
  await noHorizontalScroll(page);

  // A public page, after the bar has been seen once: the head script reserves its space before the first paint.
  await page.goto("/");
  const reservedAtLoad = await page.evaluate(() => document.documentElement.classList.contains("has-adminbar"));
  expect(reservedAtLoad, "space reserved before the bar is drawn").toBe(true);
  await expect(bar(page)).toBeVisible();
  const header = page.locator("header").first();
  const headerTop = (await header.boundingBox())!.y;
  const barBox = (await bar(page).boundingBox())!;
  expect(barBox.y).toBe(0);
  expect(headerTop).toBeGreaterThanOrEqual(barBox.height - 1); // the site header sits below the bar, not under it
  await noHorizontalScroll(page);

  // Scrolled: the bar stays at the top and the sticky header stays below it.
  await page.mouse.wheel(0, 1200);
  await page.waitForTimeout(300);
  expect((await bar(page).boundingBox())!.y).toBe(0);

  // Purge this page from the Cache menu.
  await bar(page).getByRole("button", { name: "Cache" }).click();
  await bar(page).getByRole("button", { name: /Purge this page/ }).click();
  await expect(page.getByRole("status").filter({ hasText: "removed from the page cache" })).toBeVisible();

  // Hide on the site, then show again (the admin keeps it).
  const account = bar(page).getByRole("button", { name: /^Hi, / });
  await account.click();
  await bar(page).getByRole("button", { name: /Hide toolbar on the site/ }).click();
  await expect(bar(page)).toHaveCount(0);
  await page.goto("/admin");
  await expect(bar(page)).toBeVisible();
  await bar(page).getByRole("button", { name: /^Hi, / }).click();
  await bar(page).getByRole("button", { name: /Show toolbar on the site/ }).click();
  await page.goto("/");
  await expect(bar(page)).toBeVisible();

  if (info.project.name === "desktop") {
    await expect(bar(page).getByRole("link", { name: "Customize homepage" })).toBeVisible();
  }
});
