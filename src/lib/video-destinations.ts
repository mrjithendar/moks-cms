/**
 * Where a generated video goes when the author inserts it. Four destinations, each switched on or off by an admin in
 * Admin → Storage → Video destinations; the editor only offers the ones that are on **and** fully
 * configured:
 *
 * - r2: this site's media library (Cloudflare R2), played by the native <video> player. On unless switched off.
 * - cloudflare-stream, mux, bunny-stream: the clip is sent to that service, which encodes it for adaptive
 *   streaming, and the article embeds the service's player in an iframe (`::embed`). Nothing is added to the media
 *   library: the video lives in that service's account and is managed (or deleted) there.
 *
 * API shapes as documented on 2026-11-12 (developers.cloudflare.com/stream, mux.com/docs, docs.bunny.net):
 *   Cloudflare Stream  POST api.cloudflare.com/client/v4/accounts/{account}/stream (multipart "file", Bearer token)
 *                      → result.uid; player https://customer-{code}.cloudflarestream.com/{uid}/iframe
 *   Mux                POST api.mux.com/video/v1/assets { inputs: [{ url }], playback_policies: ["public"] } (Basic auth)
 *                      → data.id, data.playback_ids[0].id; player https://player.mux.com/{playbackId}
 *                      (Mux fetches the clip itself, so it gets a one-hour signed link to the private copy)
 *   Bunny Stream       POST video.bunnycdn.com/library/{library}/videos { title } (AccessKey) → guid, then
 *                      PUT …/videos/{guid} with the bytes; player https://iframe.mediadelivery.net/embed/{library}/{guid}
 *
 * **Requires manual configuration** and has not been exercised against the real services: tests use canned responses.
 * Secrets stay on the server; nothing here is imported by client code.
 */
export const DESTINATIONS = ["r2", "cloudflare-stream", "mux", "bunny-stream"] as const;
export type DestinationId = (typeof DESTINATIONS)[number];
export type ExternalDestinationId = Exclude<DestinationId, "r2">;

export const DESTINATION_LABELS: Record<DestinationId, string> = {
  r2: "This site (R2 media library)",
  "cloudflare-stream": "Cloudflare Stream",
  mux: "Mux",
  "bunny-stream": "Bunny Stream",
};

type Env = Record<string, string | undefined>;
export type DestinationState = { id: DestinationId; label: string; enabled: boolean; ready: boolean; missing: string[] };

const on = (v: string | undefined, fallback: boolean) => (v === undefined || v.trim() === "" ? fallback : v.trim() === "true");
const missing = (env: Env, names: string[]) => names.filter((n) => !env[n]?.trim());

/** Every destination with its switch and whether its credentials are complete. `r2Ready`: media storage is configured. */
export function destinationStates(env: Env, r2Ready: boolean): DestinationState[] {
  const state = (id: DestinationId, enabled: boolean, lacks: string[]): DestinationState => ({ id, label: DESTINATION_LABELS[id], enabled, ready: enabled && lacks.length === 0, missing: lacks });
  return [
    state("r2", !on(env.VIDEO_DEST_R2_DISABLED, false), r2Ready ? [] : ["media storage (R2)"]),
    state("cloudflare-stream", on(env.CF_STREAM_ENABLED, false), missing(env, ["CF_STREAM_ACCOUNT_ID", "CF_STREAM_API_TOKEN", "CF_STREAM_CUSTOMER_CODE"])),
    state("mux", on(env.MUX_ENABLED, false), missing(env, ["MUX_TOKEN_ID", "MUX_TOKEN_SECRET"])),
    state("bunny-stream", on(env.BUNNY_STREAM_ENABLED, false), missing(env, ["BUNNY_STREAM_LIBRARY_ID", "BUNNY_STREAM_API_KEY"])),
  ];
}

/** What the editor offers: switched on and fully configured, in a fixed order. */
export function offeredDestinations(env: Env, r2Ready: boolean): { id: DestinationId; label: string }[] {
  return destinationStates(env, r2Ready)
    .filter((d) => d.ready)
    .map(({ id, label }) => ({ id, label }));
}

export class DestinationError extends Error {
  constructor(
    message: string,
    /** Short provider detail for logs (never a secret). */
    readonly detail?: string,
  ) {
    super(message);
  }
}

