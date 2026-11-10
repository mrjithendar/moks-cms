import { expect, test } from "@playwright/test";
import { eventually, FAKE, noHorizontalScroll, signIn } from "./helpers";

/**
 * The owner's flow end to end, against a production build with a seeded local database, the fake Claude and the fake
 * IndexNow (e2e/fake-services.mjs): generate draft → review → reject one change → edit one → approve → publish →
 * live-page verification → submission records → rollback. Google calls are recorded as "needs credentials" (no
 * service account in E2E). Requires E2E_ADMIN_PASSWORD and the app env in docs/seo/OPERATIONS.md "E2E".
 */
test.describe.configure({ mode: "serial" });
test.skip(!process.env.E2E_ADMIN_PASSWORD, "E2E environment not configured");

test("draft → review → reject one, edit one → approve & publish → verify → submit → rollback", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "full flow runs once, on desktop");
  test.setTimeout(420_000);
  await signIn(page);

  // Find the seeded article and ask Claude (fake) for a draft.
  await page.goto("/admin/seo/content");
  await page.getByRole("link", { name: "Ingress and TLS on Kubernetes" }).first().click();
  await page.getByRole("button", { name: "Draft with Claude" }).click();

  // The job runs on the worker tick; the queue shows the draft with counts and the breakdown.
  await page.goto("/admin/seo/review");
  await eventually(page, async () => {
    await expect(page.getByRole("link", { name: "Ingress and TLS on Kubernetes" })).toBeVisible({ timeout: 1000 });
    await expect(page.getByText(/4 changes/)).toBeVisible({ timeout: 1000 });
  });
  await expect(page.getByText("1 edit · 1 heading · 1 title · 1 meta")).toBeVisible();
  await page.getByRole("link", { name: "Ingress and TLS on Kubernetes" }).click();

  // Diff view: numbered changes, summary bar, SERP preview.
  await expect(page.getByText("4 changes", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: /1\/4 · Search title/ })).toBeVisible();
  await expect(page.getByText("Search result preview")).toBeVisible();
  await expect(page.getByText("0 of 4 accepted · 4 undecided")).toBeVisible();

  const card = (n: number) => page.locator("article").filter({ has: page.getByRole("heading", { name: new RegExp(`^${n}/4`) }) });
  // 1: edit the title, then accept with my version
  await card(1).getByRole("button", { name: "Edit" }).click();
  await card(1).getByLabel(/Your version/).fill("Kubernetes ingress TLS, step by step");
  await card(1).getByRole("button", { name: /Save & accept/ }).click();
  await expect(card(1).getByText("Accepted with your edit")).toBeVisible();
  // 2: reject the meta description
  await card(2).getByRole("button", { name: "Reject" }).click();
  await expect(card(2).locator("span", { hasText: "✕ Rejected" })).toBeVisible(); // the status badge (the pressed button reads the same)
  // 3 + 4: accept, using the keyboard (j to move, a to accept)
  await card(2).focus();
  await page.keyboard.press("j");
  await page.keyboard.press("a");
  await expect(card(3).locator("span", { hasText: "✓ Accepted" })).toBeVisible();
  await page.keyboard.press("j");
  await page.keyboard.press("a");
  await expect(page.getByText("3 of 4 accepted")).toBeVisible();

  // Approve & publish: the dialog lists every step; nothing happens before confirming.
  await page.getByRole("button", { name: /Approve & publish \(3\)/ }).click();
  const dialog = page.getByRole("dialog", { name: "Approve and publish now" });
  await expect(dialog.getByText(/crawl hint/)).toBeVisible();
  await expect(dialog.getByText(/checked \(HTTP 200, self-canonical/)).toBeVisible();
  await dialog.getByRole("button", { name: "Publish now" }).click();
  await expect(page.getByText("Published", { exact: true }).first()).toBeVisible({ timeout: 30_000 });

  // Live page: my title, my body edit; the rejected meta stayed as it was.
  const live = await page.request.get("/blog/e2e-ingress-tls");
  const html = await live.text();
  expect(html).toContain("<title>Kubernetes ingress TLS, step by step");
  expect(html).toContain("Install the ingress-nginx controller with Helm.");
  expect(html).toContain("How to terminate TLS at a Kubernetes ingress controller with cert-manager, with a worked example");

  // Verification passes, then submissions are recorded (IndexNow to the fake; Google needs credentials here).
  await eventually(page, async () => {
    await expect(page.getByText(/Live-page verification: passed/)).toBeVisible({ timeout: 1000 });
    await expect(page.getByText(/IndexNow URL submitted · accepted/)).toBeVisible({ timeout: 1000 });
  }, 240_000);
  await expect(page.getByText(/Google sitemap resubmitted · skipped/)).toBeVisible();
  await expect(page.getByText(/Google URL Inspection · scheduled/)).toBeVisible();
  const calls = (await (await page.request.get(`${FAKE}/__calls`)).json()) as { path: string; body: { urlList?: string[] } | null }[];
  const origin = new URL(page.url()).origin; // the app runs with SITE_URL = this origin in E2E
  expect(calls.some((c) => c.path === "/indexnow" && c.body?.urlList?.includes(`${origin}/blog/e2e-ingress-tls`))).toBe(true);
  expect(calls.some((c) => /indexing\.googleapis/.test(c.path))).toBe(false);

  // One-click rollback restores the previous revision.
  await page.getByRole("button", { name: "Roll back this change" }).click();
  await page.getByRole("dialog", { name: /Roll back/ }).getByRole("button", { name: "Roll back" }).click();
  await expect(page.getByText("Rolled back", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  const after = await (await page.request.get("/blog/e2e-ingress-tls")).text();
  expect(after).toContain("<title>Ingress and TLS on Kubernetes: a worked example");
  expect(after).toContain("Install it with Helm.");
});

test("mobile (375 px): queue cards, inline diff, swipe/buttons to move, accept/reject, no sideways scroll", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "mobile only");
  test.setTimeout(300_000);
  await signIn(page);
  await page.goto("/admin/seo");
  await noHorizontalScroll(page);
  await page.goto("/admin/seo/content");
  await page.getByRole("link", { name: "Ingress and TLS on Kubernetes" }).first().click();
  await page.getByRole("button", { name: "Draft with Claude" }).click();
  await page.goto("/admin/seo/review");
  await eventually(page, async () => expect(page.getByRole("link", { name: "Ingress and TLS on Kubernetes" })).toBeVisible({ timeout: 1000 }));
  await noHorizontalScroll(page);
  await page.getByRole("link", { name: "Ingress and TLS on Kubernetes" }).click();
  await noHorizontalScroll(page);
  // Inline diff by default on phones (the side-by-side copy is hidden).
  await expect(page.locator("del").first()).toBeVisible();
  await page.getByRole("button", { name: "Accept" }).first().click();
  await expect(page.getByText(/1 of 4 accepted/)).toBeVisible();
  await page.getByRole("button", { name: "Next change (j)" }).click();
  await page.locator("article").nth(1).getByRole("button", { name: "Reject" }).click();
  await expect(page.getByText(/1 of 4 accepted · 2 undecided/)).toBeVisible();
  // The action bar stays in reach.
  await expect(page.getByRole("button", { name: /Approve & publish/ })).toBeInViewport();
  // Reject the draft to leave the database clean.
  await page.getByRole("button", { name: "Reject draft" }).click();
  await page.getByRole("dialog", { name: "Reject this draft?" }).getByRole("button", { name: "Reject draft" }).click();
  await expect(page.getByText("Rejected", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
});
