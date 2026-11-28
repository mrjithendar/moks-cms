import { createHash, randomUUID } from "node:crypto";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter, TextReader, type FileEntry } from "@zip.js/zip.js";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schema, setDbForTests, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
import type { Actor } from "@/lib/posts";
import { seal, unseal } from "@/lib/secrets";
import { freshDb } from "./db-helpers";
import { fakeBuckets } from "./fake-backup-store";

/**
 * The whole life of a full site backup (D-108) against a real (PGlite) database and an in-memory bucket: a small site
 * (accounts, posts, a page, categories, comments with a reply, media records and their files, settings with a sealed
 * credential, Appearance, the audit log), a full backup through the job handler, the archive opened and read like an
 * admin would, the site damaged, a restore through the job handler, and the site checked to be back. Then what must
 * fail: a corrupt archive, a changed manifest, a ZIP Slip entry, a size limit, an interrupted upload, two operations
 * at once.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "user-agent": "vitest" }) }));

const fake = fakeBuckets();
vi.mock("@/lib/backup/store", async (orig) => ({
  ...(await orig<typeof import("@/lib/backup/store")>()),
  backupStore: async (b: string) => fake.store(b || "media"),
  mediaStore: async () => fake.store("media"),
}));
vi.mock("@/lib/storage", async (orig) => ({ ...(await orig<typeof import("@/lib/storage")>()), storageReady: async () => true }));

const admin: Actor = { id: "admin", role: "admin", label: "admin@example.com" };
let db: Db;

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const POST_A = randomUUID();
const POST_B = randomUUID();
const COMMENT = randomUUID();
const REPLY = randomUUID();
const MEDIA = randomUUID();
const mediaKey = `jithendar/www/media/images/2026/11/${MEDIA}.png`;
const docKey = `jithendar/www/media/documents/2026/11/${randomUUID()}.pdf`;
const siteImageKey = "jithendar/www/site-images/images/logo.png";
const tmpKey = `jithendar/www/tmp/generated/2026/11/${randomUUID()}.png`;
const bigKey = `jithendar/www/media/videos/2026/11/${randomUUID()}.mp4`;

async function seed() {
  await db.insert(schema.user).values([
    { id: admin.id, name: "Admin", email: admin.label, role: "admin" },
    { id: "author-1", name: "Author", email: "author@example.com", role: "author" },
    { id: "reader-1", name: "Reader", email: "reader@example.com", role: "user" },
  ]);
  await db.insert(schema.account).values([
    { id: "acc-admin", accountId: admin.id, providerId: "credential", userId: admin.id, password: "scrypt$secret-hash-admin" },
    { id: "acc-author", accountId: "author-1", providerId: "credential", userId: "author-1", password: "scrypt$secret-hash-author" },
    { id: "acc-author-gh", accountId: "gh-42", providerId: "github", userId: "author-1", accessToken: "gho_secret_access", refreshToken: "ghr_secret_refresh" },
  ]);
  await db.insert(schema.session).values({ id: "s1", token: "session-token-secret", userId: admin.id, expiresAt: new Date(Date.now() + 86_400_000) });
  await db.execute(sql`insert into category (slug, label, intro) values ('devops', 'DevOps', 'Pipelines'), ('python', 'Python', 'Snakes')`);
  await db.insert(schema.post).values([
    { id: POST_A, collection: "blog", slug: "first", title: "First post", description: "d", category: "devops", contentType: "mdx", body: "# Hello", status: "published", authorId: "author-1" },
    { id: POST_B, collection: "blog", slug: "second", title: "Second post", description: "d", category: "python", contentType: "mdx", body: "Body two", status: "draft", authorId: admin.id },
  ]);
  await db.insert(schema.page).values({ slug: "about", title: "About", description: "About me", body: "Original about text" });
  await db.insert(schema.comment).values([
    { id: COMMENT, postId: POST_A, userId: "reader-1", body: "Nice post", status: "approved" },
    { id: REPLY, postId: POST_A, userId: "author-1", body: "Thanks", status: "approved", parentId: COMMENT, rootId: COMMENT },
  ]);
  await db.insert(schema.media).values({ id: MEDIA, filename: "cover.png", contentType: "image/png", storageKey: mediaKey, sizeBytes: PNG.length, uploadedBy: "author-1" });
  await db.insert(schema.setting).values({ key: "integrations", value: { gemini: { enabled: true, model: "gemini-x", apiKey: seal("gemini-key-BEFORE") } } });
  await db.insert(schema.auditLog).values({ actor: admin.label, action: "post.publish", target: POST_A });
  const media = fake.store("media");
  await media.put(mediaKey, PNG, "image/png", "public, max-age=31536000, immutable");
  await media.put(docKey, Buffer.from("%PDF-1.4 invoice"), "application/pdf", "private, no-store");
  await media.put(siteImageKey, PNG, "image/png");
  await media.put(tmpKey, PNG, "image/png");
}

async function configure(extra: Record<string, unknown> = {}) {
  const { saveDestination, saveGeneral } = await import("@/lib/backups");
  await saveGeneral(admin, { schedule: "off", hourUtc: "21", retention: "5", encrypt: "on", ...extra });
  await saveDestination(admin, { enabled: true, bucket: "" });
}

/** Run every queued backup job now, as the backup loop would. */
async function work() {
  const { runDueJobs } = await import("@/lib/jobs");
  const { backupJobHandler, BACKUP_JOB } = await import("@/lib/backup/service");
  for (let i = 0; i < 5; i++) {
    const r = await runDueJobs({ [BACKUP_JOB]: backupJobHandler }, new Date(Date.now() + i * 3_600_000), 1, { kinds: [BACKUP_JOB] });
    if (!r.done && !r.retried && !r.failed) break;
  }
}

