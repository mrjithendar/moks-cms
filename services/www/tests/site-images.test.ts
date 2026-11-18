import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schema, setDbForTests, type Db } from "@/db";
import type { Actor } from "@/lib/posts";
import { fakeR2, JPEG_1x1, PNG_1x1 } from "./fake-r2";
import { freshDb } from "./db-helpers";

vi.mock("server-only", () => ({}));
const r2 = fakeR2();
vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  ...r2,
  getObjectBytes: async (key: string) => r2.objects.get(key)?.body ?? null,
}));

const { default: sharp } = await import("sharp");
const { createApiKey } = await import("@/lib/api-keys");
const { resolveImage } = await import("@/lib/media");
const { ownImageBytes } = await import("@/lib/site-config/image-bytes");
const { clearSiteImageCache, putSiteImage, siteImagePath, svgProblem } = await import("@/lib/site-images");
const { GET: listRoute } = await import("@/app/api/v1/images/route");
const { POST: postRoute, PUT: putRoute } = await import("@/app/api/v1/images/[...path]/route");
const { GET: imageRoute } = await import("@/app/images/[...path]/route");

const admin: Actor = { id: "admin", role: "admin", label: "admin@example.com" };
const author: Actor = { id: "author", role: "author", label: "a@example.com" };
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const KEY = "jithendar/www/site-images";

/** An uncompressed PNG of one colour: lossless WebP is far smaller, so it is always converted. */
const diagram = (r: number) => sharp({ create: { width: 320, height: 200, channels: 3, background: { r, g: 110, b: 200 } } }).png({ compressionLevel: 0 }).toBuffer();
const SVG_OK = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" viewBox="0 0 120 80"><foreignObject width="120" height="80"><div xmlns="http://www.w3.org/1999/xhtml" style="color: red">status online = true</div></foreignObject></svg>');

const segments = (path: string) => path.replace(/^\/images\//, "").split("/");
const put = (key: string | null, path: string, body: Buffer) =>
  putRoute(new Request(`https://jithendar.com/api/v1${path}`, { method: "PUT", headers: key ? { authorization: `Bearer ${key}` } : {}, body: new Uint8Array(body) }), { params: Promise.resolve({ path: segments(path) }) });
const post = (key: string, path: string, body: unknown) =>
  postRoute(new Request(`https://jithendar.com/api/v1${path}`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ path: segments(path) }) });
const PDF = Buffer.from("%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n");
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(200, 7)]);
const get = (path: string, headers: Record<string, string> = {}) => imageRoute(new Request(`https://jithendar.com${path}`, { headers }), { params: Promise.resolve({ path: segments(path) }) });
const data = async <T>(res: Response) => ((await res.json()) as { data: T }).data;
const message = async (res: Response) => ((await res.json()) as { error: { message: string } }).error.message;

type Pushed = { path: string; servedPath: string; contentType: string; bytes: number; sourceBytes: number; sha256: string; width: number; height: number; converted: boolean; created: boolean; unchanged: boolean };

let db: Db;
let adminKey: string;
beforeEach(async () => {
  r2.objects.clear();
  clearSiteImageCache();
  db = await freshDb();
  for (const a of [admin, author]) await db.insert(schema.user).values({ id: a.id, name: a.id, email: a.label, role: a.role });
  adminKey = (await createApiKey(admin, { name: "ci", scopes: ["images:write"] })).key;
});
afterEach(() => setDbForTests(undefined));

describe("site image paths", () => {
  it("accepts plain file paths with an image extension", () => {
    expect(siteImagePath(["aws-vpc", "01-what-is-a-vpc.svg"])).toBe("/images/aws-vpc/01-what-is-a-vpc.svg");
    expect(siteImagePath(["cover_2.PNG"])).toBe("/images/cover_2.PNG");
  });

  const BAD: [string, string[]][] = [
    ["no segments", []],
    ["a parent directory", ["..", "secret.png"]],
    ["dots inside a segment", ["a..b", "x.png"]],
    ["a dot file", [".hidden.png"]],
    ["a space", ["my image.png"]],
    ["an encoded slash", ["a%2Fb.png"]],
    ["no extension", ["folder", "file"]],
    ["another file type", ["notes.txt"]],
    ["a script", ["page.html"]],
    ["too deep", ["a", "b", "c", "d", "e", "f", "g.png"]],
    ["too long", ["x".repeat(200) + ".png"]],
  ];
  it.each(BAD)("refuses %s", (_name, parts) => {
    expect(() => siteImagePath(parts)).toThrow(/Not a valid image path/);
  });
});

