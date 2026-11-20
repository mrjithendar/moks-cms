import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { schema } from "@/db";
import type { Actor } from "@/lib/posts";
import { freshDb } from "./db-helpers";

// Runtime settings have no page of their own: each group is drawn on the page it configures (Integrations, Bookings,
// Payments, Storage, Users) by components/admin/RuntimeSettings.tsx, and saving returns to that page and group.

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

describe("runtime settings on their own pages", () => {
  it("every group belongs to a real admin page", async () => {
    const { GROUPS, settingHref } = await import("@/lib/runtime-settings");
    const pages = new Set(GROUPS.map((g) => g.page));
    expect([...pages].sort()).toEqual(["/admin/bookings", "/admin/integrations", "/admin/payments", "/admin/storage", "/admin/users"]);
    expect(settingHref("razorpay")).toBe("/admin/payments#razorpay");
    expect(settingHref("calcom")).toBe("/admin/bookings#calcom");
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
    expect(html).toContain(">configured<");

    const section = await render(["verification", "analytics"], "section");
    expect(section).toContain('id="verification"');
    expect(section).toContain('id="analytics"');
    expect(section).toMatch(/<h2 id="analytics-title"[^>]*>Analytics, ads and consent<\/h2>/);
    await expect(render(["no-such-group"])).rejects.toThrow(/Unknown settings group/);
  });

  it("saving returns to the group on its page, with the message before the anchor", async () => {
    const { saveRuntimeSettings } = await import("@/app/admin/_actions/runtime-settings");
    const form = new FormData();
    form.set("group", "calcom");
    form.set("CAL_WEBHOOK_SECRET", "0123456789abcdef0123");
    await expect(saveRuntimeSettings(form)).rejects.toThrow("NEXT_REDIRECT");
    expect(redirects.at(-1)).toMatch(/^\/admin\/bookings\?ok=Cal\.com%20bookings%20saved[^#]*#calcom$/);
    expect((await (await import("@/lib/runtime-settings")).effectiveEnv()).CAL_WEBHOOK_SECRET).toBe("0123456789abcdef0123");

    const bad = new FormData();
    bad.set("group", "members");
    bad.set("MEMBERS_PREVIEW_PERCENT", "500");
    await expect(saveRuntimeSettings(bad)).rejects.toThrow("NEXT_REDIRECT");
    expect(redirects.at(-1)).toMatch(/^\/admin\/users\?error=[^#]+#members$/);
  });
});
