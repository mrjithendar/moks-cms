import { and, eq } from "drizzle-orm";
import { collections, type Collection } from "@/config/taxonomy";
import { getDb, schema } from "@/db";
import { articleRow } from "./content/import";
import { splitFrontmatter } from "./content/frontmatter";
import { collectionSchema } from "./content/schema";
import type { Actor, PostRow } from "./posts";
import { createPost, PostError, updatePost } from "./posts";

/**
 * A post from its MDX file (frontmatter + body), sent as it is in the site's repository:
 * PUT /api/v1/posts/by-path/<collection>/<slug>. The server parses and validates the file, so a site's CI needs
 * nothing but an HTTP client: no checkout of the CMS, no Node, no YAML parser.
 *
 * The rules are those of scripts/push-post.ts:
 * - a new slug becomes a **draft**, whatever the file's `status` and `publishedAt` say; the byline is the key's owner;
 * - a post that is still a draft or in review is updated from the file (the earlier version stays in Revisions);
 * - a published, scheduled or archived post is left alone, unless `updateLive` is asked for by a key that may publish:
 *   then its content changes, never its status or publication date;
 * - `createOnly` never changes an existing post.
 * Nothing is ever published from a file.
 */
export type PushAction = "created" | "updated" | "unchanged" | "exists" | "skipped";
export type PushOutcome = { action: PushAction; id: string; status: string; url: string; admin: string; reason?: string; warnings?: string[] };

const EDITABLE = new Set(["draft", "review"]);
/** A file is a few hundred kilobytes at most: the body alone may hold 200,000 characters. */
export const POST_FILE_MAX_BYTES = 1024 * 1024;

export function isCollection(value: string): value is Collection {
  return (collections as readonly string[]).includes(value);
}

/** Everything the editor stores that a file sets: not the status, the publication date or the author. */
export function fieldsFromMdx(collection: Collection, slug: string, source: string) {
  let parts: { data: unknown; body: string };
  try {
    parts = splitFrontmatter(source);
  } catch (error) {
    throw new PostError("The file is not valid.", 400, [`frontmatter: ${(error as Error).message}`]);
  }
  const parsed = collectionSchema(collection).safeParse(parts.data);
  if (!parsed.success) throw new PostError("The file is not valid.", 400, parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`));
  const fm = parsed.data;
  if (fm.slug !== slug) throw new PostError("The file is not valid.", 400, [`slug: the file says "${fm.slug}" but it was sent as "${slug}" (the slug is the file name)`]);
  const row = articleRow({ collection, slug, path: `/${collection}/${slug}`, frontmatter: fm, body: parts.body, file: `${collection}/${slug}.mdx` }, "");
  const { authorId: _a, status: _s, publishedAt: _p, updatedAt: _u, ...fields } = row;
  void [_a, _s, _p, _u];
  return { ...fields, updatedAt: fm.updatedAt ?? null };
}

type Fields = ReturnType<typeof fieldsFromMdx>;

/** JSON with sorted keys: jsonb columns come back with their keys in another order than the file had them. */
function stable(value: unknown): string {
  if (value instanceof Date) return String(value.getTime());
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined && v !== null);
    return `{${entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** True when the post already holds exactly what the file says, so sending it again need not add a revision. */
export function sameAsFile(row: PostRow, fields: Fields): boolean {
  const current = row as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(fields)) {
    if (key === "updatedAt") {
      if ((value ? Date.parse(value as string) : null) !== (row.updatedAt ? row.updatedAt.getTime() : null)) return false;
    } else if (stable(current[key]) !== stable(value)) return false;
  }
  return true;
}

export async function pushPostFile(
  auth: { actor: Actor; canPublish: boolean },
  collection: Collection,
  slug: string,
  source: string,
  opts: { createOnly?: boolean; updateLive?: boolean } = {},
): Promise<PushOutcome> {
  const { actor } = auth;
  if (actor.role !== "admin" && actor.role !== "author") throw new PostError("Not allowed.", 403);
  const fields = fieldsFromMdx(collection, slug, source);
  const url = `/${collection}/${slug}`;
  const outcome = (action: PushAction, row: { id: string; status: string }, extra: Partial<PushOutcome> = {}): PushOutcome => ({ action, id: row.id, status: row.status, url, admin: `/admin/posts/${row.id}`, ...extra });

  const db = await getDb();
  const [current] = await db.select().from(schema.post).where(and(eq(schema.post.collection, collection), eq(schema.post.slug, slug)));
  if (!current) {
    // A new draft has no publication date, and `updatedAt` is only valid with one.
    const created = await createPost(actor, { ...fields, updatedAt: null, status: "draft" });
    return outcome("created", created, created.warnings?.length ? { warnings: created.warnings } : {});
  }
  // An author's key sees only the author's own posts; the slug is taken either way.
  if (actor.role !== "admin" && current.authorId !== actor.id) throw new PostError(`A ${collection} post with slug "${slug}" already exists and belongs to another author.`, 409);
  if (opts.createOnly) return outcome("exists", current, { reason: `${url} is already a post (${current.status}); not changed` });
  if (current.deletedAt) return outcome("skipped", current, { reason: `${url} is in the trash; restore it in Admin → Posts → Trash first` });
  const live = !EDITABLE.has(current.status);
  if (live && !(opts.updateLive && auth.canPublish)) {
    const how = opts.updateLive ? "this key can only edit drafts (scope posts:draft)" : "edit it in Admin → Posts";
    return outcome("skipped", current, { reason: `${url} is ${current.status}; ${how}` });
  }
  // A post that was never published keeps no `updatedAt` (the schema refuses one without a publication date).
  const next = current.publishedAt ? fields : { ...fields, updatedAt: null };
  if (sameAsFile(current, next)) return outcome("unchanged", current);
  // baseVersion: if an editor saved or published it since it was read above, the write is refused (409).
  const updated = await updatePost(actor, current.id, next, { baseVersion: current.version });
  return outcome("updated", updated, updated.warnings?.length ? { warnings: updated.warnings } : {});
}
