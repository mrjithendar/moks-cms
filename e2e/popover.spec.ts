import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

/** Content optimization numbers open their details on hover (desktop), keyboard focus and tap (mobile). */
test.skip(!process.env.E2E_ADMIN_PASSWORD, "E2E environment not configured");

test("popover: hover, keyboard focus and tap", async ({ page }, info) => {
  await signIn(page);
  await page.goto("/admin/content-audit");
  const scope = info.project.name === "mobile" ? page.locator("ul.md\\:hidden") : page.locator("table");
  const trigger = scope.getByRole("button", { name: /Audit score \d+ for .*: details/ }).first();
  await expect(trigger).toBeVisible();
  if (info.project.name === "desktop") {
    await trigger.hover();
    const tip = page.getByRole("tooltip");
    await expect(tip).toBeVisible();
    await expect(tip).toContainText("per error");
    expect(await trigger.getAttribute("aria-describedby")).toBe(await tip.getAttribute("id"));
    await page.keyboard.press("Escape");
    await expect(tip).toBeHidden();
    // keyboard: focus opens the tooltip; Enter opens the dialog with focus inside
    await page.mouse.move(0, 0);
    await trigger.focus();
    await expect(page.getByRole("tooltip")).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: /Audit score/ })).toBeVisible();
    await expect(page.getByText(/100 − \d+ = \d+/)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
  } else {
    await trigger.tap();
    const dlg = page.getByRole("dialog", { name: /Audit score/ });
    await expect(dlg).toBeVisible();
    await expect(dlg.getByText(/per error/)).toBeVisible();
  }
});
