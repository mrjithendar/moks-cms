import { authenticateApiKey, type ApiAuth, type Scope } from "@/lib/api-keys";
import { toIsoOffset } from "@/lib/dates-iso";
import { reportError, routeFields } from "@/lib/http-errors";
import { PostError, type PostRow } from "@/lib/posts";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * JSON responses and errors for /api/v1. `scope` is the scope a key needs, or a list of which one is enough.
 * 401 = no usable key, 403 = the key may not do this, 429 = slow down. Unknown errors are logged and never leak details.
 */
export async function api(request: Request, scope: Scope | Scope[], fn: (auth: ApiAuth) => Promise<unknown>, status = 200): Promise<Response> {
  try {
    const auth = await authenticateApiKey(request.headers.get("authorization"));
    const accepted = Array.isArray(scope) ? scope : [scope];
    if (!accepted.some((s) => auth.scopes.includes(s))) throw new PostError(`This key lacks the ${accepted.join(" or ")} scope.`, 403);
    const data = await fn(auth);
    return data === undefined ? new Response(null, { status: 204 }) : Response.json({ data }, { status, headers: NO_STORE });
  } catch (error) {
    if (error instanceof PostError) {
      const headers: Record<string, string> = { ...NO_STORE };
      if (error.status === 401) headers["WWW-Authenticate"] = "Bearer";
      if (error.status === 429) headers["Retry-After"] = "60";
      return Response.json({ error: { message: error.message, issues: error.issues } }, { status: error.status, headers });
    }
    const ref = reportError("api request failed", error, routeFields(request));
    return Response.json({ error: { message: "Internal error.", code: "internal", reference: ref.reference } }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}

/** Statuses a posts:draft key may create, keep or set. */
export const DRAFT_STATUSES: readonly string[] = ["draft", "review"];

/** True when the key may publish, schedule, archive and trash (posts:write); false for a draft-only key. */
export const canPublish = (auth: ApiAuth): boolean => auth.scopes.includes("posts:write");

/** A draft-only key may leave `status` out (a new post is a draft; an edit keeps the status) or set draft/review. */
export function assertDraftStatus(body: unknown): void {
  const status = body && typeof body === "object" ? (body as { status?: unknown }).status : undefined;
  if (status !== undefined && !(typeof status === "string" && DRAFT_STATUSES.includes(status))) {
    throw new PostError("This key can only save drafts (scope posts:draft). Publish in Admin → Posts, or use a key with posts:write.", 403);
  }
}

export async function json(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new PostError("The request body must be JSON.", 400);
  }
}

/**
 * The request body as bytes, at most `maxBytes`: refused up front when Content-Length says it is larger, and the
 * stream is cancelled as soon as more than that has arrived, so an oversized upload is never held in memory.
 */
export async function bodyBytes(request: Request, maxBytes: number): Promise<Buffer> {
  const tooLarge = () => new PostError(`The file is larger than ${Math.floor(maxBytes / 1024 / 1024)} MB.`, 413);
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared) > maxBytes) throw tooLarge();
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Public representation of a post row (ISO 8601 dates with offset). */
export function serialize(p: PostRow) {
  const iso = (d: Date | null) => (d ? toIsoOffset(d) : null);
  return {
    id: p.id,
    collection: p.collection,
    slug: p.slug,
    url: `/${p.collection}/${p.slug}`,
    title: p.title,
    description: p.description,
    body: p.body,
    category: p.category,
    tags: p.tags,
    contentType: p.contentType,
    status: p.status,
    publishedAt: iso(p.publishedAt),
    updatedAt: iso(p.updatedAt),
    canonicalUrl: p.canonicalUrl,
    featuredImage: p.featuredImage,
    sources: p.sources,
    corrections: p.corrections,
    sponsored: p.sponsored,
    sponsor: p.sponsor,
    related: p.related,
    membersOnly: p.membersOnly,
    previewPercent: p.previewPercent,
    authorId: p.authorId,
    createdAt: iso(p.createdAt),
    savedAt: iso(p.savedAt),
  };
}
