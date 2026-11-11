import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schema, setDbForTests, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
import type { Actor } from "@/lib/posts";
import { freshDb } from "./db-helpers";
import { settingsInput } from "./seo-fixtures";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const { proposeOptimizations, listOptimizations, acceptOptimization, rejectOptimization, rollbackOptimization, lineDiff } = await import("@/lib/seo-intel/optimize");
const { getAutosave, saveAutosave } = await import("@/lib/revisions");
const { rowToForm } = await import("@/lib/post-form");
const { saveSeoSettings } = await import("@/lib/seo-intel/settings");
const cal = await import("@/lib/seo-intel/calendar");

const admin: Actor = { id: "admin", role: "admin", label: "admin@example.com" };
let db: Db;
let postId: string;

const LONG_TITLE = "A deliberately long search title about Kubernetes ingress controllers and TLS termination";

beforeEach(async () => {
  db = await freshDb();
  await db.insert(schema.user).values({ id: "admin", name: "Admin", email: "admin@example.com", role: "admin" });
  await db.insert(schema.authorProfile).values({ userId: "admin", slug: "admin", displayName: "Admin" });
  await saveSeoSettings(settingsInput(), "admin");
  const [row] = await db
    .insert(schema.post)
    .values({
      collection: "blog",
      slug: "ingress-tls",
      title: "Ingress and TLS on Kubernetes",
      description: "How to terminate TLS at a Kubernetes ingress controller, with cert-manager and a worked example.",
      seoTitle: LONG_TITLE,
      body: "# Wrong H1\n\nIntro.\n\n## Setup\n\n```bash\nkubectl apply -f x.yaml\n```\n",
      category: "kubernetes",
      tags: ["kubernetes"],
      contentType: "tutorial",
      status: "published",
      publishedAt: new Date("2026-05-01T00:00:00Z"),
      authorId: "admin",
    })
    .returning();
  postId = row!.id;
});
afterEach(() => setDbForTests(undefined));

const live = async () => (await db.select().from(schema.post).where(eq(schema.post.id, postId)))[0]!;

describe("optimisation proposals → editor working copy", () => {
  it("accept writes only the working copy; the published post is unchanged", async () => {
    expect(await proposeOptimizations(postId, { llm: false })).toBeGreaterThanOrEqual(2);
    const props = await listOptimizations(postId);
    const title = props.find((p) => p.field === "seoTitle")!;
    expect(title.proposed.length).toBeLessThanOrEqual(60);
    const h1 = props.find((p) => p.field === "body")!;
    expect(h1.proposed).toContain("## Wrong H1");
    const before = await live();

    const r = await acceptOptimization(title.id, admin);
    expect(r.editorUrl).toBe(`/admin/posts/${postId}`);
    const after = await live();
    expect(after).toEqual(before); // not saved, not published, version unchanged
    const wc = await getAutosave(admin, "post", postId);
    expect(rowToForm(wc!.payload as Record<string, unknown>).seoTitle).toBe(title.proposed);
    expect(wc!.baseVersion).toBe(before.version);
    await expect(acceptOptimization(title.id, admin)).rejects.toMatchObject({ status: 409 });

    // Second accept stacks on the same working copy.
    await acceptOptimization(h1.id, admin);
    const wc2 = rowToForm((await getAutosave(admin, "post", postId))!.payload as Record<string, unknown>);
    expect(wc2.seoTitle).toBe(title.proposed);
    expect(wc2.body).toContain("## Wrong H1");
    expect(await live()).toEqual(before);
  });

  it("rollback restores the previous working copy exactly, or discards one the accept created", async () => {
    await proposeOptimizations(postId, { llm: false });
    const title = (await listOptimizations(postId)).find((p) => p.field === "seoTitle")!;
    // No earlier working copy: rollback discards it.
    await acceptOptimization(title.id, admin);
    await rollbackOptimization(title.id, admin);
    expect(await getAutosave(admin, "post", postId)).toBeNull();
    expect((await listOptimizations(postId)).find((p) => p.id === title.id)!.status).toBe("rolled_back");

    // An existing working copy (the author's unsaved edits) is preserved through accept → rollback.
    await proposeOptimizations(postId, { llm: false });
    const t2 = (await listOptimizations(postId)).find((p) => p.field === "seoTitle" && p.status === "proposed")!;
    const mine = { ...rowToForm(await live()), description: "My unsaved edit to the description, long enough to be a real description." };
    await saveAutosave(admin, "post", postId, (await live()).version, mine);
    await acceptOptimization(t2.id, admin);
    await rollbackOptimization(t2.id, admin);
    expect(rowToForm((await getAutosave(admin, "post", postId))!.payload as Record<string, unknown>)).toEqual(mine);
  });

  it("refuses a stale proposal when the field changed after it was made; reject works", async () => {
    await proposeOptimizations(postId, { llm: false });
    const [title, body] = [(await listOptimizations(postId)).find((p) => p.field === "seoTitle")!, (await listOptimizations(postId)).find((p) => p.field === "body")!];
    await db.update(schema.post).set({ seoTitle: "Someone changed it in the editor", version: 2 }).where(eq(schema.post.id, postId));
    await expect(acceptOptimization(title.id, admin)).rejects.toMatchObject({ status: 409 });
    await rejectOptimization(body.id, admin);
    expect((await listOptimizations(postId)).find((p) => p.id === body.id)!.status).toBe("rejected");
  });

  it("line diff marks additions and removals", () => {
    expect(lineDiff("a\nb\nc", "a\nB\nc\nd")).toEqual([
      { type: "same", text: "a" },
      { type: "del", text: "b" },
      { type: "add", text: "B" },
      { type: "same", text: "c" },
      { type: "add", text: "d" },
    ]);
  });
});