async function run(id: string) {
  const [r] = await db.select().from(schema.backupRun).where(eq(schema.backupRun.id, id));
  return r!;
}

const backups = () => [...fake.bucket("media").keys()].filter((k) => k.startsWith("jithendar/backups/") && k.endsWith(".zip"));

async function openZip(key: string, password?: string) {
  const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(fake.bucket("media").get(key)!.body)));
  const entries = (await reader.getEntries()) as FileEntry[];
  const text = async (suffix: string) => {
    const e = entries.find((x) => x.filename.endsWith(`/${suffix}`));
    if (!e) return null;
    return Buffer.from(await e.getData(new Uint8ArrayWriter(), { password: e.encrypted ? password : undefined })).toString("utf8");
  };
  return { entries, text, close: () => reader.close() };
}

beforeEach(async () => {
  fake.buckets.clear();
  fake.uploads.clear();
  fake.fail.uploadPart = null;
  fake.fail.read = null;
  db = await freshDb();
  await seed();
});
afterEach(() => setDbForTests(undefined));

describe("a full site backup", () => {
  it("is made by a background job: every table, every file, checksums, a signed manifest, no secrets", async () => {
    await configure();
    const { requestBackup } = await import("@/lib/backup/service");
    const requested = await requestBackup("full", "manual", { actor: admin, label: admin.label });
    expect(requested.status).toBe("pending");
    await work();
    const done = await run(requested.id);
    expect(done.error).toBeNull();
    expect(done).toMatchObject({ status: "completed", operation: "backup", backupType: "full" });
    expect(done.filename).toMatch(/^jithendar-com-backup-\d{4}-\d{2}-\d{2}-\d{6}-full\.zip$/);
    expect(done.sizeBytes).toBeGreaterThan(1000);
    const stored = fake.bucket("media").get(`jithendar/backups/${done.filename}`)!;
    expect(createHash("sha256").update(stored.body).digest("hex")).toBe(done.sha256);
    expect(fake.bucket("media").has(`jithendar/backups/${done.filename}.json`)).toBe(true);

    const { serverBackupPassword } = await import("@/lib/backups");
    const zip = await openZip(`jithendar/backups/${done.filename}`, serverBackupPassword());
    const root = done.filename!.replace(/\.zip$/, "");
    const names = zip.entries.map((e) => e.filename);
    expect(names.every((n) => n.startsWith(`${root}/`))).toBe(true);
    for (const rel of ["README.txt", "manifest.json", "checksums/SHA256SUMS", "database/schema.json", "database/tables/post.jsonl", "database/tables/page.jsonl", "database/tables/comment.jsonl", "database/tables/user.jsonl", "database/tables/account.jsonl", "database/tables/setting.jsonl", "database/tables/practice_problem.jsonl", "uploads-index.jsonl", "application/settings.json", "application/metadata.json", "application/site-files/site.json", "application/site-files/config/redirects.json", "deployment/environment.json", "deployment/restore-requirements.json"]) {
      expect(names, rel).toContain(`${root}/${rel}`);
    }
    // The files: media library, documents, site images; never the expiring AI images or the backups themselves.
    expect(names).toContain(`${root}/uploads/${mediaKey}`);
    expect(names).toContain(`${root}/uploads/${docKey}`);
    expect(names).toContain(`${root}/uploads/${siteImageKey}`);
    expect(names.some((n) => n.includes("/www/tmp/") || n.includes("uploads/jithendar/backups"))).toBe(false);
    // Credentials never leave: no session table, no password or OAuth token, no sealed value.
    expect(names.some((n) => /tables\/(session|verification|api_key|job|backup_run|schema_migrations)\.jsonl$/.test(n))).toBe(false);
    expect(zip.entries.filter((e) => !e.filename.endsWith("README.txt")).every((e) => e.encrypted)).toBe(true);
    const everything = (await Promise.all(names.filter((n) => !n.includes("/uploads/")).map((n) => zip.text(n.slice(root.length + 1))))).join("\n");
    for (const secret of ["scrypt$secret-hash", "gho_secret_access", "ghr_secret_refresh", "session-token-secret", '"tag":', '"tag": "']) expect(everything).not.toContain(secret);
    expect(everything).toContain('"$secret": "redacted"');
    const posts = (await zip.text("database/tables/post.jsonl"))!.trim().split("\n").map((l) => JSON.parse(l));
    expect(posts.map((p) => p.slug).sort()).toEqual(["first", "second"]);
    const accounts = (await zip.text("database/tables/account.jsonl"))!.trim().split("\n").map((l) => JSON.parse(l));
    expect(accounts).toHaveLength(3);
    expect(accounts.every((a) => !("password" in a) && !("access_token" in a) && !("refresh_token" in a))).toBe(true);

    // Checksums: SHA256SUMS covers every file; the manifest names its checksum and is signed.
    const sums = (await zip.text("checksums/SHA256SUMS"))!;
    const manifest = JSON.parse((await zip.text("manifest.json"))!);
    expect(createHash("sha256").update(sums).digest("hex")).toBe(manifest.checksums.sha256);
    const listed = sums.trim().split("\n").map((l) => l.slice(66));
    expect(listed.sort()).toEqual(names.map((n) => n.slice(root.length + 1)).filter((n) => n !== "manifest.json" && n !== "checksums/SHA256SUMS").sort());
    const line = sums.split("\n").find((l) => l.endsWith(`uploads/${mediaKey}`))!;
    expect(line.slice(0, 64)).toBe(createHash("sha256").update(PNG).digest("hex"));
    expect(manifest).toMatchObject({ format: "moks-cms-site-backup", formatVersion: 2, type: "full", status: "completed", site: { id: "jithendar-com" }, components: ["database", "uploads", "application", "deployment"] });
    expect(manifest.signature.algorithm).toBe("HMAC-SHA256");
    expect(manifest.database.excludedTables.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining(["session", "verification", "api_key", "job", "backup_run"]));
    expect(manifest.uploads).toMatchObject({ files: 3, referencedMissing: 0 });
    expect(manifest.database.perTable.find((t: { name: string }) => t.name === "post").rows).toBe(2);
    expect(manifest.database.secretsRedacted).toBeGreaterThanOrEqual(1);
    await zip.close();
    expect(done.detail).toMatchObject({ verification: { ok: true, signature: "valid" }, components: manifest.components });
  });

  it("restores a damaged site: rows, replies, files and accounts come back; today's credentials stay", async () => {
    await configure();
    const { requestBackup, requestRestore } = await import("@/lib/backup/service");
    const made = await run((await requestBackup("full", "manual", { actor: admin, label: admin.label })).id);
    await work();
    const name = (await run(made.id)).filename!;

    // Damage: a post deleted (its comments go with it), the page edited, a new post, an author gone, a file gone, and
    // the Gemini key changed since (the restore keeps the current one).
    await db.delete(schema.post).where(eq(schema.post.id, POST_A));
    await db.update(schema.page).set({ body: "Vandalised" }).where(eq(schema.page.slug, "about"));
    await db.insert(schema.post).values({ collection: "blog", slug: "after-backup", title: "Later", description: "d", category: "python", contentType: "mdx", authorId: admin.id });
    await db.delete(schema.account).where(eq(schema.account.userId, "author-1"));
    await db.execute(sql`update post set author_id = 'admin' where author_id = 'author-1'`);
    await db.execute(sql`update media set uploaded_by = null where uploaded_by = 'author-1'`);
    await db.delete(schema.user).where(eq(schema.user.id, "author-1"));
    fake.bucket("media").delete(mediaKey);
    await db.update(schema.setting).set({ value: { gemini: { enabled: true, model: "gemini-x", apiKey: seal("gemini-key-NOW") } } }).where(eq(schema.setting.key, "integrations"));
    await db.insert(schema.auditLog).values({ actor: admin.label, action: "post.delete", target: POST_A });

    await expect(requestRestore(admin, name, { components: { database: true, uploads: true }, allowUnsigned: false, confirmation: "yes" })).rejects.toThrow("Type RESTORE");
    const r = await requestRestore(admin, name, { components: { database: true, uploads: true }, allowUnsigned: false, confirmation: "RESTORE" });
    await work();
    const restored = await run(r.id);
    expect(restored.error).toBeNull();
    expect(restored.status).toBe("completed");
    const result = (restored.detail as { result: { signed: boolean; safetyBackup: string; uploads: unknown; database: unknown } }).result;
    expect(result.signed).toBe(true);
    expect(result.safetyBackup).toMatch(/-prerestore\.zip$/);
    expect(backups()).toContain(`jithendar/backups/${result.safetyBackup}`);
    expect(result.uploads).toMatchObject({ restored: 1, alreadyThere: 2 });
    expect(result.database).toMatchObject({ usersAdded: 1, rolesRestored: 1, secretsKept: 1 });

    const posts = await db.select().from(schema.post);
    expect(posts.map((p) => p.slug).sort()).toEqual(["first", "second"]);
    expect(posts.find((p) => p.slug === "first")!.authorId).toBe("author-1");
    const [about] = await db.select().from(schema.page).where(eq(schema.page.slug, "about"));
    expect(about!.body).toBe("Original about text");
    const comments = await db.select().from(schema.comment);
    expect(comments.find((c) => c.id === REPLY)!.parentId).toBe(COMMENT);
    const [author] = await db.select().from(schema.user).where(eq(schema.user.id, "author-1"));
    expect(author!.role).toBe("author"); // a signed archive of this site: the staff role comes back
    const accounts = await db.select().from(schema.account).where(eq(schema.account.userId, "author-1"));
    expect(accounts.map((a) => a.providerId).sort()).toEqual(["credential", "github"]);
    expect(accounts.every((a) => a.password === null && a.accessToken === null)).toBe(true); // they sign in again / reset
    const [admins] = await db.select().from(schema.account).where(eq(schema.account.id, "acc-admin"));
    expect(admins!.password).toBe("scrypt$secret-hash-admin"); // an existing account is never touched
    expect(fake.bucket("media").get(mediaKey)!.body.equals(PNG)).toBe(true);
    expect(fake.bucket("media").get(mediaKey)!.contentType).toBe("image/png");
    const [integrations] = await db.select().from(schema.setting).where(eq(schema.setting.key, "integrations"));
    expect(unseal((integrations!.value as { gemini: { apiKey: never } }).gemini.apiKey)).toBe("gemini-key-NOW");
    expect((await db.select().from(schema.session)).map((s) => s.id)).toEqual(["s1"]); // sessions are not touched
    const audits = await db.select().from(schema.auditLog);
    expect(audits.some((a) => a.action === "post.delete")).toBe(true); // the log only gains entries
    expect(audits.some((a) => a.action === "backup.restore")).toBe(true);
    // A new comment after the restore gets a fresh id; sequences are past the restored ids (no collision).
    await db.insert(schema.comment).values({ postId: POST_A, userId: "reader-1", body: "after", status: "approved" });
  });

  it("restores the files only, or the database only, as chosen", async () => {
    await configure();
    const { requestBackup, requestRestore } = await import("@/lib/backup/service");
    const id = (await requestBackup("full", "manual", { actor: admin, label: admin.label })).id;
    await work();
    const name = (await run(id)).filename!;
    fake.bucket("media").delete(mediaKey);
    await db.update(schema.page).set({ body: "Changed" }).where(eq(schema.page.slug, "about"));
    const r = await requestRestore(admin, name, { components: { database: false, uploads: true }, allowUnsigned: false, confirmation: "RESTORE" });
    await work();
    expect((await run(r.id)).status).toBe("completed");
    expect(fake.bucket("media").has(mediaKey)).toBe(true);
    const [about] = await db.select().from(schema.page).where(eq(schema.page.slug, "about"));
    expect(about!.body).toBe("Changed");
  });

  it("database-only backups hold no files", async () => {
    await configure();
    const { requestBackup } = await import("@/lib/backup/service");
    const id = (await requestBackup("database", "manual", { actor: admin, label: admin.label })).id;
    await work();
    const done = await run(id);
    expect(done.status).toBe("completed");
    expect(done.filename).toMatch(/-database\.zip$/);
    const { serverBackupPassword } = await import("@/lib/backups");
    const zip = await openZip(`jithendar/backups/${done.filename}`, serverBackupPassword());
    expect(zip.entries.some((e) => e.filename.includes("/uploads/"))).toBe(false);
    expect(JSON.parse((await zip.text("manifest.json"))!)).toMatchObject({ type: "database", uploads: null, components: ["database", "application", "deployment"] });
    await zip.close();
  });
});

