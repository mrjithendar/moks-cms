import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDbForTests, type Db } from "@/db";
import { freshDb } from "./db-helpers";

vi.mock("server-only", () => ({}));

const { CHECK_GROUPS, failingFlows } = await import("@/lib/health");
let db: Db;

beforeEach(async () => {
  db = await freshDb();
});
afterEach(() => setDbForTests(undefined));

async function run(flow: string, status: string, hoursAgo: number, error: string | null = null) {
  await db.execute(sql`
    insert into seo_flow_runs (run_id, flow_name, target_id, status, error, triggered_by, started_at, finished_at)
    values (gen_random_uuid(), ${flow}, ${`site-${Math.random()}`}, ${status}, ${error}, 'cron', now() - make_interval(hours => ${hoursAgo}), now() - make_interval(hours => ${hoursAgo}))`);
}

describe("system status", () => {
  it("calls the SEO agent degraded only for flows whose latest run in the last 24 hours failed", async () => {
    await run("publish_flow", "failed", 2, "publish: The CMS refused the update: related post does not exist");
    await run("promotion_flow", "failed", 5, "budget");
    await run("promotion_flow", "succeeded", 1); // failed earlier, fine since
    await run("gsc_sync_flow", "failed", 30, "old failure"); // older than a day
    await run("news_dispatch_flow", "succeeded", 1);
    const failing = await failingFlows();
    expect(failing.map((f) => f.flow)).toEqual(["publish_flow"]);
    expect(failing[0]!.error).toMatch(/related post does not exist/);
  });

  it("gives every check a group, and a settings page or deployment setting where one applies", () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, "..", "src/lib/health.ts"), "utf8");
    const checks = [...src.matchAll(/timed\(\s*(?:p === "gsc" \? "Search Console sync" : "Google Analytics 4 sync"|"([^"]+)"),\s*(\{[^}]*\})/g)].map((m) => ({ name: m[1] ?? "Search Console / GA4 sync", where: m[2]! }));
    expect(checks.length).toBeGreaterThanOrEqual(21);
    for (const c of checks) expect(c.where, c.name).toMatch(new RegExp(`group: "(${CHECK_GROUPS.join("|")})"`));
    const unconfigurable = checks.filter((c) => !/href:|env:/.test(c.where)).map((c) => c.name).sort();
    expect(unconfigurable).toEqual(["Breached-password check", "TLS certificate"]); // public services nothing configures
    // The admin pages linked from System status exist.
    for (const href of new Set(checks.flatMap((c) => [...c.where.matchAll(/href: "([^"?]+)/g)].map((m) => m[1]!)))) {
      const dir = path.resolve(import.meta.dirname, "..", "src/app", href.replace(/^\/admin/, "admin"));
      const grown = path.resolve(import.meta.dirname, "..", "src/app/admin/(growth)", href.replace(/^\/admin\//, ""));
      expect(fs.existsSync(path.join(dir, "page.tsx")) || fs.existsSync(path.join(grown, "page.tsx")), href).toBe(true);
    }
  });
});
