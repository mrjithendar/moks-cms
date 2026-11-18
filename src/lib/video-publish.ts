import "server-only";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { audit } from "./audit";
import { log } from "./log";
import { MEDIA_DETAIL_LIMITS } from "./media";
import type { Actor } from "./posts";
import { PostError } from "./posts";
import { getObject, presignGet, storageReady } from "./storage";
import { DESTINATION_LABELS, DESTINATIONS, DestinationError, offeredDestinations, publishStoredVideo, type DestinationId } from "./video-destinations";

/**
 * Uploaded videos and the video destinations (lib/video-destinations.ts). Every upload lands in this site's media
 * library (R2) first, verified as always. When the author chose Cloudflare Stream, Mux or Bunny Stream for it, the
 * stored file is then sent on to that service and its player address comes back for a `::embed` block. The copy in
 * the media library stays (two of the services download it from there over the next minutes); it can be deleted
 * later like any other file. The player address is also noted in the file's description in Admin → Media.
 */
export async function uploadDestinations(): Promise<{ id: DestinationId; label: string }[]> {
  const env = await (await import("./runtime-settings")).effectiveEnv();
  const external = offeredDestinations(env, await storageReady()).filter((d) => d.id !== "r2");
  // Uploads always go to the media library; the list only matters when there is somewhere else to send them.
  return external.length ? [{ id: "r2", label: "This site only (media library)" }, ...external] : [];
}

export async function publishMediaVideo(
  actor: Actor,
  mediaId: string,
  destination: unknown,
  opts: { env?: Record<string, string | undefined>; fetchImpl?: typeof fetch } = {},
): Promise<{ destination: DestinationId; src: string; externalId: string }> {
  if (actor.role !== "admin" && actor.role !== "author") throw new PostError("Not allowed.", 403);
  if (!/^[0-9a-f-]{36}$/.test(mediaId)) throw new PostError("Video not found.", 404);
  const db = await getDb();
  const [row] = await db.select().from(schema.media).where(eq(schema.media.id, mediaId));
  if (!row || row.status !== "ready" || (row.uploadedBy !== actor.id && actor.role !== "admin")) throw new PostError("Video not found.", 404);
  if (row.kind !== "videos" || row.storageBackend !== "r2") throw new PostError("Only videos in the media library can be sent to a streaming service.", 400);
  const env = opts.env ?? (await (await import("./runtime-settings")).effectiveEnv());
  const id = DESTINATIONS.find((d) => d === destination);
  if (!id || id === "r2" || !offeredDestinations(env, await storageReady()).some((d) => d.id === id)) throw new PostError("That video destination is not switched on. Choose another one.", 400);
  const title = (row.title || row.alt || row.filename).slice(0, 200);
  try {
    const published = await publishStoredVideo(
      id,
      {
        title,
        signedUrl: () => presignGet(row.storageKey, row.filename, 3_600),
        open: async () => {
          const obj = await getObject(row.storageKey);
          if (!obj?.Body) throw new DestinationError("The uploaded video could not be read back from storage.");
          return obj.Body.transformToWebStream() as ReadableStream<Uint8Array>;
        },
      },
      env,
      opts.fetchImpl,
    );
    const note = `Also on ${DESTINATION_LABELS[id]}: ${published.embedSrc}`;
    const description = [row.description, note].filter(Boolean).join("\n").slice(0, MEDIA_DETAIL_LIMITS.description);
    await db.update(schema.media).set({ description }).where(eq(schema.media.id, mediaId));
    await audit(actor, "media.publish", mediaId, { destination: id, externalId: published.externalId });
    log.info("uploaded video published", { mediaId, destination: id, externalId: published.externalId });
    return { destination: id, src: published.embedSrc, externalId: published.externalId };
  } catch (e) {
    if (e instanceof PostError) throw e;
    const err = e instanceof DestinationError ? e : new DestinationError("The video could not be sent to the destination. Try again.", (e as Error).message);
    log.warn("publishing uploaded video failed", { mediaId, destination: id, detail: err.detail ?? err.message });
    throw new PostError(err.message, 502);
  }
}
