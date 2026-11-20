import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { rowsOf } from "@/db/rows";
import { audit } from "./audit";
import { resolveGeminiImageConfig } from "./integrations";
import { log } from "./log";
import { mediaSrc, sanitizeFilename, sniffContentType } from "./media";
import type { Actor } from "./posts";
import { PostError } from "./posts";
import { copyObject, deleteObject, getObject, headObject, mediaObjectKey, normaliseContext, presignGet, putObject, storageReady, tempObjectKey } from "./storage";
import { DESTINATIONS, DestinationError, offeredDestinations, publishVideo, withPlayback, type DestinationId } from "./video-destinations";

/**
 * "Generate video" for the editor: a short clip from a text prompt with Google's Veo models through the Gemini API
 * (the same API key as image generation, Admin → Integrations). Shapes follow ai.google.dev/gemini-api/docs/video
 * (checked 2026-11-12):
 *
 *   POST {base}/models/{model}:predictLongRunning   { instances: [{ prompt }], parameters: { aspectRatio, … } }
 *     → { name: "models/…/operations/…" }
 *   GET  {base}/{name}
 *     → { done, error?, response: { generateVideoResponse: { generatedSamples: [{ video: { uri } }] } } }
 *   GET  {uri} with x-goog-api-key → the MP4
 *
 * A clip takes minutes, longer than a request should stay open through the gateway, and the site runs several
 * replicas. So nothing waits in memory: start stores the operation name in image_generation (kind "video"), the
 * dialog polls /status, and whichever replica answers the poll that finds the operation done downloads the clip
 * into the private tmp prefix (claimed with a status change, so only one replica does). From there it is the
 * same lifecycle as images: preview → accept (media library) or discard; unaccepted results expire.
 *
 * The model is configuration (GEMINI_VIDEO_MODEL); there is no built-in model name. The key never leaves the server.
 * **Requires manual configuration**: without GEMINI_VIDEO_MODEL the editor shows the option disabled.
 */
export const VIDEO_ASPECT_RATIOS = ["16:9", "9:16"] as const;
export type VideoAspectRatio = (typeof VIDEO_ASPECT_RATIOS)[number];
const DEFAULT_BASE = "https://generativelanguage.googleapis.com/v1beta";
const PROMPT_MIN = 10;
const PROMPT_MAX = 2_000;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const OPERATION = /^[A-Za-z0-9._\-/]{1,300}$/;

export type VideoConfig = {
  apiKey: string;
  model: string;
  /** e.g. https://generativelanguage.googleapis.com/v1beta (no trailing slash). */
  base: string;
  /** Sent only when set: not every model accepts every value. */
  resolution?: string;
  durationSeconds?: number;
  /** A generation still running after this long is closed as timed out. */
  timeoutMs: number;
  /** Each provider request (start, poll, download). */
  requestTimeoutMs: number;
};
export type VideoLimits = { perUserHourly: number; dailyTotal: number };

const int = (v: string | undefined, d: number, min: number, max: number) => Math.min(Math.max(Math.floor(Number(v) || d), min), max);

/** null when no video model is configured. `apiKey` is the Gemini key already resolved for images. */
export function videoConfig(apiKey: string | undefined, env: Record<string, string | undefined> = process.env): VideoConfig | null {
  const model = env.GEMINI_VIDEO_MODEL?.trim();
  if (!apiKey || !model) return null;
  const resolution = env.GEMINI_VIDEO_RESOLUTION?.trim();
  const seconds = Number(env.GEMINI_VIDEO_SECONDS);
  return {
    apiKey,
    model,
    base: (env.GEMINI_VIDEO_ENDPOINT?.trim() || DEFAULT_BASE).replace(/\/+$/, ""),
    ...(resolution && /^[0-9a-zA-Z]{2,8}$/.test(resolution) ? { resolution } : {}),
    ...(Number.isInteger(seconds) && seconds >= 1 && seconds <= 60 ? { durationSeconds: seconds } : {}),
    timeoutMs: int(env.GEMINI_VIDEO_TIMEOUT_MS, 600_000, 60_000, 1_800_000),
    requestTimeoutMs: 60_000,
  };
}

