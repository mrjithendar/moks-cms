import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { schema } from "@/db";
import type { Actor } from "@/lib/posts";
import { freshDb } from "./db-helpers";

// Runtime settings: each group is a section of the Settings area with the same id (lib/settings-areas.ts), drawn by
// components/admin/RuntimeSettings.tsx, and saving returns to that section.

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ getAll: () => [] }) }));
const redirects: string[] = [];
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    redirects.push(to);
    throw Object.assign(new Error("NEXT_REDIRECT"), { digest: `NEXT_REDIRECT;replace;${to};307;` });
  },
  notFound: () => {},
}));
const admin: Actor = { id: "admin", role: "admin", label: "admin@example.com" };
vi.mock("@/lib/admin", async (orig) => ({ ...(await orig<typeof import("@/lib/admin")>()), adminActor: async () => admin }));

beforeEach(async () => {
  redirects.length = 0;
  (await import("@/lib/cache-bus")).broadcastInvalidate("integrations");
  const db = await freshDb();
  await db.insert(schema.user).values({ id: "admin", name: "Admin", email: "admin@example.com", role: "admin" });
});

async function render(ids: string[], layout?: "card" | "section") {
  const { RuntimeSettings } = await import("@/components/admin/RuntimeSettings");
  return renderToStaticMarkup(await RuntimeSettings({ ids, layout }));
}

describe("runtime settings in the Settings area", () => {
  it("every group is a section of Settings", async () => {
    const { GROUPS, settingHref } = await import("@/lib/runtime-settings");
    const { settingsSection } = await import("@/lib/settings-areas");
    for (const g of GROUPS) expect(settingsSection(g.id), g.id).toBeDefined();
    expect(settingHref("razorpay")).toBe("/admin/settings/payments?section=razorpay");
    expect(settingHref("calcom")).toBe("/admin/settings/payments?section=calcom");
    expect(() => settingHref("nope")).toThrow();
  });

  it("renders a form per group with its anchor, status and fields; never a stored secret", async () => {
    const { saveRuntimeGroup } = await import("@/lib/runtime-settings");
    await saveRuntimeGroup(admin, "razorpay", { RAZORPAY_KEY_ID: "rzp_test_abcdefghij12", RAZORPAY_KEY_SECRET: "supersecretvalue123" });
    const html = await render(["razorpay"]);
    expect(html).toContain('id="razorpay"');
    expect(html).toContain("Razorpay payments");
    expect(html).toContain('name="group" value="razorpay"');
    expect(html).toContain('name="RAZORPAY_KEY_ID"');
    expect(html).toContain("rzp_test_abcdefghij12");
    expect(html).toContain("Stored here (encrypted)");
    expect(html).not.toContain("supersecretvalue123");
    expect(html).toContain(">Configured<"); // StatusPill: sentence case

    const section = await render(["verification", "analytics"], "section");
    expect(section).toContain('id="verification"');
    expect(section).toContain('id="analytics"');
    expect(section).toMatch(/<h2 id="analytics-title"[^>]*>Analytics, ads and consent<\/h2>/);
    await expect(render(["no-such-group"])).rejects.toThrow(/Unknown settings group/);
  });

  it("saving returns to the group's section of Settings, with the message (it returned to #group before, which the sectioned pages ignored)", async () => {
    const { saveRuntimeSettings } = await import("@/app/admin/_actions/runtime-settings");
    const form = new FormData();
    form.set("group", "calcom");
    form.set("CAL_WEBHOOK_SECRET", "0123456789abcdef0123");
    await expect(saveRuntimeSettings(form)).rejects.toThrow("NEXT_REDIRECT");
    expect(redirects.at(-1)).toMatch(/^\/admin\/settings\/payments\?section=calcom&ok=Cal\.com%20bookings%20saved[^#]*$/);
    expect((await (await import("@/lib/runtime-settings")).effectiveEnv()).CAL_WEBHOOK_SECRET).toBe("0123456789abcdef0123");

    const bad = new FormData();
    bad.set("group", "members");
    bad.set("MEMBERS_PREVIEW_PERCENT", "500");
    await expect(saveRuntimeSettings(bad)).rejects.toThrow("NEXT_REDIRECT");
    expect(redirects.at(-1)).toMatch(/^\/admin\/settings\/access\?section=members&error=[^#]+$/);
  });
});
