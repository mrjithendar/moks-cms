import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schema, setDbForTests, type Db } from "@/db";
import type { Actor } from "@/lib/posts";
import { fakeR2 } from "./fake-r2";
import { freshDb } from "./db-helpers";

vi.mock("server-only", () => ({}));
const r2 = fakeR2();
vi.mock("@/lib/storage", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/storage")>()), ...r2 }));

const { acceptVideoGeneration, checkVideoOperation, discardVideoGeneration, downloadVideo, startVideoGeneration, videoConfig, videoGenerationProgress, VideoGenError } = await import("@/lib/video-generation");
const { markdownToHtml } = await import("@/lib/mdx/html");

const admin: Actor = { id: "admin", role: "admin", label: "admin@example.com" };
const author: Actor = { id: "author", role: "author", label: "a@example.com" };
const other: Actor = { id: "other", role: "author", label: "o@example.com" };
const reader: Actor = { id: "reader", role: "user", label: "r@example.com" };

const config = { apiKey: "test-gemini-key", model: "configured-video-model", base: "https://gemini.test/v1beta", timeoutMs: 600_000, requestTimeoutMs: 2_000 };
const limits = { perUserHourly: 2, dailyTotal: 100 };
const PROMPT = "A looping animation of packets flowing between Kubernetes pods";
const OPERATION = "models/configured-video-model/operations/op-123";
const VIDEO_URI = "https://gemini.test/v1beta/files/abc:download?alt=media";
/** The smallest thing the type check accepts as an MP4: an ftyp box. */
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(32, 1)]);

const jsonReply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const done = (uri = VIDEO_URI) => ({ name: OPERATION, done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri } }] } } });

/** A provider that starts an operation, answers polls with `operation()` and serves `bytes` as the clip. */
function provider(operation: () => unknown, bytes: Buffer = MP4) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    expect((init?.headers as Record<string, string>)["x-goog-api-key"]).toBe("test-gemini-key");
    if (url.endsWith(":predictLongRunning")) return jsonReply({ name: OPERATION });
    if (url === `${config.base}/${OPERATION}`) return jsonReply(operation());
    if (url === VIDEO_URI) return new Response(new Uint8Array(bytes), { status: 200, headers: { "Content-Type": "video/mp4" } });
    return new Response("not found", { status: 404 });
  });
}

let db: Db;
beforeEach(async () => {
  r2.objects.clear();
  db = await freshDb();
  for (const a of [admin, author, other, reader]) await db.insert(schema.user).values({ id: a.id, name: a.id, email: a.label, role: a.role });
});
afterEach(() => setDbForTests(undefined));

const rowOf = async (id: string) => (await db.select().from(schema.imageGeneration).where(eq(schema.imageGeneration.id, id)))[0]!;

describe("video configuration", () => {
  it("is off unless both the Gemini key and a video model are set (no built-in model name)", () => {
    expect(videoConfig("k", {})).toBeNull();
    expect(videoConfig(undefined, { GEMINI_VIDEO_MODEL: "m" })).toBeNull();
    expect(videoConfig("k", { GEMINI_VIDEO_MODEL: "m" })).toMatchObject({ model: "m", base: "https://generativelanguage.googleapis.com/v1beta", timeoutMs: 600_000 });
    const tuned = videoConfig("k", { GEMINI_VIDEO_MODEL: "m", GEMINI_VIDEO_RESOLUTION: "720p", GEMINI_VIDEO_SECONDS: "8", GEMINI_VIDEO_ENDPOINT: "https://proxy.test/v1beta/" });
    expect(tuned).toMatchObject({ resolution: "720p", durationSeconds: 8, base: "https://proxy.test/v1beta" });
    expect(videoConfig("k", { GEMINI_VIDEO_MODEL: "m", GEMINI_VIDEO_SECONDS: "abc" })).not.toHaveProperty("durationSeconds");
  });
});