export function videoLimits(env: Record<string, string | undefined> = process.env): VideoLimits {
  return { perUserHourly: int(env.GEMINI_VIDEO_USER_HOURLY_LIMIT, 3, 0, 100), dailyTotal: int(env.GEMINI_VIDEO_DAILY_LIMIT, 10, 0, 1_000) };
}

async function effective(): Promise<Record<string, string | undefined>> {
  return (await import("./runtime-settings")).effectiveEnv();
}

export async function resolveVideoConfig(): Promise<VideoConfig | null> {
  const image = await resolveGeminiImageConfig();
  return videoConfig(image?.apiKey, await effective());
}

export type VideoGenerationStatus = {
  enabled: boolean;
  reason?: string;
  aspectRatios: readonly VideoAspectRatio[];
  model?: string;
  /** Where an inserted clip can go: only destinations an admin switched on and configured (lib/video-destinations.ts). */
  destinations?: { id: DestinationId; label: string }[];
};

/** For the editor: whether "Generate video" is on, and why not. Never exposes the key. */
export async function videoGenerationStatus(): Promise<VideoGenerationStatus> {
  const config = await resolveVideoConfig();
  if (!config) return { enabled: false, reason: "Video generation is not configured (Gemini key in Admin → Integrations, video model in Admin → Integrations → Video generation).", aspectRatios: VIDEO_ASPECT_RATIOS };
  // Storage is needed whatever the destination: the clip is previewed from the private tmp prefix first.
  if (!(await storageReady())) return { enabled: false, reason: "Configure media storage (R2) first.", aspectRatios: VIDEO_ASPECT_RATIOS };
  const destinations = offeredDestinations(await effective(), true);
  if (destinations.length === 0) return { enabled: false, reason: "No video destination is switched on (Admin → Storage → Video destinations).", aspectRatios: VIDEO_ASPECT_RATIOS };
  return { enabled: true, aspectRatios: VIDEO_ASPECT_RATIOS, model: config.model, destinations };
}

// --- Provider ------------------------------------------------------------------------------------

export type VideoGenErrorCode = "refused" | "quota" | "timeout" | "unsupported" | "auth" | "model" | "unavailable" | "empty" | "invalid_video";

const MESSAGES: Record<VideoGenErrorCode, string> = {
  refused: "The video service declined this prompt under its content policy. Rephrase the prompt and try again.",
  quota: "The video service's quota or rate limit has been reached. Try again later.",
  timeout: "Video generation took too long and was stopped. Try again, or simplify the prompt.",
  unsupported: "The video service rejected these options for this model. Try the other aspect ratio, or check the video settings.",
  auth: "The Gemini API key was rejected. An admin must check the key in Admin → Integrations.",
  model: "The configured video model is not available. An admin must check the video model in Admin → Integrations → Video generation.",
  unavailable: "The video service is unavailable right now. Try again in a minute.",
  empty: "The model did not return a video. Try rephrasing the prompt.",
  invalid_video: "The video service returned data that is not a valid MP4 video. Try again.",
};

export class VideoGenError extends Error {
  constructor(
    readonly code: VideoGenErrorCode,
    readonly status: number,
    /** Short provider detail for logs (never the prompt). */
    readonly detail?: string,
  ) {
    super(MESSAGES[code]);
  }
}

const POLICY = /safety|blocked|prohibited|policy|responsible ai|harm|filtered/i;

function fromHttp(status: number, body: string): VideoGenError {
  let message = "";
  try {
    message = String((JSON.parse(body) as { error?: { message?: string } }).error?.message ?? "");
  } catch {
    message = body.slice(0, 200);
  }
  const detail = `${status} ${message}`.slice(0, 300);
  if (status === 429) return new VideoGenError("quota", 429, detail);
  if (status === 401 || status === 403) return new VideoGenError(POLICY.test(message) ? "refused" : "auth", status === 401 ? 502 : 422, detail);
  if (status === 404) return new VideoGenError("model", 502, detail);
  if (status === 408 || status === 504) return new VideoGenError("timeout", 504, detail);
  if (status === 400 || status === 422) return new VideoGenError(POLICY.test(message) ? "refused" : "unsupported", 422, detail);
  return new VideoGenError("unavailable", 503, detail);
}

