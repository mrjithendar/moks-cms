import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schema, setDbForTests, type Db } from "@/db";
import { invalidateContent } from "@/lib/content";
import { freshDb } from "./db-helpers";

vi.mock("server-only", () => ({}));

const { createPost, createPublishedPost, duplicatePost, publishDuePosts, updatePost } = await import("@/lib/posts");
const { getAutosave, saveAutosave } = await import("@/lib/revisions");
const { savePage } = await import("@/lib/site-pages");

const admin = { id: "admin", role: "admin" as const, label: "admin@example.com" };

const valid = {
  collection: "blog",
  slug: "a-fresh-post",
  title: "A fresh post written in the admin",
  description: "A description that is comfortably longer than fifty characters for the schema.",
  body: "## Hello\n\nBody text.",
  category: "kubernetes",
  tags: ["GitOps"],
  contentType: "tutorial",
  status: "draft",
};
const page = { slug: "about", title: "About", description: "A description that is comfortably longer than fifty characters for pages.", body: "Hello" };

let db: Db;
beforeEach(async () => {
  vi.stubEnv("CONTENT_DIR", "");
  delete process.env.CONTENT_DIR;
  db = await freshDb();
  await db.insert(schema.user).values({ id: "admin", name: "admin", email: "admin@example.com", role: "admin" });
  await db.insert(schema.authorProfile).values({ userId: "admin", slug: "jithendar-dharmapuri", displayName: "Admin" });
  invalidateContent();
});
afterEach(() => {
  vi.unstubAllEnvs();
  setDbForTests(undefined);
});

/** Make every write to a table fail until the returned function is called (a stand-in for any mid-save failure). */
async function breakTable(name: "revision" | "audit_log") {
  await db.execute(sql.raw(`alter table "${name}" rename to "${name}_off"`));
  return () => db.execute(sql.raw(`alter table "${name}_off" rename to "${name}"`));
}

const revisions = (entity: "post" | "page", entityId: string) =>
  db.select().from(schema.revision).where(and(eq(schema.revision.entity, entity), eq(schema.revision.entityId, entityId)));
const audits = (action: string) => db.select().from(schema.auditLog).where(eq(schema.auditLog.action, action));

describe("a post save is one change", () => {
  it("writes the row, its revision and its audit entry together", async () => {
    const created = await createPost(admin, valid);
    expect((await revisions("post", created.id)).map((r) => [r.version, r.reason])).toEqual([[created.version, "create"]]);
    expect(await audits("post.create")).toHaveLength(1);

    await saveAutosave(admin, "post", created.id, created.version, { title: "work in progress" });
    const updated = await updatePost(admin, created.id, { slug: "a-renamed-post" }, { baseVersion: created.version });
    expect(updated.version).toBe(created.version + 1);
    expect(await revisions("post", created.id)).toHaveLength(2);
    expect(await getAutosave(admin, "post", created.id)).toBeNull();
    expect(await audits("post.update")).toHaveLength(1);
    const [redirect] = await db.select().from(schema.redirect).where(eq(schema.redirect.fromPath, "/blog/a-fresh-post"));
    expect(redirect?.toPath).toBe("/blog/a-renamed-post");
  });

  it.each(["revision", "audit_log"] as const)("leaves the post as it was when the %s write fails", async (table) => {
    const created = await createPost(admin, valid);
    await saveAutosave(admin, "post", created.id, created.version, { title: "work in progress" });

    const restore = await breakTable(table);
    await expect(updatePost(admin, created.id, { slug: "a-renamed-post", title: "A title that was changed in this save" }, { baseVersion: created.version })).rejects.toThrow();
    await restore();

    const [row] = await db.select().from(schema.post).where(eq(schema.post.id, created.id));
    expect(row).toMatchObject({ version: created.version, slug: valid.slug, title: valid.title });
    expect(await db.select().from(schema.redirect)).toHaveLength(0);
    expect(await revisions("post", created.id)).toHaveLength(1);
    expect(await audits("post.update")).toHaveLength(0);
    expect(await getAutosave(admin, "post", created.id)).not.toBeNull();

    // The editor still holds the version it loaded, so the same save goes through once the fault is gone.
    const retried = await updatePost(admin, created.id, { slug: "a-renamed-post" }, { baseVersion: created.version });
    expect(retried).toMatchObject({ version: created.version + 1, slug: "a-renamed-post" });
  });

  it("creates nothing when the first revision cannot be written", async () => {
    const restore = await breakTable("revision");
    await expect(createPost(admin, valid)).rejects.toThrow();
    await restore();
    expect(await db.select().from(schema.post)).toHaveLength(0);
    expect(await audits("post.create")).toHaveLength(0);
    // The slug was not taken by a half-created row.
    expect((await createPost(admin, valid)).slug).toBe(valid.slug);
  });

  it("does not leave a copy behind when duplicating fails", async () => {
    const created = await createPost(admin, valid);
    const restore = await breakTable("audit_log");
    await expect(duplicatePost(admin, created.id)).rejects.toThrow();
    await restore();
    expect(await db.select().from(schema.post)).toHaveLength(1);
    expect((await duplicatePost(admin, created.id)).slug).toBe("a-fresh-post-copy");
  });
});