describe("video provider client", () => {
  it("reports a filtered or empty result, and an operation error, as typed failures", async () => {
    const filtered = vi.fn<typeof fetch>(async () => jsonReply({ done: true, response: { generateVideoResponse: { raiMediaFilteredCount: 1, raiMediaFilteredReasons: ["blocked"] } } }));
    await expect(checkVideoOperation(config, OPERATION, filtered)).rejects.toMatchObject({ code: "refused" });
    const empty = vi.fn<typeof fetch>(async () => jsonReply({ done: true, response: {} }));
    await expect(checkVideoOperation(config, OPERATION, empty)).rejects.toMatchObject({ code: "empty" });
    const failed = vi.fn<typeof fetch>(async () => jsonReply({ done: true, error: { code: 13, message: "internal" } }));
    await expect(checkVideoOperation(config, OPERATION, failed)).rejects.toBeInstanceOf(VideoGenError);
    expect(await checkVideoOperation(config, OPERATION, vi.fn<typeof fetch>(async () => jsonReply({ name: OPERATION })))).toEqual({ done: false });
  });

  it("never sends the API key to a host it does not expect", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(new Uint8Array(MP4)));
    await expect(downloadVideo(config, "https://evil.example/clip.mp4", fetchImpl)).rejects.toMatchObject({ code: "invalid_video" });
    await expect(downloadVideo(config, "http://gemini.test/clip.mp4", fetchImpl)).rejects.toMatchObject({ code: "invalid_video" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("video generation workflow", () => {
  it("starts, waits while the provider works, then stores a verified clip privately", async () => {
    let finished = false;
    const fetchImpl = provider(() => (finished ? done() : { name: OPERATION }));
    const { id } = await startVideoGeneration(author, { prompt: PROMPT, aspectRatio: "16:9" }, { config, fetchImpl, limits });
    expect(await rowOf(id)).toMatchObject({ kind: "video", status: "running", operation: OPERATION, model: "configured-video-model", aspectRatio: "16:9" });
    const sent = JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body));
    expect(sent).toEqual({ instances: [{ prompt: PROMPT }], parameters: { aspectRatio: "16:9" } });

    expect(await videoGenerationProgress(author, id, { config, fetchImpl })).toEqual({ status: "running" });
    expect(r2.objects.size).toBe(0);
    finished = true;
    const ready = await videoGenerationProgress(author, id, { config, fetchImpl });
    expect(ready).toMatchObject({ status: "succeeded", previewUrl: `/api/admin/videos/generations/${id}`, sizeBytes: MP4.length });
    const row = await rowOf(id);
    expect(row).toMatchObject({ status: "succeeded", contentType: "video/mp4", sizeBytes: MP4.length });
    expect(row.tempKey).toMatch(/\/tmp\/generated\//);
    expect(r2.objects.get(row.tempKey!)).toMatchObject({ contentType: "video/mp4", cacheControl: "private, no-store" });
    // Asking again does not download a second time.
    const calls = fetchImpl.mock.calls.length;
    expect(await videoGenerationProgress(author, id, { config, fetchImpl })).toMatchObject({ status: "succeeded" });
    expect(fetchImpl.mock.calls.length).toBe(calls);
  });

  it("is for editors only, and only the author (or an admin) can see a generation", async () => {
    await expect(startVideoGeneration(reader, { prompt: PROMPT, aspectRatio: "16:9" }, { config, fetchImpl: provider(done), limits })).rejects.toMatchObject({ status: 403 });
    await expect(startVideoGeneration(author, { prompt: PROMPT, aspectRatio: "16:9" }, { config: null, limits })).rejects.toMatchObject({ status: 503 });
    await expect(startVideoGeneration(author, { prompt: "short", aspectRatio: "16:9" }, { config, limits })).rejects.toMatchObject({ status: 400 });
    await expect(startVideoGeneration(author, { prompt: PROMPT, aspectRatio: "1:1" }, { config, limits })).rejects.toMatchObject({ status: 400 });
    const fetchImpl = provider(done);
    const { id } = await startVideoGeneration(author, { prompt: PROMPT, aspectRatio: "9:16" }, { config, fetchImpl, limits });
    await expect(videoGenerationProgress(other, id, { config, fetchImpl })).rejects.toMatchObject({ status: 404 });
    expect(await videoGenerationProgress(admin, id, { config, fetchImpl })).toMatchObject({ status: "succeeded" });
  });

  it("allows one running video per author and enforces the hourly limit", async () => {
    const fetchImpl = provider(() => ({ name: OPERATION }));
    const first = await startVideoGeneration(author, { prompt: PROMPT, aspectRatio: "16:9" }, { config, fetchImpl, limits });
    await expect(startVideoGeneration(author, { prompt: PROMPT, aspectRatio: "16:9" }, { config, fetchImpl, limits })).rejects.toMatchObject({ status: 409 });
    await discardVideoGeneration(author, first.id);
    expect(await rowOf(first.id)).toMatchObject({ status: "cancelled" });
    expect(await videoGenerationProgress(author, first.id, { config, fetchImpl })).toEqual({ status: "failed", error: "Generation cancelled." });
    const second = await startVideoGeneration(author, { prompt: PROMPT, aspectRatio: "16:9" }, { config, fetchImpl, limits });
    await discardVideoGeneration(author, second.id);
    await expect(startVideoGeneration(author, { prompt: PROMPT, aspectRatio: "16:9" }, { config, fetchImpl, limits })).rejects.toMatchObject({ status: 429 });
  });

  it("records a failed start, a refusal, a timeout and a clip that is not an MP4", async () => {
    const down = vi.fn<typeof fetch>(async () => jsonReply({ error: { message: "quota exceeded" } }, 429));
    await expect(startVideoGeneration(author, { prompt: PROMPT, aspectRatio: "16:9" }, { config, fetchImpl: down, limits })).rejects.toMatchObject({ status: 429 });
    expect((await db.select().from(schema.imageGeneration))[0]).toMatchObject({ status: "failed", errorCode: "quota" });

    const refused = provider(() => ({ done: true, response: { generateVideoResponse: { raiMediaFilteredCount: 1 } } }));
    const a = await startVideoGeneration(other, { prompt: PROMPT, aspectRatio: "16:9" }, { config, fetchImpl: refused, limits });
    expect(await videoGenerationProgress(other, a.id, { config, fetchImpl: refused })).toMatchObject({ status: "failed", error: expect.stringMatching(/content policy/) });
    expect(await rowOf(a.id)).toMatchObject({ status: "failed", errorCode: "refused" });

    const slow = provider(() => ({ name: OPERATION }));
    const b = await startVideoGeneration(admin, { prompt: PROMPT, aspectRatio: "16:9" }, { config, fetchImpl: slow, limits });
    expect(await videoGenerationProgress(admin, b.id, { config, fetchImpl: slow, now: Date.now() + config.timeoutMs + 1_000 })).toMatchObject({ status: "failed", error: expect.stringMatching(/too long/) });

    const junk = provider(done, Buffer.from("<html>definitely not a video file</html>"));
    const c = await startVideoGeneration(admin, { prompt: PROMPT, aspectRatio: "16:9" }, { config, fetchImpl: junk, limits });
    expect(await videoGenerationProgress(admin, c.id, { config, fetchImpl: junk })).toMatchObject({ status: "failed", error: expect.stringMatching(/not a valid MP4/) });
    expect(r2.objects.size).toBe(0);
  });

  it("keeps waiting when a poll cannot reach the provider", async () => {
    let outage = false;
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      if (String(input).endsWith(":predictLongRunning")) return jsonReply({ name: OPERATION });
      if (outage) return new Response("bad gateway", { status: 502 });
      return jsonReply({ name: OPERATION });
    });
    const { id } = await startVideoGeneration(author, { prompt: PROMPT, aspectRatio: "16:9" }, { config, fetchImpl, limits });
    outage = true;
    expect(await videoGenerationProgress(author, id, { config, fetchImpl })).toEqual({ status: "running" });
    expect(await rowOf(id)).toMatchObject({ status: "running" });
  });

  it("accepting puts the clip in the media library once; discarding deletes it", async () => {
    const fetchImpl = provider(done);
    const { id } = await startVideoGeneration(author, { prompt: PROMPT, aspectRatio: "9:16" }, { config, fetchImpl, limits });
    await videoGenerationProgress(author, id, { config, fetchImpl });
    await expect(acceptVideoGeneration(author, id, { description: " " })).rejects.toMatchObject({ status: 400 });
    const video = await acceptVideoGeneration(author, id, { description: "Packets flowing between pods", context: "posts/blog/pod-networking", name: "pod-networking" });
    expect(video).toMatchObject({ aspectRatio: "9:16" });
    expect(video.src).toBe(`/media/${video.id}/pod-networking.mp4`);
    const [media] = await db.select().from(schema.media);
    expect(media).toMatchObject({ id: video.id, kind: "videos", contentType: "video/mp4", storageBackend: "r2", status: "ready", context: "posts/blog/pod-networking", alt: "Packets flowing between pods", sizeBytes: MP4.length, uploadedBy: "author" });
    expect(r2.objects.get(media!.storageKey)).toBeDefined();
    expect(await rowOf(id)).toMatchObject({ status: "accepted", mediaId: video.id, tempKey: null });
    expect([...r2.objects.keys()].some((k) => k.includes("/tmp/"))).toBe(false);
    await expect(acceptVideoGeneration(author, id, { description: "again" })).rejects.toMatchObject({ status: 410 });

    const next = await startVideoGeneration(admin, { prompt: PROMPT, aspectRatio: "16:9" }, { config, fetchImpl, limits });
    await videoGenerationProgress(admin, next.id, { config, fetchImpl });
    await discardVideoGeneration(admin, next.id);
    expect(await rowOf(next.id)).toMatchObject({ status: "discarded", tempKey: null });
    expect([...r2.objects.keys()].some((k) => k.includes("/tmp/"))).toBe(false);
  });
});

describe("::video loop", () => {
  it("plays muted, by itself and repeating, and keeps the controls", async () => {
    const src = "/media/0f8fad5b-d9cb-469f-a165-70867728950e/demo.mp4";
    const html = await markdownToHtml(`::video{src="${src}" loop="true"}`);
    expect(html).toMatch(/<video [^>]*controls/);
    for (const attribute of ["autoplay", "muted", "loop", "playsinline"]) expect(html).toMatch(new RegExp(`<video [^>]*\\b${attribute}\\b`));
    expect(await markdownToHtml(`::video{src="${src}"}`)).not.toMatch(/autoplay|muted/);
  });
});