async function call(config: VideoConfig, url: string, init: RequestInit, fetchImpl: typeof fetch): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), "x-goog-api-key": config.apiKey }, signal: AbortSignal.timeout(config.requestTimeoutMs) });
  } catch (e) {
    if ((e as Error).name === "TimeoutError") throw new VideoGenError("timeout", 504);
    throw new VideoGenError("unavailable", 503, (e as Error).message);
  }
}

/** Start a generation; returns the operation name to poll. */
export async function startVideoOperation(config: VideoConfig, input: { prompt: string; aspectRatio: VideoAspectRatio }, fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await call(
    config,
    `${config.base}/models/${encodeURIComponent(config.model)}:predictLongRunning`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instances: [{ prompt: input.prompt }],
        parameters: { aspectRatio: input.aspectRatio, ...(config.resolution ? { resolution: config.resolution } : {}), ...(config.durationSeconds ? { durationSeconds: config.durationSeconds } : {}) },
      }),
    },
    fetchImpl,
  );
  const text = await res.text().catch(() => "");
  if (!res.ok) throw fromHttp(res.status, text);
  let name: unknown;
  try {
    name = (JSON.parse(text) as { name?: unknown }).name;
  } catch {
    name = undefined;
  }
  if (typeof name !== "string" || !OPERATION.test(name)) throw new VideoGenError("unavailable", 503, "no operation name in the response");
  return name;
}

type Operation = {
  done?: boolean;
  error?: { code?: number; message?: string };
  response?: { generateVideoResponse?: { generatedSamples?: { video?: { uri?: string } }[]; raiMediaFilteredCount?: number; raiMediaFilteredReasons?: string[] } };
};

/** One poll: `{ done: false }` while the provider is still working, otherwise the clip's download URI. */
export async function checkVideoOperation(config: VideoConfig, operation: string, fetchImpl: typeof fetch = fetch): Promise<{ done: false } | { done: true; uri: string }> {
  if (!OPERATION.test(operation)) throw new VideoGenError("unavailable", 503, "bad operation name");
  const res = await call(config, `${config.base}/${operation}`, { method: "GET" }, fetchImpl);
  const text = await res.text().catch(() => "");
  if (!res.ok) throw fromHttp(res.status, text);
  let op: Operation;
  try {
    op = JSON.parse(text) as Operation;
  } catch {
    throw new VideoGenError("unavailable", 503, "operation response was not JSON");
  }
  if (!op.done) return { done: false };
  if (op.error) {
    const message = String(op.error.message ?? "");
    throw new VideoGenError(POLICY.test(message) ? "refused" : "unavailable", POLICY.test(message) ? 422 : 503, `${op.error.code ?? ""} ${message}`.trim().slice(0, 300));
  }
  const out = op.response?.generateVideoResponse;
  const uri = out?.generatedSamples?.[0]?.video?.uri;
  if (!uri) {
    if ((out?.raiMediaFilteredCount ?? 0) > 0) throw new VideoGenError("refused", 422, (out?.raiMediaFilteredReasons ?? []).join("; ").slice(0, 300));
    throw new VideoGenError("empty", 502);
  }
  return { done: true, uri };
}

/** Download a finished clip. The key is only ever sent to the configured API host or another googleapis.com host. */
export async function downloadVideo(config: VideoConfig, uri: string, fetchImpl: typeof fetch = fetch): Promise<Buffer> {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new VideoGenError("invalid_video", 502, "download URI is not a URL");
  }
  const apiHost = new URL(config.base).hostname;
  if (url.protocol !== "https:" || (url.hostname !== apiHost && !url.hostname.endsWith(".googleapis.com"))) throw new VideoGenError("invalid_video", 502, `unexpected download host ${url.hostname}`);
  const res = await call(config, url.toString(), { method: "GET" }, fetchImpl);
  if (!res.ok) throw fromHttp(res.status, await res.text().catch(() => ""));
  if (Number(res.headers.get("content-length") ?? 0) > MAX_VIDEO_BYTES) throw new VideoGenError("invalid_video", 502, "video larger than the limit");
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_VIDEO_BYTES) throw new VideoGenError("invalid_video", 502, `video of ${bytes.length} bytes`);
  return bytes;
}

// --- Workflow ------------------------------------------------------------------------------------