describe("publishing a new post", () => {
  it("stores nothing when the post is not ready, so the next attempt is not blocked by its slug", async () => {
    await expect(createPublishedPost(admin, { ...valid, description: "Too short" })).rejects.toMatchObject({
      status: 400,
      issues: expect.arrayContaining([expect.stringMatching(/^description/)]),
    });
    expect(await db.select().from(schema.post)).toHaveLength(0);

    const now = new Date("2026-11-14T10:00:00Z");
    const row = await createPublishedPost(admin, valid, now);
    expect(row).toMatchObject({ status: "published", slug: valid.slug });
    expect(row.publishedAt?.toISOString()).toBe(now.toISOString());
    expect((await revisions("post", row.id)).map((r) => r.reason)).toEqual(["create"]);
  });

  it("schedules a post dated in the future and keeps a past date", async () => {
    const now = new Date("2026-11-14T10:00:00Z");
    const later = await createPublishedPost(admin, { ...valid, slug: "later", publishedAt: "2099-01-01T09:00:00+05:30" }, now);
    expect(later.status).toBe("scheduled");
    const earlier = await createPublishedPost(admin, { ...valid, slug: "earlier", publishedAt: "2026-10-27T18:00:00+05:30" }, now);
    expect(earlier.status).toBe("published");
    expect(earlier.publishedAt?.toISOString()).toBe("2026-10-27T12:30:00.000Z");
  });
});

describe("scheduled publishing", () => {
  it("keeps a post scheduled when its revision cannot be written, and publishes it on the next run", async () => {
    const post = await createPublishedPost(admin, { ...valid, publishedAt: "2099-01-01T09:00:00+05:30" }, new Date("2026-11-14T10:00:00Z"));
    expect(post.status).toBe("scheduled");
    const due = new Date("2099-01-02T00:00:00Z");

    const restore = await breakTable("revision");
    await expect(publishDuePosts(due)).rejects.toThrow();
    await restore();
    const [still] = await db.select().from(schema.post).where(eq(schema.post.id, post.id));
    expect(still).toMatchObject({ status: "scheduled", version: post.version });

    expect(await publishDuePosts(due)).toEqual([post.id]);
    const [live] = await db.select().from(schema.post).where(eq(schema.post.id, post.id));
    expect(live).toMatchObject({ status: "published", version: post.version + 1 });
    expect((await revisions("post", post.id)).map((r) => r.reason)).toEqual(["create", "scheduled-publish"]);
    expect(await audits("post.publish.scheduled")).toHaveLength(1);
    expect(await publishDuePosts(due)).toEqual([]);
  });
});

describe("a page save is one change", () => {
  it("creates nothing when the audit entry cannot be written", async () => {
    const restore = await breakTable("audit_log");
    await expect(savePage(admin, null, page)).rejects.toThrow();
    await restore();
    expect(await db.select().from(schema.page)).toHaveLength(0);
    expect(await revisions("page", page.slug)).toHaveLength(0);
  });

  it("rolls a rename back, with its redirect and the moved history", async () => {
    const created = await savePage(admin, null, page);
    const restore = await breakTable("audit_log");
    await expect(savePage(admin, page.slug, { ...page, slug: "about-us" }, { baseVersion: created.version })).rejects.toThrow();
    await restore();
    expect((await db.select().from(schema.page)).map((p) => [p.slug, p.version])).toEqual([[page.slug, created.version]]);
    expect(await db.select().from(schema.redirect)).toHaveLength(0);
    expect(await revisions("page", page.slug)).toHaveLength(1);

    const renamed = await savePage(admin, page.slug, { ...page, slug: "about-us" }, { baseVersion: created.version });
    expect(renamed).toMatchObject({ slug: "about-us", version: created.version + 1 });
    expect(await revisions("page", "about-us")).toHaveLength(2);
  });
});