export type PublishInput = {
  bytes: Buffer;
  /** Shown in the provider's dashboard. */
  title: string;
  /** A link the provider can download the clip from (only asked for by providers that pull). */
  signedUrl: () => Promise<string>;
};
export type Published = { externalId: string; embedSrc: string };

const TIMEOUT_MS = 120_000;

async function send(what: string, url: string, init: RequestInit, fetchImpl: typeof fetch): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new DestinationError(`${what} could not be reached. Try again in a minute.`, (e as Error).message);
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    const detail = `${res.status} ${text.slice(0, 200)}`;
    if (res.status === 401 || res.status === 403) throw new DestinationError(`${what} rejected the credentials. An admin must check them in Admin → Storage → Video destinations.`, detail);
    if (res.status === 429) throw new DestinationError(`${what} is rate-limiting uploads. Try again later.`, detail);
    throw new DestinationError(`${what} did not accept the video (HTTP ${res.status}).`, detail);
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new DestinationError(`${what} sent a reply that could not be read.`, text.slice(0, 200));
  }
}

const ID = { cloudflare: /^[a-f0-9]{32}$/, mux: /^[A-Za-z0-9]{10,80}$/, bunny: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/ };

/** Send the clip to an external destination. The embed address returned is the plain player URL (no playback options). */
export async function publishVideo(id: ExternalDestinationId, input: PublishInput, env: Env, fetchImpl: typeof fetch = fetch): Promise<Published> {
  const get = (name: string) => env[name]?.trim() ?? "";
  if (id === "cloudflare-stream") {
    const what = DESTINATION_LABELS[id];
    const code = get("CF_STREAM_CUSTOMER_CODE").replace(/^customer-/, "").replace(/\.cloudflarestream\.com$/, "");
    if (!/^[a-z0-9]{6,40}$/.test(code)) throw new DestinationError("The Cloudflare Stream customer code is not valid. An admin must check it in Admin → Storage → Video destinations.");
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(input.bytes)], { type: "video/mp4" }), "video.mp4");
    const body = (await send(what, `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(get("CF_STREAM_ACCOUNT_ID"))}/stream`, { method: "POST", headers: { Authorization: `Bearer ${get("CF_STREAM_API_TOKEN")}` }, body: form }, fetchImpl)) as { result?: { uid?: unknown } };
    const uid = body.result?.uid;
    if (typeof uid !== "string" || !ID.cloudflare.test(uid)) throw new DestinationError(`${what} did not return a video id.`);
    // The name is set separately: the upload itself is a bare file. Failing to name it is not worth failing the insert.
    await send(what, `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(get("CF_STREAM_ACCOUNT_ID"))}/stream/${uid}`, { method: "POST", headers: { Authorization: `Bearer ${get("CF_STREAM_API_TOKEN")}`, "Content-Type": "application/json" }, body: JSON.stringify({ meta: { name: input.title } }) }, fetchImpl).catch(() => undefined);
    return { externalId: uid, embedSrc: `https://customer-${code}.cloudflarestream.com/${uid}/iframe` };
  }
  if (id === "mux") {
    const what = DESTINATION_LABELS[id];
    const auth = Buffer.from(`${get("MUX_TOKEN_ID")}:${get("MUX_TOKEN_SECRET")}`).toString("base64");
    const body = (await send(
      what,
      "https://api.mux.com/video/v1/assets",
      { method: "POST", headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" }, body: JSON.stringify({ inputs: [{ url: await input.signedUrl() }], playback_policies: ["public"], video_quality: "basic", passthrough: input.title.slice(0, 255) }) },
      fetchImpl,
    )) as { data?: { id?: unknown; playback_ids?: { id?: unknown; policy?: unknown }[] } };
    const asset = body.data?.id;
    const playback = body.data?.playback_ids?.find((p) => p.policy === "public")?.id ?? body.data?.playback_ids?.[0]?.id;
    if (typeof asset !== "string" || typeof playback !== "string" || !ID.mux.test(playback)) throw new DestinationError(`${what} did not return a playback id.`);
    return { externalId: asset, embedSrc: `https://player.mux.com/${playback}` };
  }
  const what = DESTINATION_LABELS[id];
  const library = get("BUNNY_STREAM_LIBRARY_ID");
  if (!/^\d{1,10}$/.test(library)) throw new DestinationError("The Bunny Stream library id is not valid. An admin must check it in Admin → Storage → Video destinations.");
  const headers = { AccessKey: get("BUNNY_STREAM_API_KEY"), Accept: "application/json" };
  const created = (await send(what, `https://video.bunnycdn.com/library/${library}/videos`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ title: input.title }) }, fetchImpl)) as { guid?: unknown };
  const guid = created.guid;
  if (typeof guid !== "string" || !ID.bunny.test(guid)) throw new DestinationError(`${what} did not return a video id.`);
  await send(what, `https://video.bunnycdn.com/library/${library}/videos/${guid}`, { method: "PUT", headers: { ...headers, "Content-Type": "application/octet-stream" }, body: new Uint8Array(input.bytes) }, fetchImpl);
  return { externalId: guid, embedSrc: `https://iframe.mediadelivery.net/embed/${library}/${guid}` };
}