const staff = (a: Actor) => a.role === "admin" || a.role === "author";

async function count(where: ReturnType<typeof sql>): Promise<number> {
  const db = await getDb();
  const [r] = rowsOf<{ n: number }>(await db.execute(sql`select count(*)::int as n from image_generation where kind = 'video' and ${where}`));
  return Number(r?.n ?? 0);
}

type Opts = { config?: VideoConfig | null; fetchImpl?: typeof fetch; limits?: VideoLimits; now?: number };

export async function startVideoGeneration(actor: Actor, input: { prompt?: unknown; aspectRatio?: unknown }, opts: Opts = {}): Promise<{ id: string }> {
  if (!staff(actor)) throw new PostError("Not allowed.", 403);
  const config = opts.config === undefined ? await resolveVideoConfig() : opts.config;
  if (!config) throw new PostError("Video generation is not configured.", 503);
  if (!(await storageReady())) throw new PostError("Media storage (Cloudflare R2) is not configured.", 409);
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (prompt.length < PROMPT_MIN || prompt.length > PROMPT_MAX) throw new PostError(`The prompt must be ${PROMPT_MIN}–${PROMPT_MAX} characters.`, 400);
  const aspectRatio = VIDEO_ASPECT_RATIOS.find((r) => r === input.aspectRatio);
  if (!aspectRatio) throw new PostError(`Choose an aspect ratio: ${VIDEO_ASPECT_RATIOS.join(", ")}.`, 400);

  const now = opts.now ?? Date.now();
  // Unaccepted results (images and videos) past their hour are deleted here too, as before every image generation.
  await (await import("./image-generation")).expireGenerations(now).catch((e) => log.warn("expiring generations failed", { err: e }));
  const limits = opts.limits ?? videoLimits(await effective());
  const hourAgo = new Date(now - 3_600_000).toISOString();
  const dayAgo = new Date(now - 86_400_000).toISOString();
  const runningSince = new Date(now - config.timeoutMs).toISOString();
  if ((await count(sql`user_id = ${actor.id} and created_at > ${hourAgo} and status <> 'rejected'`)) >= limits.perUserHourly)
    throw new PostError(`You have reached the limit of ${limits.perUserHourly} generated videos per hour. Try again later.`, 429);
  if ((await count(sql`created_at > ${dayAgo} and status <> 'rejected'`)) >= limits.dailyTotal)
    throw new PostError(`The site's daily limit of ${limits.dailyTotal} generated videos has been reached. Try again tomorrow.`, 429);
  if ((await count(sql`user_id = ${actor.id} and status in ('running', 'finalizing') and created_at > ${runningSince}`)) >= 1)
    throw new PostError("A video is already being generated. Wait for it to finish or cancel it.", 409);

  const db = await getDb();
  const id = crypto.randomUUID();
  await db.insert(schema.imageGeneration).values({
    id,
    kind: "video",
    userId: actor.id,
    model: config.model,
    aspectRatio,
    imageSize: config.resolution ?? "default",
    durationSeconds: config.durationSeconds ?? null,
    promptSha256: createHash("sha256").update(prompt).digest("hex"),
    promptChars: prompt.length,
    status: "running",
    createdAt: new Date(now),
  });
  try {
    const operation = await startVideoOperation(config, { prompt, aspectRatio }, opts.fetchImpl);
    await db.update(schema.imageGeneration).set({ operation }).where(eq(schema.imageGeneration.id, id));
  } catch (e) {
    const err = e instanceof VideoGenError ? e : new VideoGenError("unavailable", 503, (e as Error).message);
    await db.update(schema.imageGeneration).set({ status: "failed", errorCode: err.code, completedAt: new Date() }).where(eq(schema.imageGeneration.id, id));
    log.warn("video generation failed to start", { generationId: id, model: config.model, code: err.code, detail: err.detail });
    throw new PostError(err.message, err.status);
  }
  log.info("video generation started", { generationId: id, model: config.model, aspectRatio });
  return { id };
}

async function ownVideo(actor: Actor, id: string) {
  if (!staff(actor)) throw new PostError("Not allowed.", 403);
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new PostError("Generated video not found.", 404);
  const db = await getDb();
  const [row] = await db.select().from(schema.imageGeneration).where(and(eq(schema.imageGeneration.id, id), eq(schema.imageGeneration.kind, "video")));
  if (!row || (row.userId !== actor.id && actor.role !== "admin")) throw new PostError("Generated video not found.", 404);
  return row;
}