describe("pushing a site image", () => {
  it("stores a PNG as lossless WebP and serves it at both URLs", async () => {
    const png = await diagram(12);
    const res = await put(adminKey, "/images/pushed/diagram.png", png);
    expect(res.status).toBe(200);
    const pushed = await data<Pushed>(res);
    expect(pushed).toMatchObject({ path: "/images/pushed/diagram.png", servedPath: "/images/pushed/diagram.webp", contentType: "image/webp", sourceBytes: png.length, sha256: sha(png), width: 320, height: 200, converted: true, created: true, unchanged: false });
    expect(pushed.bytes).toBeLessThan(png.length);

    // One object, the WebP, with the same pixels as the PNG that was pushed.
    expect([...r2.objects.keys()]).toEqual([`${KEY}/pushed/diagram.webp`]);
    const stored = r2.objects.get(`${KEY}/pushed/diagram.webp`)!;
    expect(stored.contentType).toBe("image/webp");
    expect(await sharp(stored.body).raw().toBuffer()).toEqual(await sharp(png).raw().toBuffer());

    // Pages request the .webp.
    const webp = await get("/images/pushed/diagram.webp");
    expect(webp.status).toBe(200);
    expect(webp.headers.get("content-type")).toBe("image/webp");
    expect(webp.headers.get("cache-control")).toBe("public, max-age=86400, stale-while-revalidate=604800");
    expect(webp.headers.get("x-content-type-options")).toBe("nosniff");
    expect(webp.headers.get("content-security-policy")).toContain("sandbox");
    expect(Buffer.from(await webp.arrayBuffer())).toEqual(stored.body);
    const etag = webp.headers.get("etag")!;
    expect((await get("/images/pushed/diagram.webp", { "if-none-match": etag })).status).toBe(304);

    // The .png URL still answers, with a PNG of the same picture (social cards, feeds, old links).
    const asPng = await get("/images/pushed/diagram.png");
    expect(asPng.headers.get("content-type")).toBe("image/png");
    expect(asPng.headers.get("etag")).not.toBe(etag);
    const back = Buffer.from(await asPng.arrayBuffer());
    expect((await sharp(back).metadata()).format).toBe("png");
    expect(await sharp(back).raw().toBuffer()).toEqual(await sharp(png).raw().toBuffer());

    expect((await get("/images/pushed/other.png")).status).toBe(404);
    expect((await get("/images/pushed/../../etc/passwd")).status).toBe(404);
  });

  it("resolves the path content uses to the stored image and its size", async () => {
    await put(adminKey, "/images/pushed/diagram.png", await diagram(12));
    expect(await resolveImage("/images/pushed/diagram.png")).toEqual({ src: "/images/pushed/diagram.webp", width: 320, height: 200, svg: false });
    expect(await resolveImage("/images/pushed/diagram.webp")).toEqual({ src: "/images/pushed/diagram.webp", width: 320, height: 200, svg: false });
    expect(await resolveImage("/images/pushed/missing.png")).toBeUndefined();
    // The social card needs PNG or JPEG bytes: the .png path gives them.
    const card = await ownImageBytes("/images/pushed/diagram.png");
    expect(card?.contentType).toBe("image/png");
    expect((await sharp(card!.bytes).metadata()).width).toBe(320);
  });

  it("changes nothing when the same bytes are pushed again, and replaces the image when they differ", async () => {
    const first = await diagram(12);
    await put(adminKey, "/images/pushed/diagram.png", first);
    const before = r2.objects.get(`${KEY}/pushed/diagram.webp`)!.body;
    const etag = (await get("/images/pushed/diagram.webp")).headers.get("etag");

    const again = await data<Pushed>(await put(adminKey, "/images/pushed/diagram.png", first));
    expect(again).toMatchObject({ created: false, unchanged: true, sha256: sha(first) });
    expect(r2.objects.get(`${KEY}/pushed/diagram.webp`)!.body).toBe(before);

    const second = await diagram(240);
    const replaced = await data<Pushed>(await put(adminKey, "/images/pushed/diagram.png", second));
    expect(replaced).toMatchObject({ created: false, unchanged: false, sha256: sha(second) });
    const now = await get("/images/pushed/diagram.webp");
    expect(now.headers.get("etag")).not.toBe(etag);
    expect(await sharp(Buffer.from(await now.arrayBuffer())).raw().toBuffer()).toEqual(await sharp(second).raw().toBuffer());
    expect(await db.select().from(schema.siteImage)).toHaveLength(1);
    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.target, "/images/pushed/diagram.png"));
    expect(audits.map((a) => a.action).sort()).toEqual(["site_image.create", "site_image.replace"]);
  });

  it("keeps JPEG and SVG files as they are", async () => {
    const jpg = await data<Pushed>(await put(adminKey, "/images/pushed/photo.jpg", JPEG_1x1));
    expect(jpg).toMatchObject({ servedPath: "/images/pushed/photo.jpg", contentType: "image/jpeg", converted: false, width: 1, height: 1 });
    expect(r2.objects.get(`${KEY}/pushed/photo.jpg`)!.body).toEqual(JPEG_1x1);

    const svg = await data<Pushed>(await put(adminKey, "/images/pushed/flow.svg", SVG_OK));
    expect(svg).toMatchObject({ servedPath: "/images/pushed/flow.svg", contentType: "image/svg+xml", converted: false, width: 120, height: 80 });
    const res = await get("/images/pushed/flow.svg");
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; sandbox");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(SVG_OK);
    expect(await resolveImage("/images/pushed/flow.svg")).toEqual({ src: "/images/pushed/flow.svg", width: 120, height: 80, svg: true });
    // An SVG is never handed to the social card renderer.
    expect(await ownImageBytes("/images/pushed/flow.svg")).toBeNull();
  });

  it("keeps a PNG that lossless WebP would not make smaller", async () => {
    // A hand-optimised 1×1 PNG (70 bytes): whichever form is smaller is stored, and both answers stay consistent.
    const pushed = await data<Pushed>(await put(adminKey, "/images/pushed/dot.png", PNG_1x1));
    expect(pushed.bytes).toBeLessThanOrEqual(PNG_1x1.length);
    expect(pushed.converted).toBe(pushed.servedPath.endsWith(".webp"));
    expect((await get(pushed.servedPath)).status).toBe(200);
    expect((await get("/images/pushed/dot.png")).headers.get("content-type")).toBe("image/png");
  });

  it("refuses files that are not what their name says, and SVGs that could run script", async () => {
    const wrongType = await put(adminKey, "/images/pushed/fake.jpg", PNG_1x1);
    expect(wrongType.status).toBe(400);
    expect(await message(wrongType)).toMatch(/the file is image\/png, but its name says image\/jpeg/);
    expect((await put(adminKey, "/images/pushed/page.png", Buffer.from("<!doctype html><script>alert(1)</script>"))).status).toBe(400);
    expect((await put(adminKey, "/images/pushed/empty.png", Buffer.alloc(0))).status).toBe(400);
    expect((await put(adminKey, "/images/pushed/notes.txt", Buffer.from("hello"))).status).toBe(400);
    expect((await put(adminKey, "/images/pushed/huge.png", Buffer.alloc(20 * 1024 * 1024 + 1))).status).toBe(413);

    expect(svgProblem(SVG_OK)).toBeNull();
    for (const bad of [
      '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><script>alert(1)</script></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1" onload="alert(1)"></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><a href="javascript:alert(1)">x</a></svg>',
      "<html><body>not an svg</body></html>",
    ]) {
      expect(svgProblem(Buffer.from(bad)), bad).not.toBeNull();
      expect((await put(adminKey, "/images/pushed/bad.svg", Buffer.from(bad))).status).toBe(400);
    }
    expect(r2.objects.size).toBe(0);
    expect(await db.select().from(schema.siteImage)).toHaveLength(0);
  });

  it("refuses two files that would share a URL", async () => {
    await put(adminKey, "/images/pushed/diagram.png", await diagram(12));
    const webp = await sharp(await diagram(12)).webp({ lossless: true }).toBuffer();
    const clash = await put(adminKey, "/images/pushed/diagram.webp", webp);
    expect(clash.status).toBe(409);
    expect(await message(clash)).toMatch(/would share a URL with \/images\/pushed\/diagram\.png/);
    expect(await db.select().from(schema.siteImage)).toHaveLength(1);
  });
});