export type StoredVideoInput = {
  title: string;
  /** A link the service can download the file from. */
  signedUrl: () => Promise<string>;
  /** The file as a stream, for a service that has to be sent the bytes (never buffered in memory: uploads can be 200 MB). */
  open: () => Promise<ReadableStream<Uint8Array>>;
};

/**
 * Send a video that is already in storage (an upload in the media library) to an external destination, without
 * loading it into memory: Cloudflare Stream and Mux download it from a signed link
 * (Cloudflare: POST …/stream/copy { url }), Bunny Stream is streamed the bytes.
 */
export async function publishStoredVideo(id: ExternalDestinationId, input: StoredVideoInput, env: Env, fetchImpl: typeof fetch = fetch): Promise<Published> {
  const get = (name: string) => env[name]?.trim() ?? "";
  if (id === "mux") return publishVideo("mux", { bytes: Buffer.alloc(0), title: input.title, signedUrl: input.signedUrl }, env, fetchImpl);
  if (id === "cloudflare-stream") {
    const what = DESTINATION_LABELS[id];
    const code = get("CF_STREAM_CUSTOMER_CODE").replace(/^customer-/, "").replace(/\.cloudflarestream\.com$/, "");
    if (!/^[a-z0-9]{6,40}$/.test(code)) throw new DestinationError("The Cloudflare Stream customer code is not valid. An admin must check it in Admin → Storage → Video destinations.");
    const body = (await send(
      what,
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(get("CF_STREAM_ACCOUNT_ID"))}/stream/copy`,
      { method: "POST", headers: { Authorization: `Bearer ${get("CF_STREAM_API_TOKEN")}`, "Content-Type": "application/json" }, body: JSON.stringify({ url: await input.signedUrl(), meta: { name: input.title } }) },
      fetchImpl,
    )) as { result?: { uid?: unknown } };
    const uid = body.result?.uid;
    if (typeof uid !== "string" || !ID.cloudflare.test(uid)) throw new DestinationError(`${what} did not return a video id.`);
    return { externalId: uid, embedSrc: `https://customer-${code}.cloudflarestream.com/${uid}/iframe` };
  }
  const what = DESTINATION_LABELS[id];
  const library = get("BUNNY_STREAM_LIBRARY_ID");
  if (!/^\d{1,10}$/.test(library)) throw new DestinationError("The Bunny Stream library id is not valid. An admin must check it in Admin → Storage → Video destinations.");
  const headers = { AccessKey: get("BUNNY_STREAM_API_KEY"), Accept: "application/json" };
  const created = (await send(what, `https://video.bunnycdn.com/library/${library}/videos`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ title: input.title }) }, fetchImpl)) as { guid?: unknown };
  const guid = created.guid;
  if (typeof guid !== "string" || !ID.bunny.test(guid)) throw new DestinationError(`${what} did not return a video id.`);
  // A streamed request body needs duplex: "half" (not yet in TypeScript's RequestInit).
  const upload = { method: "PUT", headers: { ...headers, "Content-Type": "application/octet-stream" }, body: await input.open(), duplex: "half" } as RequestInit;
  await send(what, `https://video.bunnycdn.com/library/${library}/videos/${guid}`, upload, fetchImpl);
  return { externalId: guid, embedSrc: `https://iframe.mediadelivery.net/embed/${library}/${guid}` };
}

/** Player address for the article: a silent loop starts by itself, muted, and repeats (each player's own options). */
export function withPlayback(embedSrc: string, loop: boolean): string {
  if (!loop) return embedSrc;
  const host = new URL(embedSrc).hostname;
  return `${embedSrc}?${host === "player.mux.com" ? "autoplay=muted&loop=true&muted=true" : "autoplay=true&loop=true&muted=true"}`;
}
