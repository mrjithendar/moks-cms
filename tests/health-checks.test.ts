import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDbForTests, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
import { settingsSection } from "@/lib/settings-areas";
import { freshDb } from "./db-helpers";

vi.mock("server-only", () => ({}));

const { CHECK_GROUPS, failingFlows, contentFlowsProbe, calendarProbe } = await import("@/lib/health");
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
    // The admin pages linked from System status exist (a Settings link: its section, in its own category).
    for (const m of checks.flatMap((c) => [...c.where.matchAll(/href: "\/admin\/settings\/([a-z]+)\?section=([a-z0-9-]+)/g)])) expect(settingsSection(m[2]!)?.category, m[0]).toBe(m[1]);
    for (const href of new Set(checks.flatMap((c) => [...c.where.matchAll(/href: "([^"?#]+)/g)].map((m) => m[1]!)).filter((h) => !h.startsWith("/admin/settings/")))) {
      const dir = path.resolve(import.meta.dirname, "..", "src/app", href.replace(/^\/admin/, "admin"));
      const grown = path.resolve(import.meta.dirname, "..", "src/app/admin/(growth)", href.replace(/^\/admin\//, ""));
      expect(fs.existsSync(path.join(dir, "page.tsx")) || fs.existsSync(path.join(grown, "page.tsx")), href).toBe(true);
    }
  });
});

describe("content flows and editorial calendar checks (real schema)", () => {
  async function jobRun(status: string, hoursAgo: number, counters: Record<string, number>, kind = "job") {
    await db.execute(sql`
      insert into news_runs (id, kind, trigger, status, counters, started_at)
      values (gen_random_uuid(), ${kind}, 'flow', ${status}, ${JSON.stringify(counters)}::jsonb, now() - make_interval(hours => ${hoursAgo}))`);
  }

  it("reads news_runs by started_at (the column it has) and reports what the runs wrote", async () => {
    // Until 2026-11-24 the query asked for news_runs.created_at, which does not exist: the check was always "down".
    expect(await contentFlowsProbe()).toEqual({ status: "ok", detail: expect.stringMatching(/last 24 h: 0 run\(s\), 0 failed · last 72 h: 0 content flow run\(s\)/) });
    await jobRun("succeeded", 2, { scored: 12, selected: 3, drafted: 2 });
    await jobRun("succeeded", 26, { scored: 10, selected: 1, drafted: 1 });
    await jobRun("succeeded", 3, {}, "ingest");
    expect(await contentFlowsProbe()).toMatchObject({ status: "ok", detail: expect.stringMatching(/2 run\(s\), 0 failed · last 72 h: 2 content flow run\(s\), 3 draft\(s\) from 4 selected of 22 scored/) });
  });

  it("is degraded when every recent run selected nothing from the stories it scored, or most runs failed", async () => {
    // Production 2026-11-22…24: daily runs succeeded, scored 28–39 stories, selected none (every story off-topic).
    await jobRun("succeeded", 1, { scored: 28, selected: 0, drafted: 0 });
    await jobRun("succeeded", 25, { scored: 32, selected: 0, drafted: 0 });
    expect(await contentFlowsProbe()).toMatchObject({ status: "degraded", detail: expect.stringMatching(/every run selected nothing/) });
    await db.execute(sql`delete from news_runs`);
    await jobRun("failed", 1, {});
    await jobRun("failed", 2, {});
    await jobRun("succeeded", 3, { scored: 5, selected: 1, drafted: 1 });
    expect(await contentFlowsProbe()).toMatchObject({ status: "degraded", detail: expect.stringMatching(/3 run\(s\), 2 failed/) });
  });

  it("says what each dated item past its date needs", async () => {
    await db.execute(sql`insert into "user" (id, name, email, role) values ('admin', 'Admin', 'admin@example.com', 'admin')`);
    const add = async (title: string, date: string, body: string | null, status = "approved") => {
      let post: string | null = null;
      if (body !== null) {
        const [p] = rowsOf<{ id: string }>(await db.execute(sql`insert into post (collection, slug, title, description, body, category, tags, content_type, status, author_id) values ('blog', ${title.toLowerCase().replace(/\W+/g, "-")}, ${title}, '', ${body}, 'kubernetes', '{}', 'tutorial', 'draft', 'admin') returning id`));
        post = p!.id;
      }
      await db.execute(sql`insert into seo_editorial_calendar (title, status, kind, target_date, post_id, brief) values (${title}, ${status}, 'editorial_idea', ${date}::date, ${post}::uuid, '{}'::jsonb)`);
    };
    expect(await calendarProbe()).toEqual({ status: "ok", detail: "0 dated item(s) not scheduled yet" });
    await add("Python: a practical guide", "2026-11-12", null, "in_review"); // its post was deleted
    await add("LLMOps and MLOps guide", "2026-11-18", "## Intro\n\nA written draft without its description.\n");
    await add("Outline only, in the future", "2999-01-01", "> Draft created from the SEO editorial calendar (editorial idea).");
    const r = await calendarProbe();
    expect(r.status).toBe("degraded");
    expect(r.detail).toBe("3 dated item(s) not scheduled yet · 2 past their date (1 no draft, 1 ready, not scheduled): reschedule, generate or schedule them, or delete the idea");
  });
});