describe("who may push site images", () => {
  it("needs an admin's key with the images:write scope", async () => {
    const png = await diagram(12);
    expect((await put(null, "/images/pushed/diagram.png", png)).status).toBe(401);
    const postsOnly = (await createApiKey(admin, { name: "posts", scopes: ["posts:read", "posts:write"] })).key;
    const denied = await put(postsOnly, "/images/pushed/diagram.png", png);
    expect(denied.status).toBe(403);
    expect(await message(denied)).toMatch(/lacks the images:write scope/);
    // An author cannot create such a key, and an author acting directly is refused as well.
    await expect(createApiKey(author, { name: "images", scopes: ["images:write"] })).rejects.toMatchObject({ status: 403 });
    await expect(putSiteImage(author, "/images/pushed/diagram.png", png)).rejects.toMatchObject({ status: 403 });
    expect(r2.objects.size).toBe(0);
  });

  it("lists the stored images with the hash of each pushed file", async () => {
    const png = await diagram(12);
    await put(adminKey, "/images/pushed/diagram.png", png);
    await put(adminKey, "/images/pushed/a-photo.jpg", JPEG_1x1);
    const list = (key: string | null, query = "") => listRoute(new Request(`https://jithendar.com/api/v1/images${query}`, { headers: key ? { authorization: `Bearer ${key}` } : {} }));
    expect((await list(null)).status).toBe(401);
    const rows = await data<Pushed[]>(await list(adminKey));
    expect(rows.map((r) => [r.path, r.servedPath, r.sha256])).toEqual([
      ["/images/pushed/a-photo.jpg", "/images/pushed/a-photo.jpg", sha(JPEG_1x1)],
      ["/images/pushed/diagram.png", "/images/pushed/diagram.webp", sha(png)],
    ]);
    expect(await data<Pushed[]>(await list(adminKey, "?limit=1&offset=1"))).toHaveLength(1);
    // A key that reads posts may read the list too; one that only writes drafts may not.
    const reader = (await createApiKey(author, { name: "reader", scopes: ["posts:read"] })).key;
    expect((await list(reader)).status).toBe(200);
    const drafts = (await createApiKey(author, { name: "drafts", scopes: ["posts:draft"] })).key;
    expect((await list(drafts)).status).toBe(403);
  });
});