describe("editorial calendar", () => {
  it("enforces the status flow, creates drafts (never published) and follows the linked post to published", async () => {
    const id = await cal.createItem({ title: "Kubernetes Gateway API in practice", targetDate: "2026-11-20" });
    await expect(cal.updateItem(id, { status: "in_review" })).rejects.toMatchObject({ status: 409 }); // approved → in_review skips drafting
    expect(cal.patchSchema.safeParse({ status: "published" }).success).toBe(false);
    const { postId: draftId } = await cal.createDraftFromItem(id, admin);
    const [draft] = await db.select().from(schema.post).where(eq(schema.post.id, draftId));
    expect(draft!.status).toBe("draft");
    expect(draft!.body).toContain("## ");
    await cal.updateItem(id, { status: "in_review" });
    let list = await cal.listCalendar({ from: "2026-11-01", to: "2026-11-30" });
    expect(list.scheduled.find((i) => i.id === id)).toMatchObject({ status: "in_review", postId: draftId });
    // A person publishes the post in the editor → the calendar follows.
    await db.update(schema.post).set({ status: "published", publishedAt: new Date("2026-11-20T06:00:00Z") }).where(eq(schema.post.id, draftId));
    list = await cal.listCalendar({ from: "2026-11-01", to: "2026-11-30" });
    expect(list.scheduled.find((i) => i.id === id)!.status).toBe("published");
    await expect(cal.updateItem(id, { status: "drafting" })).rejects.toMatchObject({ status: 409 });
    await expect(cal.createDraftFromItem(id, admin)).rejects.toMatchObject({ status: 409 });
  });

  it("links an existing post and validates owners", async () => {
    const id = await cal.createItem({ title: "Linking an existing article" });
    await expect(cal.updateItem(id, { postId: "00000000-0000-4000-8000-000000000000" })).rejects.toMatchObject({ status: 400 });
    await cal.updateItem(id, { postId, ownerId: "admin" });
    const item = (await cal.listCalendar()).all.find((i) => i.id === id)!;
    expect(item).toMatchObject({ postId, ownerName: "Admin", status: "published" }); // the linked post is already published
  });

  it("creates the draft post by itself once an approved item is scheduled (never published, once only)", async () => {
    const { draftIfScheduled } = await import("@/lib/seo-agent/orchestrate");
    const legacy = { env: { SEO_ORCHESTRATOR: "legacy" } };
    const unscheduled = await cal.createItem({ title: "Not scheduled yet" });
    expect(await draftIfScheduled(unscheduled, admin, legacy)).toBeNull();
    await cal.updateItem(unscheduled, { targetDate: "2026-11-25", targetTime: "10:00" });
    const r = await draftIfScheduled(unscheduled, admin, legacy);
    expect(r).toMatchObject({ orchestrator: "legacy" });
    const [post] = await db.select().from(schema.post).where(eq(schema.post.id, r!.postId));
    expect(post!.status).toBe("draft");
    expect((await cal.listCalendar()).all.find((i) => i.id === unscheduled)).toMatchObject({ status: "drafting", postId: r!.postId });
    expect(await draftIfScheduled(unscheduled, admin, legacy)).toBeNull(); // already has its post
    // A suggestion with a date still waits for approval; approving it then drafts it.
    const [s] = rowsOf<{ id: string }>(await db.execute(sql`insert into seo_editorial_calendar (title, status, kind, target_date, brief) values ('Suggested and dated', 'suggested', 'measured', '2026-11-26', '{}'::jsonb) returning id`));
    expect(await draftIfScheduled(s!.id, admin, legacy)).toBeNull();
    await cal.updateItem(s!.id, { status: "approved" });
    expect(await draftIfScheduled(s!.id, admin, legacy)).not.toBeNull();
  });

  it("edits the details and brief in place, scheduled or not, merging the brief and validating input", async () => {
    for (const targetDate of ["2026-11-20", undefined]) {
      const id = await cal.createItem({ title: "Editable calendar details", targetDate, notes: "first notes" });
      await cal.updateItem(id, cal.patchSchema.parse({ cluster: "gateway api", category: "kubernetes", brief: { audience: "platform engineers", outline: ["Why", "How"], readingTimeMinutes: 9 } }));
      await cal.updateItem(id, cal.patchSchema.parse({ brief: { intent: "how-to" } }));
      const item = (await cal.listCalendar()).all.find((i) => i.id === id)!;
      expect(item).toMatchObject({ cluster: "gateway api", category: "kubernetes" });
      expect(item.brief).toMatchObject({ audience: "platform engineers", outline: ["Why", "How"], readingTimeMinutes: 9, intent: "how-to", notes: "first notes", source: "manual" });
      await cal.updateItem(id, cal.patchSchema.parse({ cluster: null, category: null }));
      expect((await cal.listCalendar()).all.find((i) => i.id === id)).toMatchObject({ cluster: null, category: null });
    }
    // Time of day (IST) with the date; a time needs a date, and clearing the date clears the time.
    const timed = await cal.createItem(cal.createSchema.parse({ title: "Timed calendar item", targetDate: "2026-11-21", targetTime: "09:30" }));
    expect((await cal.listCalendar()).all.find((i) => i.id === timed)).toMatchObject({ targetDate: "2026-11-21", targetTime: "09:30" });
    await cal.updateItem(timed, cal.patchSchema.parse({ targetTime: "18:05" }));
    expect((await cal.listCalendar()).all.find((i) => i.id === timed)!.targetTime).toBe("18:05");
    await cal.updateItem(timed, cal.patchSchema.parse({ targetDate: null }));
    expect((await cal.listCalendar()).all.find((i) => i.id === timed)).toMatchObject({ targetDate: null, targetTime: null });
    await expect(cal.updateItem(timed, cal.patchSchema.parse({ targetTime: "10:00" }))).rejects.toMatchObject({ status: 400 });
    expect(cal.patchSchema.safeParse({ targetTime: "25:00" }).success).toBe(false);
    expect(cal.patchSchema.safeParse({ targetTime: "9:30" }).success).toBe(false);
    expect(cal.patchSchema.safeParse({ category: "Not A Slug" }).success).toBe(false);
    expect(cal.patchSchema.safeParse({ brief: { source: "forged" } }).success).toBe(false);
    expect(cal.patchSchema.safeParse({ brief: { readingTimeMinutes: 500 } }).success).toBe(false);
  });
});

