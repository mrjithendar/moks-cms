import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { schema } from "@/db";
import { activeOffers, bookingUrlFor, hireCtaVisible, priceLabel, type HireMe } from "@/lib/hire-me";
import { defaultConfig, mergeWithDefaults, validateConfig, type SiteConfig } from "@/lib/site-config/schema";
import { freshDb } from "./db-helpers";

vi.mock("server-only", () => ({}));
const mails: { to: string; subject: string; body: string }[] = [];
vi.mock("@/lib/mail", () => ({ sendMail: async (to: string, subject: string, body: string) => void mails.push({ to, subject, body }) }));
let published: SiteConfig = defaultConfig();
vi.mock("@/lib/site-config/store", async (orig) => ({
  ...(await orig<typeof import("@/lib/site-config/store")>()),
  getPublishedConfig: async () => ({ config: published, version: 1, updatedAt: null, fallbacks: [] }),
}));

const hire = (patch: (h: HireMe) => void = () => {}): HireMe => {
  const h = structuredClone(defaultConfig().hireMe);
  patch(h);
  return h;
};

describe("Hire me configuration", () => {
  it("defaults validate: page on, four offers, every price 0 (shown as On request)", () => {
    const c = defaultConfig();
    expect(validateConfig(c)).toMatchObject({ ok: true });
    expect(c.hireMe.enabled).toBe(true);
    expect(activeOffers(c.hireMe).map((o) => o.key)).toEqual(["consulting", "freelance", "speaking", "mentoring"]);
    expect(Object.values(c.hireMe.offers).every((o) => o.price === 0)).toBe(true);
  });

  it("an existing stored config without hireMe gets the defaults (no data migration needed)", () => {
    const old = structuredClone(defaultConfig()) as Partial<SiteConfig>;
    delete old.hireMe;
    const merged = mergeWithDefaults(old) as SiteConfig;
    expect(merged.hireMe).toEqual(defaultConfig().hireMe);
  });

  it.each([
    ["http://cal.com/me", false],
    ["javascript:alert(1)", false],
    ["https://cal.com/jithendar/consulting", true],
    ["", true],
  ])("booking link %s accepted: %s", (url, ok) => {
    const c = defaultConfig();
    c.hireMe.offers.consulting.bookingUrl = url;
    c.hireMe.bookingUrl = url;
    expect(validateConfig(c).ok).toBe(ok);
  });

  it("rejects negative or fractional prices", () => {
    for (const price of [-1, 12.5]) {
      const c = defaultConfig();
      c.hireMe.offers.mentoring.price = price;
      expect(validateConfig(c).ok).toBe(false);
    }
  });
});

describe("Hire me helpers", () => {
  it("prices: 0 is On request, otherwise From <currency amount> per <unit>", () => {
    expect(priceLabel(0, "hour", "SGD")).toBe("On request");
    expect(priceLabel(150, "hour", "USD")).toBe("From $150 per hour");
    expect(priceLabel(2500, "project", "SGD")).toMatch(/^From SGD\s?2,500 per project$/);
  });

  it("booking: the offer's own link, then the general one, then none (the form)", () => {
    const h = hire((x) => {
      x.bookingUrl = "https://cal.com/me/intro";
      x.offers.consulting.bookingUrl = "https://cal.com/me/consulting";
    });
    expect(bookingUrlFor(h, "consulting")).toBe("https://cal.com/me/consulting");
    expect(bookingUrlFor(h, "mentoring")).toBe("https://cal.com/me/intro");
    expect(bookingUrlFor(hire(), "mentoring")).toBe("");
  });

  it("calls to action hide when the page is off or no new work is taken; disabled offers are not listed", () => {
    expect(hireCtaVisible(hire())).toBe(true);
    expect(hireCtaVisible(hire((h) => void (h.availability = "unavailable")))).toBe(false);
    expect(hireCtaVisible(hire((h) => void (h.enabled = false)))).toBe(false);
    expect(activeOffers(hire((h) => void (h.offers.speaking.enabled = false))).map((o) => o.key)).not.toContain("speaking");
  });
});

