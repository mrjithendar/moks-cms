import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests (Playwright). They run against an already running site (E2E_BASE_URL, default
 * http://localhost:3100) started from a production build with a throwaway local database — see docs/seo/OPERATIONS.md
 * "E2E". Uses the installed Google Chrome (channel "chrome"), so no browser download is needed.
 * Not part of `npm test` (Vitest); run with `npm run e2e`.
 */
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3100", channel: "chrome", trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], channel: "chrome", viewport: { width: 1440, height: 900 } } },
    { name: "mobile", use: { ...devices["Pixel 7"], channel: "chrome", viewport: { width: 375, height: 812 } } },
  ],
});
