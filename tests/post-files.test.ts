import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schema, setDbForTests, type Db } from "@/db";
import { createApiKey } from "@/lib/api-keys";
import { invalidateContent } from "@/lib/content";
import { fieldsFromMdx, sameAsFile } from "@/lib/post-files";
import type { Actor } from "@/lib/posts";
import { freshDb } from "./db-helpers";

vi.mock("server-only", () => ({}));
const admin: Actor = { id: "admin", role: "admin", label: "a@example.com" };
const author: Actor = { id: "author", role: "author", label: "b@example.com" };
const site = "https://jithendar.com";

/** A post file as a site's repository holds it. The file says "published": a push still makes a draft. */
const mdx = (slug: string, body = "Body text.", extra = "", contentType = "opinion") =>
  `---\ntitle: A post pushed as a file through the API\nslug: ${slug}\ndescription: A description that is comfortably longer than fifty characters for the schema.\nauthor: test-author\ncategory: ai-engineering\ncontentType: ${contentType}\nstatus: published\npublishedAt: 2026-10-27T18:00:00+05:30\n${extra}---\n${body}\n`;

type Outcome = { action: string; id: string; status: string; url: string; admin: string; reason?: string };

let db: Db;
let draftKey: string;
let writeKey: string;

async function put(key: string | null, path: string, source: string, query = "") {
  const { PUT } = await import("@/app/api/v1/posts/by-path/[collection]/[slug]/route");
  const [collection, slug] = path.split("/") as [string, string];
  const res = await PUT(new Request(`${site}/api/v1/posts/by-path/${path}${query}`, { method: "PUT", headers: key ? { authorization: `Bearer ${key}` } : {}, body: source }), { params: Promise.resolve({ collection, slug }) });
  const json = (await res.json()) as { data?: Outcome; error?: { message: string; issues?: string[] } };
  return { status: res.status, data: json.data, error: json.error };
}

async function publish(id: string) {
  const { PATCH } = await import("@/app/api/v1/posts/[id]/route");
  const res = await PATCH(new Request(`${site}/api/v1/posts/${id}`, { method: "PATCH", headers: { authorization: `Bearer ${writeKey}` }, body: JSON.stringify({ status: "published", publishedAt: "2026-10-27T18:00:00+05:30" }) }), { params: Promise.resolve({ id }) });
  expect(res.status).toBe(200);
}

beforeEach(async () => {
  db = await freshDb();
  await db.insert(schema.user).values([
    { id: "admin", name: "A", email: "a@example.com", role: "admin" },
    { id: "author", name: "B", email: "b@example.com", role: "author" },
  ]);
  await db.insert(schema.authorProfile).values([
    { userId: "admin", slug: "writer", displayName: "A" },
    { userId: "author", slug: "second-writer", displayName: "B" },
  ]);
  invalidateContent();
  draftKey = (await createApiKey(admin, { name: "ci", scopes: ["posts:draft"] })).key;
  writeKey = (await createApiKey(admin, { name: "rw", scopes: ["posts:read", "posts:write"] })).key;
});
afterEach(() => setDbForTests(undefined));