describe("Enquiries (submitEnquiry)", () => {
  beforeEach(async () => {
    mails.length = 0;
    published = defaultConfig();
    const db = await freshDb();
    await db.insert(schema.user).values({ id: "admin1", name: "Admin", email: "owner@example.test", role: "admin" });
  });

  const valid = { kind: "consulting", name: "Ada Lovelace", email: "ada@example.test", company: "Analytical Ltd", budget: "1,000–5,000", timeline: "Within a month", message: "We want an AI gateway in front of Bedrock on EKS." };

  it("stores kind and details in the inbox and emails the admin with a [Kind] subject", async () => {
    const { submitEnquiry, inbox } = await import("@/lib/contact");
    await submitEnquiry(valid, null, null, { signedIn: true });
    const [row] = await inbox("enquiries");
    expect(row).toMatchObject({ kind: "consulting", subject: "Consulting: Analytical Ltd", details: { company: "Analytical Ltd", budget: "1,000–5,000", timeline: "Within a month" } });
    expect(mails).toHaveLength(1);
    expect(mails[0]!.subject).toBe("[Consulting] Consulting: Analytical Ltd");
    expect(mails[0]!.body).toContain("Budget: 1,000–5,000");
  });

  it("plain contact messages are not enquiries", async () => {
    const { submitContact, inbox } = await import("@/lib/contact");
    await submitContact({ name: "Bob", email: "bob@example.test", subject: "Hello", message: "Just saying hello there." }, null, null, { signedIn: true });
    expect(await inbox("enquiries")).toHaveLength(0);
    expect(await inbox("all")).toHaveLength(1);
  });

  it("validates the kind, the fixed choices and the message, and needs Turnstile when signed out", async () => {
    const { submitEnquiry } = await import("@/lib/contact");
    await expect(submitEnquiry({ ...valid, kind: "crypto" }, null, null, { signedIn: true })).rejects.toMatchObject({ status: 400 });
    await expect(submitEnquiry({ ...valid, budget: "a million" }, null, null, { signedIn: true })).rejects.toMatchObject({ status: 400 });
    await expect(submitEnquiry({ ...valid, message: "hi" }, null, null, { signedIn: true })).rejects.toMatchObject({ status: 400 });
    await expect(submitEnquiry(valid, null, null)).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/verification/) });
  });

  it("is closed while the page is switched off", async () => {
    published = defaultConfig();
    published.hireMe.enabled = false;
    const { submitEnquiry } = await import("@/lib/contact");
    await expect(submitEnquiry(valid, null, null, { signedIn: true })).rejects.toMatchObject({ status: 403 });
  });

  it("shares the contact form's hourly limit of 3 per address", async () => {
    const { submitEnquiry } = await import("@/lib/contact");
    for (let i = 0; i < 3; i++) await submitEnquiry(valid, null, null, { signedIn: true });
    await expect(submitEnquiry(valid, null, null, { signedIn: true })).rejects.toMatchObject({ message: expect.stringMatching(/Too many/) });
  });

  it("migration 0023 adds the columns and its rollback removes them", async () => {
    const db = await freshDb();
    const cols = async () => ((await db.execute(`select column_name from information_schema.columns where table_name = 'contact_message'`)) as unknown as { rows: { column_name: string }[] }).rows.map((r) => r.column_name);
    expect(await cols()).toEqual(expect.arrayContaining(["kind", "details"]));
    const down = readFileSync(path.resolve(import.meta.dirname, "../src/db/rollback/0023_contact_enquiry.down.sql"), "utf8").split("--> statement-breakpoint").map((x) => x.trim()).filter(Boolean);
    for (const stmt of down) await db.execute(stmt);
    expect(await cols()).not.toEqual(expect.arrayContaining(["kind"]));
    expect(await cols()).not.toEqual(expect.arrayContaining(["details"]));
  });
});

describe("/hire-me is a cached page", () => {
  it("revalidates every 300 s, is not force-dynamic and reads no request data", () => {
    const src = readFileSync(path.resolve(import.meta.dirname, "../src/app/hire-me/page.tsx"), "utf8");
    expect(src).toMatch(/export const revalidate = 300;/);
    expect(src).not.toMatch(/force-dynamic|searchParams|cookies\(|headers\(/);
  });
});
