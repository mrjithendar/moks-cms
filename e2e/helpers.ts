import { expect, type Page } from "@playwright/test";

/** Seeded by scripts/e2e-seed.ts; the password comes from the same env var. */
export const ADMIN = { email: "e2e-admin@example.com", password: process.env.E2E_ADMIN_PASSWORD ?? "" };
export const FAKE = process.env.E2E_FAKE_SERVICES ?? "http://localhost:3199";

/**
 * Sign in through Better Auth's email endpoint with Cloudflare's documented always-pass test token (the server still
 * verifies it with Cloudflare's test secret). The browser's Turnstile widget does not reliably produce a token in
 * headless Chrome, and the login form itself is covered by the auth tests. `page.request` shares the browser context's
 * cookie jar, so the page is signed in afterwards; the final check is on the pathname (the login URL's own
 * `?next=/admin…` must not count as success).
 */
export async function signIn(page: Page) {
  const base = new URL(process.env.E2E_BASE_URL ?? "http://localhost:3100").origin;
  const res = await page.request.post("/api/auth/sign-in/email", {
    headers: { Origin: base, "x-captcha-response": "XXXX.DUMMY.TOKEN.XXXX" },
    data: { email: ADMIN.email, password: ADMIN.password },
  });
  expect(res.status(), `sign-in failed: ${await res.text()}`).toBe(200);
  await page.goto("/admin");
  await page.waitForURL((u) => u.pathname.startsWith("/admin"), { timeout: 30_000 });
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