describe("PUT /api/v1/posts/by-path", () => {
  it("creates a draft from the file, whatever its status says, with a draft-only key", async () => {
    const res = await put(draftKey, "blog/pushed-file.mdx", mdx("pushed-file"));
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ action: "created", status: "draft", url: "/blog/pushed-file" });
    expect(res.data!.admin).toBe(`/admin/posts/${res.data!.id}`);
    const [row] = await db.select().from(schema.post);
    expect(row).toMatchObject({ collection: "blog", slug: "pushed-file", status: "draft", publishedAt: null, authorId: "admin", body: "Body text.\n", category: "ai-engineering" });
  });

  it("updates a draft from the file, and changes nothing when the file is the same", async () => {
    const first = (await put(draftKey, "blog/pushed-file", mdx("pushed-file"))).data!;
    const same = (await put(draftKey, "blog/pushed-file", mdx("pushed-file"))).data!;
    expect(same).toMatchObject({ action: "unchanged", id: first.id });
    const [before] = await db.select().from(schema.post);

    const tags = "tags: [GitOps, argocd]\nfeaturedImage: { src: /images/roboshop-ai/hero.jpg, alt: The shop, width: 1600, height: 900 }\n";
    const second = (await put(draftKey, "blog/pushed-file", mdx("pushed-file", "Second version.", tags))).data!;
    expect(second).toMatchObject({ action: "updated", id: first.id, status: "draft" });
    const [after] = await db.select().from(schema.post);
    expect(after).toMatchObject({ body: "Second version.\n", tags: ["gitops", "argocd"], status: "draft" });
    expect(after!.version).toBe(before!.version + 1);
    // The same file again, now with tags and a cover: jsonb key order and tag normalisation do not count as a change.
    expect((await put(draftKey, "blog/pushed-file", mdx("pushed-file", "Second version.", tags))).data).toMatchObject({ action: "unchanged" });
    expect((await db.select().from(schema.post))[0]!.version).toBe(after!.version);
    expect(await db.select().from(schema.post)).toHaveLength(1);
  });

  it("drops updatedAt for a post that has no publication date", async () => {
    // The schema refuses updatedAt without publishedAt, and a pushed file never sets the publication date.
    const source = mdx("dated-file", "Body text.", "updatedAt: 2026-10-28T09:00:00+05:30\n");
    const first = await put(draftKey, "blog/dated-file", source);
    expect(first.data).toMatchObject({ action: "created", status: "draft" });
    expect((await db.select().from(schema.post))[0]).toMatchObject({ publishedAt: null, updatedAt: null });
    expect((await put(draftKey, "blog/dated-file", source)).data).toMatchObject({ action: "unchanged" });
  });

  it("mode=create never changes an existing post", async () => {
    const first = (await put(draftKey, "blog/create-only", mdx("create-only"), "?mode=create")).data!;
    expect(first.action).toBe("created");
    const again = (await put(draftKey, "blog/create-only", mdx("create-only", "Edited body that must not reach the draft."), "?mode=create")).data!;
    expect(again).toMatchObject({ action: "exists", id: first.id });
    expect((await db.select().from(schema.post))[0]!.body).toBe("Body text.\n");
  });

  it("leaves a published post alone, unless a key that may publish asks for live=1", async () => {
    const first = (await put(draftKey, "blog/live-post", mdx("live-post"))).data!;
    await publish(first.id);
    const edited = mdx("live-post", "Edited after publishing.");

    const skipped = (await put(draftKey, "blog/live-post", edited)).data!;
    expect(skipped).toMatchObject({ action: "skipped", status: "published" });
    expect(skipped.reason).toMatch(/is published; edit it in Admin → Posts/);
    // live=1 is not enough with a draft-only key.
    expect((await put(draftKey, "blog/live-post", edited, "?live=1")).data).toMatchObject({ action: "skipped" });
    expect((await db.select().from(schema.post))[0]!.body).toBe("Body text.\n");

    expect((await put(writeKey, "blog/live-post", edited)).data).toMatchObject({ action: "skipped" });
    expect((await put(writeKey, "blog/live-post", edited, "?live=1")).data).toMatchObject({ action: "updated", status: "published" });
    const [row] = await db.select().from(schema.post);
    expect(row).toMatchObject({ status: "published", body: "Edited after publishing.\n" });
    expect(row!.publishedAt?.toISOString()).toBe("2026-10-27T12:30:00.000Z");
  });

  it("skips a post that is in the trash", async () => {
    const first = (await put(draftKey, "blog/trashed", mdx("trashed"))).data!;
    await db.update(schema.post).set({ deletedAt: new Date() }).where(eq(schema.post.id, first.id));
    const res = (await put(draftKey, "blog/trashed", mdx("trashed", "New body."))).data!;
    expect(res).toMatchObject({ action: "skipped" });
    expect(res.reason).toMatch(/in the trash/);
  });

  it("refuses a file that is not valid, with the reasons", async () => {
    const noFrontmatter = await put(draftKey, "blog/plain", "Just text, no frontmatter.");
    expect(noFrontmatter.status).toBe(400);
    expect(noFrontmatter.error!.issues!.join(" ")).toMatch(/frontmatter/);

    const wrongSlug = await put(draftKey, "blog/file-name", mdx("another-slug"));
    expect(wrongSlug.status).toBe(400);
    expect(wrongSlug.error!.issues!.join(" ")).toMatch(/the file says "another-slug" but it was sent as "file-name"/);

    const badFields = await put(draftKey, "blog/bad-fields", mdx("bad-fields").replace("title: A post pushed as a file through the API", "title: Short"));
    expect(badFields.status).toBe(400);
    expect(badFields.error!.issues!.some((i) => i.startsWith("title:"))).toBe(true);

    const missingImage = await put(draftKey, "blog/missing-image", mdx("missing-image", "![A diagram](/images/not-pushed/diagram.png)"));
    expect(missingImage.status).toBe(400);
    expect(missingImage.error!.issues!.join(" ")).toMatch(/image \/images\/not-pushed\/diagram\.png not found/);

    expect((await put(draftKey, "pages/about", mdx("about"))).status).toBe(400);
    expect((await put(draftKey, "blog/Not_A_Slug", mdx("Not_A_Slug"))).status).toBe(400);
    expect((await put(draftKey, "blog/too-big", mdx("too-big", "x".repeat(1024 * 1024)))).status).toBe(413);
    expect(await db.select().from(schema.post)).toHaveLength(0);
  });

  it("needs a key that may write posts, and keeps authors to their own posts", async () => {
    expect((await put(null, "blog/pushed-file", mdx("pushed-file"))).status).toBe(401);
    const readKey = (await createApiKey(admin, { name: "ro", scopes: ["posts:read"] })).key;
    expect((await put(readKey, "blog/pushed-file", mdx("pushed-file"))).status).toBe(403);
    const imagesKey = (await createApiKey(admin, { name: "img", scopes: ["images:write"] })).key;
    expect((await put(imagesKey, "blog/pushed-file", mdx("pushed-file"))).status).toBe(403);

    await put(draftKey, "blog/admins-post", mdx("admins-post"));
    const authorKey = (await createApiKey(author, { name: "author", scopes: ["posts:draft"] })).key;
    const taken = await put(authorKey, "blog/admins-post", mdx("admins-post", "Someone else's text."));
    expect(taken.status).toBe(409);
    expect(taken.error!.message).toMatch(/belongs to another author/);
    expect((await db.select().from(schema.post))[0]!.body).toBe("Body text.\n");
    const own = (await put(authorKey, "blog/authors-post", mdx("authors-post"))).data!;
    expect(own.action).toBe("created");
    expect((await db.select().from(schema.post).where(eq(schema.post.id, own.id)))[0]!.authorId).toBe("author");
  });
});

describe("comparing a post with its file", () => {
  it("ignores key order and compares the update time as an instant", async () => {
    const source = mdx("compare-me", "Body.", "updatedAt: 2026-10-28T09:00:00+05:30\nsources:\n  - { title: Source, url: https://example.com/a, publisher: Example }\n");
    const fields = fieldsFromMdx("blog", "compare-me", source);
    const row = { ...fields, sources: [{ url: "https://example.com/a", publisher: "Example", title: "Source" }], updatedAt: new Date("2026-10-28T03:30:00Z") } as unknown as Parameters<typeof sameAsFile>[0];
    expect(sameAsFile(row, fields)).toBe(true);
    expect(sameAsFile({ ...row, updatedAt: new Date("2026-10-28T03:31:00Z") }, fields)).toBe(false);
    expect(sameAsFile({ ...row, body: "Other.\n" }, fields)).toBe(false);
    expect(sameAsFile({ ...row, tags: ["x"] }, fields)).toBe(false);
  });
});
