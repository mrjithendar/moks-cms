import { sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { rowsOf } from "@/db/rows";
import { createPost, type Actor } from "../posts";
import { addDays, isDay } from "./sqlutil";

/**
 * Editorial calendar. Status flow: suggested → approved → drafting → in_review → published (or dropped at any point
 * before published). "published" is never set by hand: it follows the linked post, which only a person can publish
 * with the editor's own Publish button. "Create draft" uses the CMS's createPost with status "draft".
 */
export const STATUSES = ["suggested", "approved", "drafting", "in_review", "published", "dropped"] as const;
export type CalStatus = (typeof STATUSES)[number];
const NEXT: Record<CalStatus, CalStatus[]> = {
  suggested: ["approved", "dropped"],
  approved: ["drafting", "suggested", "dropped"],
  drafting: ["in_review", "approved", "dropped"],
  in_review: ["drafting", "dropped"],
  published: [],
  dropped: ["suggested"],
};

export class CalendarError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Time of day for a scheduled item, 24-hour HH:MM, in the editorial time zone (Asia/Kolkata). */
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export const createSchema = z.object({
  title: z.string().trim().min(5).max(200),
  category: z.string().trim().regex(/^[a-z0-9-]{1,60}$/).optional(),
  targetDate: z.string().refine(isDay, "Use YYYY-MM-DD").optional(),
  targetTime: z.string().regex(TIME, "Use HH:MM (24-hour)").optional(),
  notes: z.string().trim().max(2000).optional(),
});
const text = (max: number) => z.string().trim().max(max);
const list = (n: number, max: number) => z.array(z.string().trim().min(1).max(max)).max(n);
/** The editable parts of an item's brief (editorial calendar, scheduled and unscheduled). */
export const briefPatch = z
  .object({
    gap: text(1000),
    audience: text(300),
    intent: text(100),
    supportingQueries: list(30, 200),
    outline: list(30, 200),
    codeExamples: list(20, 300),
    diagrams: list(20, 300),
    readingTimeMinutes: z.union([z.number().int().min(1).max(120), z.null()]),
    notes: text(4000),
  })
  .partial()
  .strict();

export const patchSchema = z
  .object({
    status: z.enum(["suggested", "approved", "drafting", "in_review", "dropped"]).optional(),
    targetDate: z.union([z.string().refine(isDay, "Use YYYY-MM-DD"), z.null()]).optional(),
    targetTime: z.union([z.string().regex(TIME, "Use HH:MM (24-hour)"), z.null()]).optional(),
    ownerId: z.union([z.string().min(1).max(100), z.null()]).optional(),
    postId: z.union([z.string().uuid(), z.null()]).optional(),
    title: z.string().trim().min(5).max(200).optional(),
    category: z.union([z.string().trim().regex(/^[a-z0-9-]{1,60}$/, "Use a category slug (a-z, 0-9, -)"), z.null()]).optional(),
    cluster: z.union([z.string().trim().max(200), z.null()]).optional(),
    /** Brief fields, merged into the stored brief (other keys such as source are kept). */
    brief: briefPatch.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Nothing to change.");

type Row = Record<string, unknown>;
const shape = (r: Row) => ({
  id: String(r.id),
  title: String(r.title),
  status: String(r.status) as CalStatus,
  kind: String(r.kind),
  category: (r.category as string | null) ?? null,
  cluster: (r.cluster as string | null) ?? null,
  priorityScore: Number(r.priority_score),
  priorityBand: String(r.priority_band),
  targetDate: r.target_date ? String(r.target_date).slice(0, 10) : null,
  targetTime: r.target_time ? String(r.target_time).slice(0, 5) : null,
  ownerId: (r.owner_id as string | null) ?? null,
  ownerName: (r.owner_name as string | null) ?? null,
  recommendationId: (r.recommendation_id as string | null) ?? null,
  postId: (r.post_id as string | null) ?? null,
  postTitle: (r.post_title as string | null) ?? null,
  postStatus: (r.post_status as string | null) ?? null,
  postPath: r.post_slug ? `/${r.post_collection}/${r.post_slug}` : null,
  brief: (r.brief as Record<string, unknown>) ?? {},
  evidence: (r.evidence as unknown[]) ?? [],
  publishedAt: r.published_at ? new Date(String(r.published_at)).toISOString() : null,
  clicksSincePublish: r.clicks_since === null || r.clicks_since === undefined ? null : Number(r.clicks_since),
});

/** Sync "published" from linked posts (the only way an item becomes published). */
async function syncPublished() {
  const db = await getDb();
  await db.execute(sql`
    update seo_editorial_calendar c set status = 'published', published_at = p.published_at, updated_at = now()
    from post p where p.id = c.post_id and p.status = 'published' and p.deleted_at is null and c.status <> 'published'`);
}

export async function listCalendar(opts: { from?: string; to?: string; status?: string } = {}) {
  await syncPublished();
  const db = await getDb();
  const parts = [sql`true`];
  if (opts.status && (STATUSES as readonly string[]).includes(opts.status)) parts.push(sql`c.status = ${opts.status}`);
  const rows = rowsOf<Row>(
    await db.execute(sql`
      select c.*, u.name as owner_name, p.title as post_title, p.status as post_status, p.collection as post_collection, p.slug as post_slug,
        (select sum(g.clicks)::float8 from seo_gsc_page_daily g join seo_url_map m on m.url = g.page where m.article_id = c.post_id and g.search_type = 'web' and g.date >= c.published_at::date) as clicks_since
      from seo_editorial_calendar c left join "user" u on u.id = c.owner_id left join post p on p.id = c.post_id
      where ${sql.join(parts, sql` and `)} order by c.target_date nulls last, c.target_time nulls last, c.priority_score desc limit 500`),
  );
  const items = rows.map(shape);
  const inRange = (d: string | null) => d !== null && (!opts.from || d >= opts.from) && (!opts.to || d <= opts.to);
  return { scheduled: items.filter((i) => inRange(i.targetDate)), unscheduled: items.filter((i) => !i.targetDate && !["dropped", "published"].includes(i.status)), all: items };
}

export async function createItem(input: z.output<typeof createSchema>) {
  const db = await getDb();
  const [row] = rowsOf<{ id: string }>(
    await db.execute(sql`
      insert into seo_editorial_calendar (title, status, kind, category, target_date, target_time, brief)
      values (${input.title}, 'approved', 'editorial_idea', ${input.category ?? null}, ${input.targetDate ?? null}, ${input.targetDate ? (input.targetTime ?? null) : null}::time, ${JSON.stringify({ notes: input.notes ?? "", source: "manual" })}::jsonb)
      returning id`),
  );
  return row!.id;
}

export async function updateItem(id: string, patch: z.output<typeof patchSchema>) {
  const db = await getDb();
  const [cur] = rowsOf<Row>(await db.execute(sql`select * from seo_editorial_calendar where id = ${id}`));
  if (!cur) throw new CalendarError("Calendar item not found.", 404);
  const status = String(cur.status) as CalStatus;
  if (patch.status && patch.status !== status && !NEXT[status].includes(patch.status)) throw new CalendarError(`Cannot move from ${status} to ${patch.status}.`, 409);
  if (patch.postId) {
    const [p] = rowsOf<{ id: string }>(await db.execute(sql`select id from post where id = ${patch.postId} and deleted_at is null`));
    if (!p) throw new CalendarError("That post does not exist.", 400);
  }
  // A time needs a date (clearing the date clears the time).
  if (patch.targetTime && patch.targetDate === null) throw new CalendarError("Set a date before a time.", 400);
  if (patch.targetTime && patch.targetDate === undefined && !cur.target_date) throw new CalendarError("Set a date before a time.", 400);
  if (patch.ownerId) {
    const [u] = rowsOf<{ id: string }>(await db.execute(sql`select id from "user" where id = ${patch.ownerId} and role in ('admin', 'author')`));
    if (!u) throw new CalendarError("The owner must be an admin or author.", 400);
  }
  await db.execute(sql`
    update seo_editorial_calendar set
      status = coalesce(${patch.status ?? null}, status),
      title = coalesce(${patch.title ?? null}, title),
      category = case when ${patch.category !== undefined} then ${patch.category || null} else category end,
      cluster = case when ${patch.cluster !== undefined} then ${patch.cluster || null} else cluster end,
      brief = brief || ${JSON.stringify(patch.brief ?? {})}::jsonb,
      target_date = case when ${patch.targetDate !== undefined} then ${patch.targetDate ?? null}::date else target_date end,
      target_time = case when ${patch.targetDate === null} then null when ${patch.targetTime !== undefined} then ${patch.targetTime ?? null}::time else target_time end,
      owner_id = case when ${patch.ownerId !== undefined} then ${patch.ownerId ?? null} else owner_id end,
      post_id = case when ${patch.postId !== undefined} then ${patch.postId ?? null}::uuid else post_id end,
      updated_at = now()
    where id = ${id}`);
  await syncPublished();
  return { before: { status, title: cur.title, targetDate: cur.target_date ?? null, targetTime: cur.target_time ?? null, postId: cur.post_id ?? null, ownerId: cur.owner_id ?? null, category: cur.category ?? null, cluster: cur.cluster ?? null, ...(patch.brief ? { brief: cur.brief } : {}) }, after: patch };
}

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "draft";

/** Create a DRAFT post from an approved item (brief as outline). Never publishes. */
export async function createDraftFromItem(id: string, actor: Actor, now = new Date()) {
  const db = await getDb();
  const [item] = rowsOf<Row>(await db.execute(sql`select * from seo_editorial_calendar where id = ${id}`));
  if (!item) throw new CalendarError("Calendar item not found.", 404);
  if (item.post_id) throw new CalendarError("This item already has a draft.", 409);
  if (!["approved", "drafting"].includes(String(item.status))) throw new CalendarError("Approve the item before creating a draft.", 409);
  const brief = (item.brief as { outline?: string[]; audience?: string; intent?: string; supportingQueries?: string[]; internalLinks?: { title: string; path: string }[]; codeExamples?: string[]; diagrams?: string[]; gap?: string }) ?? {};
  const body = [
    `> Draft created from the SEO editorial calendar (${String(item.kind) === "measured" ? "measured: backed by Search Console data" : "editorial idea"}). Replace these notes before review.`,
    "",
    brief.gap ? `> Why: ${brief.gap}` : "",
    brief.audience ? `> Audience: ${brief.audience}; intent: ${brief.intent ?? "n/a"}` : "",
    brief.supportingQueries?.length ? `> Queries: ${brief.supportingQueries.join(", ")}` : "",
    "",
    ...(brief.outline ?? ["Introduction", "Main section", "Summary"]).flatMap((h) => [`## ${h}`, "", "TODO", ""]),
    brief.codeExamples?.length ? `<!-- Code examples to include: ${brief.codeExamples.join("; ")} -->` : "",
    brief.diagrams?.length ? `<!-- Diagrams: ${brief.diagrams.join("; ")} -->` : "",
    brief.internalLinks?.length ? `## Related reading\n\n${brief.internalLinks.map((l) => `- [${l.title}](${l.path})`).join("\n")}` : "",
  ].filter((l, i, a) => l !== "" || a[i - 1] !== "").join("\n");
  const title = String(item.title).slice(0, 110);
  const slug = `${slugify(title)}-${now.getTime().toString(36).slice(-4)}`;
  const post = await createPost(
    actor,
    { collection: "blog", slug, title, description: "", body, category: (item.category as string | null) ?? "devops-sre", tags: [], contentType: "tutorial", status: "draft" },
    { incompleteDrafts: true },
  );
  await db.execute(sql`update seo_editorial_calendar set post_id = ${post.id}, status = 'drafting', updated_at = now() where id = ${id}`);
  return { postId: post.id, editorUrl: `/admin/posts/${post.id}` };
}

export function monthRange(month: string | undefined, now = new Date()): { from: string; to: string; month: string } {
  const m = month && /^\d{4}-\d{2}$/.test(month) ? month : now.toISOString().slice(0, 7);
  const from = `${m}-01`;
  const next = new Date(`${from}T00:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return { from, to: addDays(next.toISOString().slice(0, 10), -1), month: m };
}