export type VideoProgress =
  | { status: "running" }
  | { status: "succeeded"; previewUrl: string; model: string; sizeBytes: number }
  | { status: "failed"; error: string };

const previewUrl = (id: string) => `/api/admin/videos/generations/${id}`;

/**
 * Called by the dialog every few seconds. While the provider works this is one cheap request; the poll that finds
 * the operation done fetches the clip, checks that it really is an MP4 and stores it in the private tmp prefix.
 */
export async function videoGenerationProgress(actor: Actor, id: string, opts: Opts = {}): Promise<VideoProgress> {
  const row = await ownVideo(actor, id);
  if (row.status === "succeeded" && row.tempKey) return { status: "succeeded", previewUrl: previewUrl(id), model: row.model, sizeBytes: row.sizeBytes ?? 0 };
  if (row.status === "finalizing") return { status: "running" };
  if (row.status !== "running") {
    const code = (row.errorCode ?? "unavailable") as VideoGenErrorCode;
    return { status: "failed", error: row.status === "cancelled" ? "Generation cancelled." : row.status === "expired" || row.status === "discarded" ? "This generated video has expired. Generate a new one." : (MESSAGES[code] ?? MESSAGES.unavailable) };
  }
  const config = opts.config === undefined ? await resolveVideoConfig() : opts.config;
  const db = await getDb();
  const started = row.createdAt.getTime();
  const now = opts.now ?? Date.now();
  const fail = async (err: VideoGenError, from: string): Promise<VideoProgress> => {
    await db
      .update(schema.imageGeneration)
      .set({ status: "failed", errorCode: err.code, latencyMs: Date.now() - started, completedAt: new Date() })
      .where(and(eq(schema.imageGeneration.id, id), eq(schema.imageGeneration.status, from)));
    log.warn("video generation failed", { generationId: id, model: row.model, code: err.code, detail: err.detail });
    return { status: "failed", error: err.message };
  };
  if (!config || !row.operation) return fail(new VideoGenError("unavailable", 503, "no configuration or operation"), "running");
  if (now - started > config.timeoutMs) return fail(new VideoGenError("timeout", 504), "running");

  let uri: string;
  try {
    const state = await checkVideoOperation(config, row.operation, opts.fetchImpl);
    if (!state.done) return { status: "running" };
    uri = state.uri;
  } catch (e) {
    const err = e instanceof VideoGenError ? e : new VideoGenError("unavailable", 503, (e as Error).message);
    // A poll that could not reach the provider is not the generation failing: the next poll tries again.
    if (err.code === "unavailable" || err.code === "timeout" || err.code === "quota") return { status: "running" };
    return fail(err, "running");
  }

  // Only one replica downloads and stores the clip.
  const [claimed] = await db
    .update(schema.imageGeneration)
    .set({ status: "finalizing" })
    .where(and(eq(schema.imageGeneration.id, id), eq(schema.imageGeneration.status, "running")))
    .returning({ id: schema.imageGeneration.id });
  if (!claimed) return { status: "running" };
  try {
    const bytes = await downloadVideo(config, uri, opts.fetchImpl);
    // Never store what we have not verified.
    if (sniffContentType(bytes.subarray(0, 32)) !== "video/mp4") throw new VideoGenError("invalid_video", 502, "not an MP4");
    const tempKey = tempObjectKey(id, "mp4");
    await putObject(tempKey, bytes, { contentType: "video/mp4", cacheControl: "private, no-store", contentMd5: createHash("md5").update(bytes).digest("base64") });
    const latencyMs = Date.now() - started;
    await db
      .update(schema.imageGeneration)
      .set({ status: "succeeded", tempKey, contentType: "video/mp4", sizeBytes: bytes.length, checksumSha256: createHash("sha256").update(bytes).digest("hex"), latencyMs, completedAt: new Date() })
      .where(eq(schema.imageGeneration.id, id));
    log.info("video generated", { generationId: id, model: row.model, aspectRatio: row.aspectRatio, latencyMs, bytes: bytes.length });
    return { status: "succeeded", previewUrl: previewUrl(id), model: row.model, sizeBytes: bytes.length };
  } catch (e) {
    return fail(e instanceof VideoGenError ? e : new VideoGenError("unavailable", 503, (e as Error).message), "finalizing");
  }
}

