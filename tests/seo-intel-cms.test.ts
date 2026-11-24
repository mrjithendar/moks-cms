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
  const legacy = { env: { SEO_ORCHESTRATOR: "legacy" } };
  const written = "## Why Gateway API\n\nThe Ingress API stops at host and path routing. I moved mk4 to Gateway API in March.\n\n## Install\n\n```bash\nkubectl apply -f gateway.yaml\n```\n";
  const item = async (id: string) => (await cal.listCalendar()).all.find((i) => i.id === id);
  const post = async (id: string) => (await db.select().from(schema.post).where(eq(schema.post.id, id)))[0]!;
  /** The crew's handoff: the outline post receives the written article and a real description. */
  const writeDraft = (id: string) => db.update(schema.post).set({ body: written, description: "Moving a Kubernetes cluster from Ingress to Gateway API, with the routes, TLS and the mistakes on the way." }).where(eq(schema.post.id, id));

  it("has three phases and follows the draft from none to outline, ready and published", async () => {
    const id = await cal.createItem({ title: "Kubernetes Gateway API in practice" });
    expect(await item(id)).toMatchObject({ phase: "unscheduled", draft: "none", source: "manual", postId: null });
    expect(cal.patchSchema.safeParse({ status: "approved" }).success).toBe(false); // no approval step any more
    const { postId: draftId } = await cal.createDraftFromItem(id, admin);
    expect((await post(draftId)).status).toBe("draft");
    expect(cal.isOutline((await post(draftId)).body)).toBe(true);
    expect(await item(id)).toMatchObject({ draft: "outline", postId: draftId });
    // Generating again reuses the outline post instead of creating a second one.
    expect(await cal.createDraftFromItem(id, admin)).toMatchObject({ postId: draftId, reused: true });
    await writeDraft(draftId);
    expect(await item(id)).toMatchObject({ draft: "ready" });
    await expect(cal.createDraftFromItem(id, admin)).rejects.toMatchObject({ status: 409 }); // a real draft: Improve, not Generate
    await db.update(schema.post).set({ status: "published", publishedAt: new Date("2026-11-20T06:00:00Z") }).where(eq(schema.post.id, draftId));
    expect(await item(id)).toMatchObject({ phase: "published", draft: "published", status: "published" });
  });

  it("puts an item whose post was deleted back to approved, and flags a passed date until it is moved", async () => {
    // Production 2026-11-24: two items stayed "drafting" / "in_review" for days after their posts were deleted, past
    // their dates, so System status said "Editorial calendar: degraded" with nothing to review.
    const id = await cal.createItem({ title: "Terraform and IaC: a practical guide", targetDate: "2026-11-18" });
    const { postId: draftId } = await cal.createDraftFromItem(id, admin);
    await db.execute(sql`update seo_editorial_calendar set status = 'in_review' where id = ${id}`);
    expect(await item(id)).toMatchObject({ status: "in_review", postId: draftId, overdue: true });
    await db.update(schema.post).set({ deletedAt: new Date() }).where(eq(schema.post.id, draftId));
    expect(await item(id)).toMatchObject({ status: "approved", postId: null, draft: "none", phase: "scheduled", targetDate: "2026-11-18", overdue: true });
    // A new date in the future: no longer past due. A published item never is.
    await db.execute(sql`update seo_editorial_calendar set target_date = '2999-01-01' where id = ${id}`);
    expect(await item(id)).toMatchObject({ overdue: false });
    const live = await cal.createItem({ title: "Ingress and TLS on Kubernetes", targetDate: "2026-04-01" });
    expect(await item(live)).toMatchObject({ phase: "published", overdue: false });
  });

  it("opens on this month and this week in the editorial time zone", () => {
    // 2026-11-30 19:00 UTC is 2026-12-01 00:30 IST: the calendar opens on December, not November.
    expect(cal.istToday(new Date("2026-11-30T19:00:00Z"))).toBe("2026-12-01");
    expect(cal.monthRange(undefined, new Date("2026-11-30T19:00:00Z"))).toEqual({ month: "2026-12", from: "2026-12-01", to: "2026-12-31" });
    expect(cal.monthRange("2026-02", new Date("2026-11-30T19:00:00Z"))).toEqual({ month: "2026-02", from: "2026-02-01", to: "2026-02-28" });
    // Sunday 2026-11-29 20:00 UTC is Monday 01:30 IST: the week is the one starting that Monday.
    expect(cal.weekStartOf(cal.istToday(new Date("2026-11-29T20:00:00Z")))).toBe("2026-11-30");
    expect(cal.weekStartOf("2026-12-06")).toBe("2026-11-30"); // a Sunday belongs to the week before
  });

  it("checks for a draft first, then a published post, and offers Generate when there is neither", async () => {
    // A linked draft that was trashed: the link is cleared, so the item offers Generate draft instead of a dead link.
    const gone = await cal.createItem({ title: "LLMOps and MLOps: a practical guide" });
    const { postId: trashed } = await cal.createDraftFromItem(gone, admin);
    await db.update(schema.post).set({ deletedAt: new Date() }).where(eq(schema.post.id, trashed));
    expect(await item(gone)).toMatchObject({ draft: "none", postId: null, phase: "unscheduled" });
    // A draft written by hand with the item's title is found and linked.
    const [byHand] = await db.insert(schema.post).values({ collection: "blog", slug: "hand-written", title: "Linking an existing article", description: "d", body: written, category: "kubernetes", tags: [], contentType: "tutorial", status: "draft", authorId: "admin" }).returning();
    const linked = await cal.createItem({ title: "  linking an existing ARTICLE " });
    expect(await item(linked)).toMatchObject({ postId: byHand!.id, draft: "ready" });
    // A published post with the item's title: the item is published.
    const live = await cal.createItem({ title: "Ingress and TLS on Kubernetes" });
    expect(await item(live)).toMatchObject({ postId, phase: "published", draft: "published" });
    // Linking by id still validates.
    const other = await cal.createItem({ title: "Something else entirely" });
    await expect(cal.updateItem(other, { postId: "00000000-0000-4000-8000-000000000000" })).rejects.toMatchObject({ status: 400 });
    await cal.updateItem(other, { ownerId: "admin" });
    expect(await item(other)).toMatchObject({ ownerName: "Admin" });
  });

  it("schedules the post only when its draft is written, in the future, and in the scheduler's name", async () => {
    const sched = await import("@/lib/seo-intel/calendar-schedule");
    const now = new Date("2026-11-18T08:00:00Z");
    const id = await cal.createItem({ title: "Scheduling a calendar article" });
    // No draft: the date is kept with a note, nothing is scheduled.
    let r = await sched.scheduleItem(id, admin, "2026-11-25", "10:30", now);
    expect(r).toMatchObject({ scheduled: false, publishAt: "2026-11-25T05:00:00.000Z" });
    expect(r.note).toMatch(/No draft yet/);
    expect(await item(id)).toMatchObject({ phase: "scheduled", targetDate: "2026-11-25", targetTime: "10:30", draft: "none", scheduleNote: null }); // the page says why from the draft state
    // Outline only: still not scheduled.
    const { postId: draftId } = await cal.createDraftFromItem(id, admin);
    r = await sched.scheduleItem(id, admin, "2026-11-25", "10:30", now);
    expect(r.note).toMatch(/not written yet/);
    expect((await post(draftId)).status).toBe("draft");
    // Written, but the post is not valid to publish (the outline's empty description): the reason is the note.
    await db.update(schema.post).set({ body: written }).where(eq(schema.post.id, draftId));
    r = await sched.scheduleItem(id, admin, "2026-11-25", "10:30", now);
    expect(r).toMatchObject({ scheduled: false, note: expect.stringMatching(/not ready to publish/) });
    expect((await item(id))!.scheduleNote).toMatch(/not ready to publish/); // a reason about the written draft is kept
    expect((await post(draftId)).status).toBe("draft");
    // Fact-check errors from the agent block it too.
    await writeDraft(draftId);
    await db.execute(sql`insert into seo_drafts (article_id, collection, status, base_version, base_snapshot, trigger, kind, calendar_id, flags) values (${draftId}, 'blog', 'superseded', 1, '{}'::jsonb, 'calendar', 'new_article', ${id}, ${JSON.stringify([{ code: "fact", severity: "error", message: "unverified version" }])}::jsonb)`);
    r = await sched.scheduleItem(id, admin, "2026-11-25", "10:30", now);
    expect(r.note).toMatch(/1 fact-check error/);
    await db.execute(sql`update seo_drafts set flags = '[]'::jsonb where calendar_id = ${id}`);
    // Ready: the post is scheduled for that time (IST), and the CMS scheduler publishes it then.
    await expect(sched.scheduleItem(id, admin, "2026-11-18", "13:31", now)).rejects.toMatchObject({ status: 400 }); // 08:01 UTC: not the future
    r = await sched.scheduleItem(id, admin, "2026-11-25", null, now);
    expect(r).toMatchObject({ scheduled: true, note: null, publishAt: "2026-11-25T03:30:00.000Z" }); // 09:00 IST by default
    expect(await post(draftId)).toMatchObject({ status: "scheduled", publishedAt: new Date("2026-11-25T03:30:00Z") });
    expect(await item(id)).toMatchObject({ draft: "scheduled", phase: "scheduled", postScheduledFor: "2026-11-25T03:30:00.000Z", scheduleNote: null });
    const [{ scheduled_by } = { scheduled_by: null }] = rowsOf<{ scheduled_by: string | null }>(await db.execute(sql`select scheduled_by from seo_editorial_calendar where id = ${id}`));
    expect(scheduled_by).toBe("admin");
    // Reschedule, then unschedule: the post goes back to draft, never published.
    await sched.scheduleItem(id, admin, "2026-11-27", "18:00", now);
    expect((await post(draftId)).publishedAt).toEqual(new Date("2026-11-27T12:30:00Z"));
    await sched.unscheduleItem(id, admin);
    expect((await post(draftId)).status).toBe("draft");
    expect(await item(id)).toMatchObject({ phase: "unscheduled", targetDate: null, targetTime: null, draft: "ready" });
    await expect(sched.scheduleItem(id, admin, "2026-11-25", "25:00", now)).rejects.toMatchObject({ status: 400 });
  });

  it("deletes an item: hidden, its fingerprint kept, a post it scheduled back to draft", async () => {
    const sched = await import("@/lib/seo-intel/calendar-schedule");
    const [s] = rowsOf<{ id: string }>(await db.execute(sql`insert into seo_editorial_calendar (fingerprint, title, status, kind, brief) values ('fp-1', 'A suggested idea to delete', 'suggested', 'measured', '{}'::jsonb) returning id`));
    const { postId: draftId } = await cal.createDraftFromItem(s!.id, admin);
    await writeDraft(draftId);
    await sched.scheduleItem(s!.id, admin, "2027-01-05", "09:00", new Date("2026-11-18T08:00:00Z"));
    expect((await post(draftId)).status).toBe("scheduled");
    expect(await sched.holdScheduledPost(s!.id, admin, "Item deleted from the calendar.")).toBe(true);
    await cal.deleteItem(s!.id);
    expect((await post(draftId)).status).toBe("draft"); // kept, and no longer scheduled
    expect(await item(s!.id)).toBeUndefined();
    const [row] = rowsOf<{ status: string; fingerprint: string }>(await db.execute(sql`select status, fingerprint from seo_editorial_calendar where id = ${s!.id}`));
    expect(row).toEqual({ status: "dropped", fingerprint: "fp-1" }); // the suggestion engine will not add it again
    await expect(cal.deleteItem(s!.id)).rejects.toMatchObject({ status: 404 });
    await expect(cal.updateItem(s!.id, { title: "Edited after delete" })).rejects.toMatchObject({ status: 404 });
  });

  it("a date with no draft starts Generate by itself (legacy: the outline post), once", async () => {
    const { draftIfScheduled } = await import("@/lib/seo-agent/orchestrate");
    const undated = await cal.createItem({ title: "Not scheduled yet" });
    expect(await draftIfScheduled(undated, admin, legacy)).toBeNull();
    const dated = await cal.createItem({ title: "Dated calendar idea", targetDate: "2026-11-25", targetTime: "10:00" });
    const r = await draftIfScheduled(dated, admin, legacy);
    expect(r).toMatchObject({ orchestrator: "legacy" });
    expect((await post(r!.postId)).status).toBe("draft");
    expect(await draftIfScheduled(dated, admin, legacy)).toBeNull(); // legacy mode stops at the outline post
    // A suggestion with a date needs no approval any more.
    const [s] = rowsOf<{ id: string }>(await db.execute(sql`insert into seo_editorial_calendar (title, status, kind, target_date, brief) values ('Suggested and dated', 'suggested', 'measured', '2026-11-26', '{}'::jsonb) returning id`));
    expect(await draftIfScheduled(s!.id, admin, legacy)).not.toBeNull();
  });

  it("Improve sends the current draft to the Editorial Crew, unscheduling a scheduled post first", async () => {
    const { improveCalendarDraft, draftNewArticle } = await import("@/lib/seo-agent/orchestrate");
    const { calendarBrief } = await import("@/lib/seo-agent/callbacks");
    const sched = await import("@/lib/seo-intel/calendar-schedule");
    const kicked: { path: string; body: { inputs: Record<string, unknown> } }[] = [];
    const crewai = {
      env: { SEO_ORCHESTRATOR: "crewai", SEO_AGENT_TOKEN: "t", SEO_AGENT_URL: "http://agent.test" },
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        kicked.push({ path: new URL(String(url)).pathname, body: JSON.parse(String(init?.body)) });
        return Response.json({ run_id: `run-${kicked.length}`, status: "queued", existing: false });
      }) as typeof fetch,
    };
    const id = await cal.createItem({ title: "An article to improve" });
    await expect(improveCalendarDraft(id, admin, null, legacy)).rejects.toMatchObject({ status: 409 });
    await expect(improveCalendarDraft(id, admin, null, crewai)).rejects.toMatchObject({ status: 409 }); // nothing to improve yet
    const g = await draftNewArticle(id, admin, crewai);
    expect(kicked[0]).toMatchObject({ path: "/flows/new_article_flow/kickoff", body: { inputs: { calendar_id: id, article_id: g.postId } } });
    expect(kicked[0]!.body.inputs.feedback).toBeUndefined();
    expect(await item(id)).toMatchObject({ draft: "writing" });
    expect((await calendarBrief(id)).currentDraft).toBeNull(); // a new article: no draft to revise
    await expect(improveCalendarDraft(id, admin, null, crewai)).rejects.toMatchObject({ status: 409 }); // still being written
    // The crew finished and handed the article off; the person scheduled it.
    await db.execute(sql`update seo_drafts set status = 'superseded' where calendar_id = ${id}`);
    await writeDraft(g.postId);
    await sched.scheduleItem(id, admin, "2027-01-05", "09:00", new Date("2026-11-18T08:00:00Z"));
    expect((await post(g.postId)).status).toBe("scheduled");

    const r = await improveCalendarDraft(id, admin, "Add a troubleshooting section.", crewai);
    expect(r).toMatchObject({ orchestrator: "crewai", unscheduled: true });
    expect((await post(g.postId)).status).toBe("draft");
    expect(await item(id)).toMatchObject({ draft: "writing", scheduleNote: expect.stringMatching(/Unscheduled while the draft is improved/) });
    const feedback = String(kicked[1]!.body.inputs.feedback);
    expect(feedback).toContain("Improve the current draft");
    expect(feedback).toContain("Add a troubleshooting section.");
    // The crew reads the current draft, and the new run snapshots exactly that text (the handoff writes only over it).
    expect((await calendarBrief(id)).currentDraft).toBe(written);
    const [d] = rowsOf<{ base_snapshot: { body: string }; status: string }>(await db.execute(sql`select base_snapshot, status from seo_drafts where id = ${r.draftId}`));
    expect(d).toMatchObject({ status: "generating", base_snapshot: { body: written } });
  });

  it("edits the details and brief in place, merging the brief and validating input", async () => {
    for (const targetDate of ["2026-11-20", undefined]) {
      const id = await cal.createItem({ title: "Editable calendar details", targetDate, notes: "first notes" });
      await cal.updateItem(id, cal.patchSchema.parse({ cluster: "gateway api", category: "kubernetes", brief: { audience: "platform engineers", outline: ["Why", "How"], readingTimeMinutes: 9 } }));
      await cal.updateItem(id, cal.patchSchema.parse({ brief: { intent: "how-to" } }));
      const it = await item(id);
      expect(it).toMatchObject({ cluster: "gateway api", category: "kubernetes" });
      expect(it!.brief).toMatchObject({ audience: "platform engineers", outline: ["Why", "How"], readingTimeMinutes: 9, intent: "how-to", notes: "first notes", source: "manual" });
      await cal.updateItem(id, cal.patchSchema.parse({ cluster: null, category: null }));
      expect(await item(id)).toMatchObject({ cluster: null, category: null });
      await db.execute(sql`update seo_editorial_calendar set title = ${`Editable calendar details ${targetDate ?? "x"}`} where id = ${id}`);
    }
    expect(cal.patchSchema.safeParse({ targetDate: "2026-11-20" }).success).toBe(false); // dates are not details: nothing to change…
    expect(cal.patchSchema.parse({ targetDate: "2026-11-20", title: "Only the title counts" })).toEqual({ title: "Only the title counts" }); // …dates go through /schedule
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

  // Owner decision 2026-11-18 (D-94): a person's Schedule on the editorial calendar schedules the item's written draft
  // post, in their name, like the editor's Schedule button. calendar-schedule.ts is that one module.
  const CAL_SCHEDULE = path.resolve(import.meta.dirname, "..", "src/lib/seo-intel/calendar-schedule.ts");

  it("calendar-schedule.ts schedules only a written draft, in the future, from a person's request; unscheduling only returns it to draft", () => {
    const src = fs.readFileSync(CAL_SCHEDULE, "utf8");
    expect(src).not.toMatch(/\b(publishDuePosts|deletePost|trashPost|deletePostPermanently|restorePost|createPost|createPublishedPost)\b/);
    expect(src).not.toMatch(/update\s+"?post"?\s+set|\.update\(schema\.post\)|insert\s+into\s+"?post"?\b/i);
    expect([...src.matchAll(/\bpublishPost\(/g)].length).toBe(1);
    // The one publishPost: inside scheduleItem, after the future-time, outline and fact-check checks, with that time.
    expect(src).toMatch(/export async function scheduleItem[\s\S]*?MIN_LEAD_MS\) throw[\s\S]*?isOutline\(item\.post_body\)[\s\S]*?agent_errors > 0[\s\S]*?publishPost\(actor, item\.post_id, \{ publishedAt: publishAt \}/);
    for (const m of src.matchAll(/\bupdatePost\(([^)]*)\)/g)) expect(m[1]).toMatch(/\{ status: "draft" \}/);
    // Reached only from a person's request (the calendar routes) and Improve; never from the agent, jobs or the scheduler.
    const importers = files.filter((f) => f !== CAL_SCHEDULE && /seo-intel\/calendar-schedule"/.test(fs.readFileSync(f, "utf8"))).map((f) => path.relative(path.resolve(import.meta.dirname, ".."), f)).sort();
    expect(importers).toEqual(["src/app/api/admin/seo/calendar/[id]/route.ts", "src/app/api/admin/seo/calendar/[id]/schedule/route.ts", "src/lib/seo-agent/orchestrate.ts"]);
    const orch = fs.readFileSync(path.resolve(import.meta.dirname, "..", "src/lib/seo-agent/orchestrate.ts"), "utf8");
    expect([...orch.matchAll(/import \{([^}]*)\} from "\.\.\/seo-intel\/calendar-schedule"/g)].flatMap((m) => m[1]!.split(",").map((x) => x.trim()))).toEqual(["holdScheduledPost"]);
  });

  it("no SEO module calls the CMS's publish/update/delete functions or writes post status", () => {
    expect(files.length).toBeGreaterThan(20);
    for (const f of files.filter((x) => x !== PUBLISHER && x !== HANDOFF && x !== CAL_SCHEDULE)) {
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