describe("documents and media", () => {
  it("accepts a PDF in one PUT and streams it, never as an image", async () => {
    const res = await put(adminKey, "/images/docs/guide.pdf", PDF);
    expect(res.status).toBe(200);
    expect(await data<Pushed>(res)).toMatchObject({ path: "/images/docs/guide.pdf", contentType: "application/pdf", width: 0, height: 0, created: true });
    const served = await get("/images/docs/guide.pdf");
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("application/pdf");
    expect(served.headers.get("accept-ranges")).toBe("bytes");
    expect(served.headers.get("content-disposition")).toBe('inline; filename="guide.pdf"');
    expect(Buffer.from(await served.arrayBuffer()).equals(PDF)).toBe(true);
    expect(await resolveImage("/images/docs/guide.pdf")).toBeUndefined();
  });

  it("refuses a file that is not what its name says", async () => {
    const res = await put(adminKey, "/images/docs/guide.pdf", JPEG_1x1);
    expect(res.status).toBe(400);
    expect(await message(res)).toMatch(/but its name says application\/pdf/);
  });

  it("uploads a large file straight to R2, checks it, then puts it in place", async () => {
    const path = "/images/videos/demo.mp4";
    const start = await post(adminKey, path, { action: "start", size: MP4.length, sha256: sha(MP4) });
    expect(start.status).toBe(200);
    const intent = await data<{ upload: string; uploadUrl: string; headers: Record<string, string> }>(start);
    expect(intent.headers["Content-Type"]).toBe("video/mp4");
    const staged = `jithendar/www/tmp/site-files/${intent.upload}.mp4`;
    expect(intent.uploadUrl).toContain(staged);
    r2.objects.set(staged, { body: MP4, contentType: "video/mp4" }); // what the client's PUT to uploadUrl does

    const done = await post(adminKey, path, { action: "complete", upload: intent.upload, size: MP4.length, sha256: sha(MP4) });
    expect(done.status).toBe(200);
    expect(await data<Pushed>(done)).toMatchObject({ path, contentType: "video/mp4", bytes: MP4.length, sha256: sha(MP4), created: true });
    expect(r2.objects.has(staged)).toBe(false);
    expect(r2.objects.get(`${KEY}/videos/demo.mp4`)?.body.equals(MP4)).toBe(true);
    const served = await get(path);
    expect(served.headers.get("content-type")).toBe("video/mp4");
    expect(Buffer.from(await served.arrayBuffer()).equals(MP4)).toBe(true);
  });

  it("leaves the live file alone when an upload is wrong", async () => {
    const path = "/images/docs/guide.pdf";
    await put(adminKey, path, PDF);
    const begin = async () => data<{ upload: string }>(await post(adminKey, path, { action: "start", size: PDF.length, sha256: sha(PDF) }));

    const corrupt = await begin();
    const staged = `jithendar/www/tmp/site-files/${corrupt.upload}.pdf`;
    const other = Buffer.from(PDF.toString().replace("Catalog", "Catalof"));
    r2.objects.set(staged, { body: other, contentType: "application/pdf" });
    const refused = await post(adminKey, path, { action: "complete", upload: corrupt.upload, size: PDF.length, sha256: sha(PDF) });
    expect(refused.status).toBe(400);
    expect(await message(refused)).toMatch(/checksum mismatch/);
    expect(r2.objects.has(staged)).toBe(false);

    const missing = await begin();
    expect((await post(adminKey, path, { action: "complete", upload: missing.upload, size: PDF.length, sha256: sha(PDF) })).status).toBe(409);

    const wrongType = await begin();
    const jpeg = JPEG_1x1;
    r2.objects.set(`jithendar/www/tmp/site-files/${wrongType.upload}.pdf`, { body: jpeg, contentType: "application/pdf" });
    expect(await message(await post(adminKey, path, { action: "complete", upload: wrongType.upload, size: jpeg.length, sha256: sha(jpeg) }))).toMatch(/but its name says application\/pdf/);

    expect(r2.objects.get(`${KEY}/docs/guide.pdf`)?.body.equals(PDF)).toBe(true);
  });

  it("limits each type, and sends images in one PUT", async () => {
    const tooBig = await post(adminKey, "/images/videos/huge.mp4", { action: "start", size: 501 * 1024 * 1024, sha256: sha(MP4) });
    expect(tooBig.status).toBe(413);
    expect(await message(tooBig)).toMatch(/500 MB or smaller/);
    const image = await post(adminKey, "/images/pushed/diagram.png", { action: "start", size: 10, sha256: sha(MP4) });
    expect(image.status).toBe(400);
    expect(await message(image)).toMatch(/images are sent in one PUT/);
    expect((await post(adminKey, "/images/docs/guide.pdf", { action: "start", size: 10, sha256: "nope" })).status).toBe(400);
    expect((await post(adminKey, "/images/docs/guide.pdf", { action: "other" })).status).toBe(400);
  });
});
