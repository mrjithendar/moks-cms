import { expect, type Page } from "@playwright/test";

/** Seeded by scripts/e2e-seed.ts; the password comes from the same env var. */
export const ADMIN = { email: "e2e-admin@example.com", password: process.env.E2E_ADMIN_PASSWORD ?? "" };
export const FAKE = process.env.E2E_FAKE_SERVICES ?? "http://localhost:3199";

export async function signIn(page: Page) {
  await page.goto("/login?next=/admin/seo");
  await page.getByLabel("Email", { exact: true }).fill(ADMIN.email);
  await page.getByLabel("Password", { exact: true }).fill(ADMIN.password);
  // Cloudflare's always-pass test key solves itself outside production; wait for its token.
  await page.waitForFunction(() => Boolean((document.querySelector('input[name="cf-turnstile-response"]') as HTMLInputElement | null)?.value), null, { timeout: 30_000 }).catch(() => {});
  await page.getByRole("button", { name: "Sign in with email" }).click();
  await page.waitForURL(/\/admin/, { timeout: 30_000 });
}

/** Reload until `check` passes (background jobs run on the 30-second worker tick). */
export async function eventually(page: Page, check: () => Promise<void>, timeoutMs = 150_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      await check();
      return;
    } catch (e) {
      if (Date.now() > until) throw e;
      await page.waitForTimeout(5000);
      await page.reload();
    }
  }
}

export async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "page scrolls sideways").toBeLessThanOrEqual(1);
}