/** Bytes of an unaccepted clip, for the preview in the dialog (Range requests are passed to storage). */
export async function videoGenerationPreview(actor: Actor, id: string, range?: string) {
  const row = await ownVideo(actor, id);
  if (row.status !== "succeeded" || !row.tempKey) throw new PostError("This generated video has expired. Generate a new one.", 410);
  const obj = await getObject(row.tempKey, range);
  if (!obj?.Body) throw new PostError("This generated video has expired. Generate a new one.", 410);
  return { body: obj.Body.transformToWebStream(), contentType: "video/mp4", contentRange: (obj as { ContentRange?: string }).ContentRange, contentLength: (obj as { ContentLength?: number }).ContentLength };
}

/** `embed` false: `src` is a /media/… file for ::video. `embed` true: `src` is an external player for ::embed. */
export type AcceptedVideo = { id: string; src: string; aspectRatio: string; destination: DestinationId; embed: boolean };

type AcceptInput = { description: unknown; context?: unknown; name?: unknown; destination?: unknown; loop?: unknown };
type AcceptOpts = { env?: Record<string, string | undefined>; fetchImpl?: typeof fetch };

/**
 * The author accepted the clip. Destination r2 (the default): it is copied into the media library. Any other
 * destination: it is sent to that streaming service and its player address comes back. Either way the caller only
 * inserts it in the editor; the post changes on save.
 */
export async function acceptVideoGeneration(actor: Actor, id: string, input: AcceptInput, opts: AcceptOpts = {}): Promise<AcceptedVideo> {
  const row = await ownVideo(actor, id);
  const description = typeof input.description === "string" ? input.description.trim() : "";
  if (!description || description.length > 300) throw new PostError("Describe what the video shows (up to 300 characters).", 400);
  const env = opts.env ?? (await effective());
  const offered = offeredDestinations(env, await storageReady());
  const destination = input.destination === undefined || input.destination === null || input.destination === "" ? offered[0]?.id : DESTINATIONS.find((d) => d === input.destination);
  if (!destination || !offered.some((d) => d.id === destination)) throw new PostError("That video destination is not switched on. Choose another one.", 400);
  if (destination !== "r2") return publishExternally(actor, row, destination, { description, loop: input.loop === true }, env, opts.fetchImpl);
  const db = await getDb();
  // Claim the row so a double click cannot create two media items.
  const [claimed] = await db
    .update(schema.imageGeneration)
    .set({ status: "accepting" })
    .where(and(eq(schema.imageGeneration.id, id), eq(schema.imageGeneration.status, "succeeded")))
    .returning();
  if (!claimed?.tempKey || !row.sizeBytes || !row.checksumSha256) {
    throw new PostError(row.status === "accepted" ? "This video was already added to the media library." : "This generated video has expired. Generate a new one.", 410);
  }
  const mediaId = crypto.randomUUID();
  const key = mediaObjectKey("videos", mediaId, "mp4");
  try {
    await copyObject(claimed.tempKey, key, { contentType: "video/mp4" });
    const head = await headObject(key);
    if (!head || head.size !== row.sizeBytes) throw new Error("copied object does not match");
    const filename = sanitizeFilename(typeof input.name === "string" && input.name ? input.name : "generated-video", "mp4");
    await db.insert(schema.media).values({
      id: mediaId,
      filename,
      contentType: "video/mp4",
      storageKey: key,
      storageBackend: "r2",
      kind: "videos",
      checksumSha256: row.checksumSha256,
      context: normaliseContext(typeof input.context === "string" ? input.context : "generated"),
      sizeBytes: row.sizeBytes,
      alt: description,
      title: description.slice(0, 200),
      description: `AI-generated video (${row.model}).`,
      uploadedBy: actor.id,
    });
    await db.update(schema.imageGeneration).set({ status: "accepted", mediaId, tempKey: null, destination: "r2" }).where(eq(schema.imageGeneration.id, id));
    await deleteObject(claimed.tempKey).catch(() => undefined);
    await audit(actor, "media.generate.accept", mediaId, { generationId: id, model: row.model, kind: "video", destination: "r2" });
    return { id: mediaId, src: mediaSrc({ id: mediaId, filename }), aspectRatio: row.aspectRatio, destination: "r2", embed: false };
  } catch (e) {
    await db.update(schema.imageGeneration).set({ status: "succeeded" }).where(eq(schema.imageGeneration.id, id));
    log.error("accepting generated video failed", { generationId: id, err: e });
    throw new PostError("The video could not be saved to the media library. Try again.", 502);
  }
}