describe("no automatic publishing", () => {
  const roots = ["src/lib/seo-intel", "src/lib/seo-agent", "src/app/api/admin/seo", "src/app/admin/(growth)", "src/components/seo", "src/app/api/ask", "src/components/ask"].map((p) => path.resolve(import.meta.dirname, "..", p));
  const files = roots.flatMap(function walk(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [path.join(dir, e.name)] : []));
  });

  // v2 (docs/seo/DECISIONS.md D-21): publish.ts is the single module allowed to update a post, from an explicit approval.
  const PUBLISHER = path.resolve(import.meta.dirname, "..", "src/lib/seo-intel/publish.ts");

  // Owner decision 2026-11-11 (D-85): calendar articles go straight into their CMS draft post. handoff.ts may fill a
  // DRAFT post through updatePost (never publish, never change status) and only while the post still holds the outline.
  const HANDOFF = path.resolve(import.meta.dirname, "..", "src/lib/seo-intel/handoff.ts");

  it("handoff.ts only fills draft posts: updatePost without status, never publish/delete/raw writes", () => {
    const src = fs.readFileSync(HANDOFF, "utf8");
    expect(src).not.toMatch(/\b(publishPost|publishDuePosts|deletePost|trashPost|deletePostPermanently|restorePost|createPost)\b/);
    expect(src).not.toMatch(/update\s+"?post"?\s+set|\.update\(schema\.post\)|insert\s+into\s+"?post"?\b/i);
    expect(src).not.toMatch(/status:\s*["']/);
    expect([...src.matchAll(/\bupdatePost\(/g)].length).toBe(1);
    expect(src).toMatch(/\["draft", "review"\]\.includes\(r\.p_status\)[\s\S]*?p_body\.trim\(\) !== outline\.trim\(\)[\s\S]*?updatePost\(/);
  });

  it("no SEO module calls the CMS's publish/update/delete functions or writes post status", () => {
    expect(files.length).toBeGreaterThan(20);
    for (const f of files.filter((x) => x !== PUBLISHER && x !== HANDOFF)) {
      const src = fs.readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/\b(publishPost|updatePost|publishDuePosts|deletePost|trashPost|deletePostPermanently|restorePost)\b/);
      expect(src, f).not.toMatch(/update\s+"?post"?\s+set|\.update\(schema\.post\)|insert\s+into\s+"?post"?\b/i);
      expect(src, f).not.toMatch(/status:\s*["']published["']/);
    }
  });

  it("publish.ts only uses updatePost (never publish/delete/raw writes), and only from approve, schedule and rollback", () => {
    const src = fs.readFileSync(PUBLISHER, "utf8");
    expect(src).not.toMatch(/\b(publishPost|publishDuePosts|deletePost|trashPost|deletePostPermanently|restorePost|createPost)\b/);
    expect(src).not.toMatch(/update\s+"?post"?\s+set|\.update\(schema\.post\)|insert\s+into\s+"?post"?\b/i);
    const callers = [...src.matchAll(/^(?:export )?async function (\w+)[\s\S]*?^}/gm)].filter((m) => /\bupdatePost\(/.test(m[0])).map((m) => m[1]);
    // v3 (D-43): publishNewArticle publishes a crew-written CMS draft post; like publishDraft it is reached only through
    // an explicit approval (approveDraft / publishWithApproval, which checks a recorded admin approval).
    expect(callers.sort()).toEqual(["publishDraft", "publishNewArticle", "rollbackDraft"]);
    expect(src).toMatch(/export async function publishWithApproval[\s\S]*?seo_draft_approvals[\s\S]*?used_at[\s\S]*?role !== "admin"[\s\S]*?publishNewArticle\(/);
    expect([...src.matchAll(/publishNewArticle\(/g)].length).toBe(2); // its definition and the one call in publishWithApproval
    expect(src).toMatch(/export async function approveDraft[\s\S]*?publishDraft\(/);
    expect(src).toMatch(/export async function publishDueDrafts[\s\S]*?role !== "admin"/);
    // nothing else in the SEO code imports the publisher's write paths except the routes and the scheduler hook
    const importers = files.filter((f) => f !== PUBLISHER && /from "(@\/lib\/seo-intel|\.|\.\.\/seo-intel)\/publish"/.test(fs.readFileSync(f, "utf8"))).map((f) => path.relative(path.resolve(import.meta.dirname, ".."), f)).sort();
    // v3: the agent's callback API (publish only via publishWithApproval) and the orchestrator (recordApproval only).
    // Owner decision 2026-11-10: the weekly auto-links job publishes rule-made LINK changes only, through
    // autoPublishLinkDraft, which refuses any draft that isn't trigger auto_links with only rules internal/external links.
    expect(importers).toEqual(["src/app/api/admin/seo/drafts/[id]/approve/route.ts", "src/app/api/admin/seo/drafts/[id]/rollback/route.ts", "src/lib/seo-agent/callbacks.ts", "src/lib/seo-agent/orchestrate.ts", "src/lib/seo-intel/auto-links.ts", "src/lib/seo-intel/broken-links.ts", "src/lib/seo-intel/handlers.ts"]);
    const autoUses = [...fs.readFileSync(path.resolve(import.meta.dirname, "..", "src/lib/seo-intel/auto-links.ts"), "utf8").matchAll(/import \{([^}]*)\} from "\.\/publish"/g)].flatMap((m) => m[1]!.split(",").map((x) => x.trim()));
    expect(autoUses).toEqual(["autoPublishLinkDraft"]);
    // The broken-link "Fix" button: the clicking admin approves the link_fix draft (approveDraft, nothing else).
    const fixSrc = fs.readFileSync(path.resolve(import.meta.dirname, "..", "src/lib/seo-intel/broken-links.ts"), "utf8");
    expect([...fixSrc.matchAll(/import \{([^}]*)\} from "\.\/publish"/g)].flatMap((m) => m[1]!.split(",").map((x) => x.trim()))).toEqual(["approveDraft"]);
    expect(fixSrc).toMatch(/export async function fixBrokenLink\(db: Db, s: SeoSettings, actor: Actor[\s\S]*?approveDraft\(draft\.id, actor\)/);
    expect(src).toMatch(/export async function autoPublishLinkDraft[\s\S]*?trigger !== "auto_links"[\s\S]*?origin !== "rules"[\s\S]*?"internal_link"[\s\S]*?"external_link"[\s\S]*?publishDraft\(/);
    const agentUses = (f: string) => [...fs.readFileSync(path.resolve(import.meta.dirname, "..", f), "utf8").matchAll(/import \{([^}]*)\} from "\.\.\/seo-intel\/publish"/g)].flatMap((m) => m[1]!.split(",").map((x) => x.trim()));
    expect(agentUses("src/lib/seo-agent/callbacks.ts").sort()).toEqual(["publishWithApproval", "verifyOnce"]);
    expect(agentUses("src/lib/seo-agent/orchestrate.ts")).toEqual(["recordApproval"]);
  });

  it("the only post-creating call is createPost with a hard-coded draft status", () => {
    const users = files.filter((f) => /\bcreatePost\(/.test(fs.readFileSync(f, "utf8")));
    expect(users.map((f) => path.basename(f))).toEqual(["calendar.ts"]);
    expect(fs.readFileSync(users[0]!, "utf8")).toMatch(/createPost\([\s\S]{0,400}status: "draft"/);
  });

  it("accepting every proposal leaves every post row untouched", async () => {
    await proposeOptimizations(postId, { llm: false });
    const before = await db.select().from(schema.post);
    for (const p of await listOptimizations(postId)) if (p.status === "proposed") await acceptOptimization(p.id, admin).catch(() => undefined);
    expect(await db.select().from(schema.post)).toEqual(before);
    const revisions = rowsOf<{ n: number }>(await db.execute(sql`select count(*)::int as n from revision`));
    expect(Number(revisions[0]!.n)).toBe(0);
  });
});