describe("what a backup refuses", () => {
  it("verification fails for a corrupt archive, and nothing is restored from it", async () => {
    await configure();
    const { requestBackup, requestRestore, requestVerify } = await import("@/lib/backup/service");
    const id = (await requestBackup("full", "manual", { actor: admin, label: admin.label })).id;
    await work();
    const name = (await run(id)).filename!;
    const obj = fake.bucket("media").get(`jithendar/backups/${name}`)!;
    const corrupt = Buffer.from(obj.body);
    const at = Math.floor(corrupt.length / 3);
    corrupt.writeUInt8(corrupt.readUInt8(at) ^ 0xff, at);
    fake.bucket("media").set(`jithendar/backups/${name}`, { ...obj, body: corrupt });
    const v = await requestVerify(admin, name);
    await work();
    const verified = await run(v.id);
    expect(verified.status).toBe("failed");
    expect(verified.error).toMatch(/Verification failed/);
    await db.update(schema.page).set({ body: "Kept" }).where(eq(schema.page.slug, "about"));
    const r = await requestRestore(admin, name, { components: { database: true, uploads: true }, allowUnsigned: true, confirmation: "RESTORE" });
    await work();
    const restored = await run(r.id);
    expect(restored.status).toBe("failed");
    expect(restored.error).toMatch(/failed verification/);
    const [about] = await db.select().from(schema.page).where(eq(schema.page.slug, "about"));
    expect(about!.body).toBe("Kept");
  });

  it("a byte changed inside one file is found (its checksum or CRC), even in an unencrypted archive", async () => {
    await configure({ encrypt: "" });
    const big = Buffer.alloc(200_000);
    for (let i = 0; i < big.length; i++) big.writeUInt8((i * 31) % 251, i);
    await fake.store("media").put(bigKey, big, "video/mp4");
    const { requestBackup } = await import("@/lib/backup/service");
    const { verifyArchive } = await import("@/lib/backup/verify");
    const id = (await requestBackup("full", "manual", { actor: admin, label: admin.label })).id;
    await work();
    const name = (await run(id)).filename!;
    const obj = fake.bucket("media").get(`jithendar/backups/${name}`)!;
    const at = obj.body.indexOf(big.subarray(1000, 1064)) + 32; // stored without compression: the bytes are there as they are
    expect(at).toBeGreaterThan(100);
    const changed = Buffer.from(obj.body);
    changed.writeUInt8(changed.readUInt8(at) ^ 0x01, at);
    fake.bucket("media").set(`jithendar/backups/${name}`, { ...obj, body: changed });
    const report = await verifyArchive(fake.store("media"), name, { passwords: [] });
    expect(report.ok).toBe(false);
    expect(report.problems.join(" ")).toContain(`uploads/${bigKey}`);
  });

  it("a ZIP Slip entry, a symbolic link or an unknown file makes the archive invalid", async () => {
    await configure({ encrypt: "" });
    const { verifyArchive } = await import("@/lib/backup/verify");
    const name = "jithendar-com-backup-2026-11-28-120000-full.zip";
    const root = name.replace(/\.zip$/, "");
    for (const [path, opts] of [
      [`${root}/../../etc/cron.d/evil`, {}],
      [`${root}/uploads/../../../app/server.js`, {}],
      [`${root}/uploads/jithendar/www/media/link.png`, { externalFileAttributes: (0o120777 << 16) >>> 0 }],
      [`${root}/scripts/run.sh`, {}],
      [`other/manifest.json`, {}],
    ] as const) {
      const w = new ZipWriter(new Uint8ArrayWriter());
      await w.add(`${root}/README.txt`, new TextReader("x"));
      await w.add(path, new TextReader("payload"), opts);
      fake.bucket("media").set(`jithendar/backups/${name}`, { body: Buffer.from(await w.close()), contentType: "application/zip", cacheControl: "", lastModified: new Date().toISOString() });
      const report = await verifyArchive(fake.store("media"), name, { passwords: [] }).catch((e: Error) => ({ ok: false, problems: [e.message] }));
      expect(report.ok, path).toBe(false);
      expect(report.problems.join(" "), path).toMatch(/outside|unexpected|symbolic|\.\.|not a readable|unsafe/);
    }
  });

  it("a changed manifest no longer verifies (signature), and is restored only when the admin allows it, without staff roles", async () => {
    await configure({ encrypt: "" });
    const { requestBackup, requestRestore } = await import("@/lib/backup/service");
    const id = (await requestBackup("full", "manual", { actor: admin, label: admin.label })).id;
    await work();
    const name = (await run(id)).filename!;
    // Re-pack the archive with a manifest whose signature no longer matches (e.g. made with another site's key).
    const zip = await openZip(`jithendar/backups/${name}`);
    const w = new ZipWriter(new Uint8ArrayWriter());
    for (const e of zip.entries) {
      let data = Buffer.from(await e.getData(new Uint8ArrayWriter()));
      if (e.filename.endsWith("/manifest.json")) {
        const m = JSON.parse(data.toString());
        m.signature.value = "0".repeat(64);
        data = Buffer.from(JSON.stringify(m));
      }
      await w.add(e.filename, new Uint8ArrayReader(new Uint8Array(data)));
    }
    await zip.close();
    const obj = fake.bucket("media").get(`jithendar/backups/${name}`)!;
    fake.bucket("media").set(`jithendar/backups/${name}`, { ...obj, body: Buffer.from(await w.close()) });
    await db.update(schema.user).set({ role: "user" }).where(eq(schema.user.id, "author-1"));
    await db.execute(sql`update post set author_id = 'admin'`);
    await db.execute(sql`update media set uploaded_by = null`);
    await db.delete(schema.account).where(eq(schema.account.userId, "author-1"));
    await db.delete(schema.user).where(eq(schema.user.id, "author-1"));

    const refused = await requestRestore(admin, name, { components: { database: true, uploads: false }, allowUnsigned: false, confirmation: "RESTORE" });
    await work();
    expect((await run(refused.id)).error).toMatch(/signature/);
    const allowed = await requestRestore(admin, name, { components: { database: true, uploads: false }, allowUnsigned: true, confirmation: "RESTORE" });
    await work();
    const done = await run(allowed.id);
    expect(done.error).toBeNull();
    expect((done.detail as { result: { signed: boolean; database: { rolesNotRestored: number } } }).result).toMatchObject({ signed: false, database: { rolesNotRestored: 1 } });
    const [author] = await db.select().from(schema.user).where(eq(schema.user.id, "author-1"));
    expect(author!.role).toBe("user");
  });

  it("does not start a backup larger than the limit, and leaves nothing behind", async () => {
    await configure({ maxSizeMb: "1" });
    await fake.store("media").put(bigKey, Buffer.alloc(3 * 1024 * 1024, 7), "video/mp4");
    const { requestBackup } = await import("@/lib/backup/service");
    const id = (await requestBackup("full", "manual", { actor: admin, label: admin.label })).id;
    await work();
    const done = await run(id);
    expect(done.status).toBe("failed");
    expect(done.error).toMatch(/Not started: the backup would be about/);
    expect(backups()).toEqual([]);
    expect(fake.uploads.size).toBe(0);
  });

  it("an upload that keeps failing is retried, then fails: the multipart upload is aborted, no archive is left", async () => {
    await configure();
    fake.fail.uploadPart = () => Object.assign(new Error("We encountered an internal error. Please try again."), { $metadata: { httpStatusCode: 500 } });
    const { requestBackup } = await import("@/lib/backup/service");
    const id = (await requestBackup("full", "manual", { actor: admin, label: admin.label })).id;
    await work();
    const done = await run(id);
    expect(done.status).toBe("failed");
    expect(done.attempts).toBe(3);
    expect(backups()).toEqual([]);
    expect(fake.uploads.size).toBe(0);
  });

  it("one operation at a time: a second request waits for none, it is refused", async () => {
    await configure();
    const { requestBackup, requestVerify, BackupBusy } = await import("@/lib/backup/service");
    await requestBackup("full", "manual", { actor: admin, label: admin.label });
    await expect(requestBackup("database", "manual", { actor: admin, label: admin.label })).rejects.toBeInstanceOf(BackupBusy);
    await expect(requestVerify(admin, "jithendar-com-backup-2026-11-28-120000-full.zip")).rejects.toThrow(/Another backup operation/);
  });

  it("only admins ask for backups, verifications and restores", async () => {
    await configure();
    const { requestBackup, requestRestore } = await import("@/lib/backup/service");
    const author: Actor = { id: "author-1", role: "author", label: "author@example.com" };
    await expect(requestBackup("full", "manual", { actor: author, label: author.label })).rejects.toThrow("Only admins");
    await expect(requestRestore(author, "jithendar-com-backup-2026-11-28-120000-full.zip", { components: { database: true, uploads: true }, allowUnsigned: false, confirmation: "RESTORE" })).rejects.toThrow("Only admins");
  });
});

describe("retention", () => {
  it("keeps the newest N of each type after a backup, never one being restored", async () => {
    await configure({ retention: "1" });
    const { requestBackup } = await import("@/lib/backup/service");
    for (let i = 0; i < 3; i++) {
      await requestBackup("database", "manual", { actor: admin, label: admin.label });
      await work();
      await new Promise((r) => setTimeout(r, 1100)); // one second apart: names have second precision
    }
    expect(backups().filter((k) => k.endsWith("-database.zip"))).toHaveLength(1);
    expect(rowsOf(await db.execute(sql`select 1 from backup_run where status = 'completed'`))).toHaveLength(3);
  });
});