type VideoRow = Awaited<ReturnType<typeof ownVideo>>;

/** Send an accepted clip to Cloudflare Stream, Mux or Bunny Stream; nothing is added to the media library. */
async function publishExternally(
  actor: Actor,
  row: VideoRow,
  destination: Exclude<DestinationId, "r2">,
  input: { description: string; loop: boolean },
  env: Record<string, string | undefined>,
  fetchImpl?: typeof fetch,
): Promise<AcceptedVideo> {
  const db = await getDb();
  const id = row.id;
  // Claim the row so a double click cannot upload the clip twice.
  const [claimed] = await db
    .update(schema.imageGeneration)
    .set({ status: "accepting" })
    .where(and(eq(schema.imageGeneration.id, id), eq(schema.imageGeneration.status, "succeeded")))
    .returning();
  if (!claimed?.tempKey) throw new PostError(row.status === "accepted" ? "This video was already inserted." : "This generated video has expired. Generate a new one.", 410);
  const tempKey = claimed.tempKey;
  try {
    const stored = await getObject(tempKey);
    const bytes = stored?.Body ? Buffer.from(await stored.Body.transformToByteArray()) : null;
    if (!bytes || bytes.length > MAX_VIDEO_BYTES) throw new DestinationError("The generated video is no longer stored. Generate a new one.");
    const published = await publishVideo(destination, { bytes, title: input.description, signedUrl: () => presignGet(tempKey, "generated-video.mp4", 3_600) }, env, fetchImpl);
    // Mux downloads the clip itself over the next minutes, so its private copy stays (the tmp lifecycle rule removes it
    // within a day); the other services already have the bytes.
    const keepTemp = destination === "mux";
    await db.update(schema.imageGeneration).set({ status: "accepted", destination, externalId: published.externalId, tempKey: keepTemp ? tempKey : null }).where(eq(schema.imageGeneration.id, id));
    if (!keepTemp) await deleteObject(tempKey).catch(() => undefined);
    await audit(actor, "media.generate.accept", id, { generationId: id, model: row.model, kind: "video", destination, externalId: published.externalId });
    log.info("generated video published", { generationId: id, destination, externalId: published.externalId });
    return { id: published.externalId, src: withPlayback(published.embedSrc, input.loop), aspectRatio: row.aspectRatio, destination, embed: true };
  } catch (e) {
    await db.update(schema.imageGeneration).set({ status: "succeeded" }).where(eq(schema.imageGeneration.id, id));
    const err = e instanceof DestinationError ? e : new DestinationError("The video could not be sent to the destination. Try again.", (e as Error).message);
    log.warn("publishing generated video failed", { generationId: id, destination, detail: err.detail ?? err.message });
    throw new PostError(err.message, 502);
  }
}

/** Discard an unaccepted clip, or stop waiting for one that is still being generated. */
export async function discardVideoGeneration(actor: Actor, id: string): Promise<void> {
  const row = await ownVideo(actor, id);
  const db = await getDb();
  if (row.status === "running") {
    // The provider's operation cannot be cancelled; its result is simply never fetched.
    await db.update(schema.imageGeneration).set({ status: "cancelled", errorCode: "cancelled", completedAt: new Date() }).where(and(eq(schema.imageGeneration.id, id), eq(schema.imageGeneration.status, "running")));
    return;
  }
  if (row.status !== "succeeded") return;
  if (row.tempKey) await deleteObject(row.tempKey).catch(() => undefined);
  await db.update(schema.imageGeneration).set({ status: "discarded", tempKey: null }).where(and(eq(schema.imageGeneration.id, id), eq(schema.imageGeneration.status, "succeeded")));
}
