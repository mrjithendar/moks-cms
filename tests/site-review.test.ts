import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "@/lib/site-config/schema";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/site-config/store", async (orig) => ({
  ...(await orig<typeof import("@/lib/site-config/store")>()),
  getPublishedConfig: async () => ({ config: defaultConfig(), version: 1, updatedAt: null, fallbacks: [] }),
}));

const publicFile = (name: string) => readFileSync(path.join(process.cwd(), "public", name));

describe("/.well-known/security.txt", () => {
  it("names the contact page and expires in the future but within a year (RFC 9116)", async () => {
    const { GET } = await import("@/app/.well-known/security.txt/route");
    const res = GET();
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    expect(body).toMatch(/^Contact: https:\/\/jithendar\.com\/contact$/m);
    expect(body).toMatch(/^Canonical: https:\/\/jithendar\.com\/\.well-known\/security\.txt$/m);
    const expires = Date.parse(body.match(/^Expires: (.+)$/m)![1]!);
    const days = (expires - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(300);
    expect(days).toBeLessThan(365);
  });
});

describe("icons and manifest", () => {
  it("serves a real favicon.ico and an opaque 180px apple-touch-icon from public/", () => {
    const ico = publicFile("favicon.ico");
    expect([...ico.subarray(0, 4)]).toEqual([0, 0, 1, 0]); // ICONDIR, type 1 (icon)
    expect(ico.readUInt16LE(4)).toBeGreaterThanOrEqual(2);
    const apple = publicFile("apple-touch-icon.png");
    expect(apple.subarray(1, 4).toString()).toBe("PNG");
    expect(apple.readUInt32BE(16)).toBe(180);
  });

  it("the manifest uses the site name and lists icons that exist", async () => {
    const { default: manifest } = await import("@/app/manifest");
    const m = await manifest();
    expect(m.name).toBe(defaultConfig().general.siteName);
    for (const icon of m.icons ?? []) {
      if (icon.src === "/icon.svg") continue; // src/app/icon.svg, served by Next
      expect(publicFile(icon.src.slice(1)).length).toBeGreaterThan(0);
    }
  });
});

describe("/hire-me metadata", () => {
  it("keeps a share image (its own openGraph would otherwise drop the site default)", async () => {
    const { generateMetadata } = await import("@/app/hire-me/page");
    const md = await generateMetadata();
    const images = md.openGraph?.images;
    expect(Array.isArray(images) ? images.length : images ? 1 : 0).toBeGreaterThan(0);
    expect(md.twitter).toMatchObject({ card: "summary_large_image" });
  });
});

describe("migration 0025", () => {
  it("only sets email_verified on users that do not have it (no other column, no deletes)", () => {
    const sql = readFileSync(path.join(process.cwd(), "src/db/migrations/0025_grandfather_email_verified.sql"), "utf8")
      .split("\n")
      .filter((l) => l.trim() && !l.startsWith("--"))
      .join(" ");
    expect(sql).toBe(`UPDATE "user" SET "email_verified" = true WHERE "email_verified" = false;`);
  });
});
