import { sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { rowsOf } from "@/db/rows";
import { createPost, type Actor } from "../posts";
import { addDays, isDay } from "./sqlutil";

/**
 * Editorial calendar (owner request 2026-11-18). An item is in one of three phases, shown and filtered as such:
 *
 *   unscheduled → scheduled (has a date) → published (its post is published)
 *
 * There is no approval step: an item is worked on by generating its draft (a CMS draft post the Editorial Crew
 * writes), improving that draft, and scheduling it. "published" is never set by hand: it follows the linked post.
 * Deleting an item hides it (status "dropped") and keeps its fingerprint, so the suggestion engine does not add it
 * again. The stored `status` column keeps its old values for this reason and for history; the UI reads `phase`.
 * Scheduling the post itself is calendar-schedule.ts (a person's action, never the agent's).
 */
export const STATUSES = ["suggested", "approved", "drafting", "in_review", "published", "dropped"] as const;
export type CalStatus = (typeof STATUSES)[number];
export const PHASES = ["unscheduled", "scheduled", "published"] as const;
export type Phase = (typeof PHASES)[number];

/**
 * Where an item came from, for the filter: Search Console demand, the ML query clusters, Google Analytics, the AI
 * (reader questions on Ask the Blog, the Promotion crew's ideas), the editorial engine, or a person.
 */
export type Source = "measured" | "ml" | "analytics" | "ai" | "editorial" | "manual";

/**
 * The state of an item's draft:
 * - none: no post (never generated, or its post was deleted or trashed);
 * - outline: a draft post holding only the generated outline (the agent has not written it, or is not configured);
 * - writing / failed: the SEO agent is writing it, or its last attempt failed;
 * - ready: a draft (or "in review") post with real content;
 * - scheduled / published: the post is scheduled, or published.
 */
export type DraftState = "none" | "outline" | "writing" | "failed" | "ready" | "scheduled" | "published";

/** The first line of the outline post createDraftFromItem writes; a post that still starts with it is not written yet. */
export const OUTLINE_MARKER = "> Draft created from the SEO editorial calendar";
export const isOutline = (body: string | null | undefined) => (body ?? "").trimStart().startsWith(OUTLINE_MARKER);

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
    /** The author's own first-hand material for the writer (what was built, real commands, results, opinions). */
    authorNotes: text(6000),
  })
  .partial()
  .strict();

export const patchSchema = z
  .object({
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

const sourceOf = (r: Row): Source => {
  const source = String(((r.brief as { source?: string } | null) ?? {}).source ?? "");
  if (source === "ml") return "ml";
  if (source === "analytics") return "analytics";
  if (source === "ask" || source === "promotion") return "ai";
  if (source === "manual") return "manual";
  return String(r.kind) === "measured" ? "measured" : "editorial";
};

function draftStateOf(r: Row): DraftState {
  const post = r.post_status as string | null;
  if (r.status === "published" || post === "published") return "published";
  if (post === "scheduled") return "scheduled";
  const agent = r.agent_status as string | null;
  if (agent === "generating") return "writing";
  if (!post) return "none";
  if (isOutline(r.post_head as string | null)) return agent === "generation_failed" ? "failed" : "outline";
  return "ready";
}

const shape = (r: Row) => {
  const draft = draftStateOf(r);
  const targetDate = r.target_date ? String(r.target_date).slice(0, 10) : null;
  const flags = Array.isArray(r.agent_flags) ? (r.agent_flags as { severity?: string }[]) : [];
  return {
    id: String(r.id),
    title: String(r.title),
    status: String(r.status) as CalStatus,
    phase: (draft === "published" ? "published" : targetDate || draft === "scheduled" ? "scheduled" : "unscheduled") as Phase,
    source: sourceOf(r),
    kind: String(r.kind),
    category: (r.category as string | null) ?? null,
    cluster: (r.cluster as string | null) ?? null,
    priorityScore: Number(r.priority_score),
    priorityBand: String(r.priority_band),
    targetDate,
    targetTime: r.target_time ? String(r.target_time).slice(0, 5) : null,
    ownerId: (r.owner_id as string | null) ?? null,
    ownerName: (r.owner_name as string | null) ?? null,
    recommendationId: (r.recommendation_id as string | null) ?? null,
    postId: (r.post_id as string | null) ?? null,
    postTitle: (r.post_title as string | null) ?? null,
    postStatus: (r.post_status as string | null) ?? null,
    postPath: r.post_slug ? `/${r.post_collection}/${r.post_slug}` : null,
    postScheduledFor: r.post_status === "scheduled" && r.post_published_at ? new Date(String(r.post_published_at)).toISOString() : null,
    draft,
    agentFailure: (r.agent_failure as string | null) ?? null,
    flagErrors: flags.filter((f) => f.severity === "error").length,
    flagWarnings: flags.filter((f) => f.severity !== "error").length,
    scheduleNote: (r.schedule_note as string | null) ?? null,
    brief: (r.brief as Record<string, unknown>) ?? {},
    evidence: (r.evidence as unknown[]) ?? [],
    publishedAt: r.published_at ? new Date(String(r.published_at)).toISOString() : null,
    clicksSincePublish: r.clicks_since === null || r.clicks_since === undefined ? null : Number(r.clicks_since),
    createdAt: r.created_at ? new Date(String(r.created_at)).toISOString() : null,
  };
};
export type CalendarItem = ReturnType<typeof shape>;

/** Sync "published" from linked posts (the only way an item becomes published). */
async function syncPublished() {
  const db = await getDb();
  await db.execute(sql`
    update seo_editorial_calendar c set status = 'published', published_at = p.published_at, updated_at = now()
    from post p where p.id = c.post_id and p.status = 'published' and p.deleted_at is null and c.status <> 'published'`);
}

/**
 * Keep each item's link to its post true before it is shown:
 * - a link to a post that was deleted or is in the trash is cleared (the item then offers "Generate draft" again,
 *   instead of a draft link that answers "not found");
 * - an item without a post is linked to the one live post with the same title, if exactly one and no other item has
 *   it (a draft or published post written by hand for that idea);
 * - an item follows its post to published.
 */
export async function reconcileCalendar() {
  const db = await getDb();
  await db.execute(sql`
    update seo_editorial_calendar c set post_id = null, updated_at = now()
    where c.post_id is not null and c.status <> 'published'
      and not exists (select 1 from post p where p.id = c.post_id and p.deleted_at is null)`);
  await db.execute(sql`
    update seo_editorial_calendar c set post_id = m.id, updated_at = now()
    from (
      select c2.id as item_id, min(p.id::text)::uuid as id from seo_editorial_calendar c2
      join post p on lower(btrim(p.title)) = lower(btrim(c2.title)) and p.deleted_at is null
      where c2.post_id is null and c2.status not in ('dropped', 'published')
        and not exists (select 1 from seo_editorial_calendar o where o.post_id = p.id)
      group by c2.id having count(*) = 1
    ) m
    where c.id = m.item_id`);
  await syncPublished();
}

export async function listCalendar(opts: { from?: string; to?: string; status?: string } = {}) {
  await reconcileCalendar();
  const db = await getDb();
  const parts = [sql`c.status <> 'dropped'`];
  if (opts.status && (STATUSES as readonly string[]).includes(opts.status)) parts.push(sql`c.status = ${opts.status}`);
  const rows = rowsOf<Row>(
    await db.execute(sql`
      select c.*, u.name as owner_name, p.title as post_title, p.status as post_status, p.collection as post_collection, p.slug as post_slug,
        p.published_at as post_published_at, left(p.body, 200) as post_head,
        sd.status as agent_status, sd.flags as agent_flags, sd.failure_reason as agent_failure,
        (select sum(g.clicks)::float8 from seo_gsc_page_daily g join seo_url_map m on m.url = g.page where m.article_id = c.post_id and g.search_type = 'web' and g.date >= c.published_at::date) as clicks_since
      from seo_editorial_calendar c left join "user" u on u.id = c.owner_id left join post p on p.id = c.post_id and p.deleted_at is null
      left join lateral (select d.status, d.flags, d.failure_reason from seo_drafts d where d.calendar_id = c.id and d.kind = 'new_article' order by d.created_at desc limit 1) sd on true
      where ${sql.join(parts, sql` and `)} order by c.target_date nulls last, c.target_time nulls last, c.priority_score desc limit 500`),
  );
  const items = rows.map(shape);
  const inRange = (d: string | null) => d !== null && (!opts.from || d >= opts.from) && (!opts.to || d <= opts.to);
  return { scheduled: items.filter((i) => inRange(i.targetDate)), unscheduled: items.filter((i) => i.phase === "unscheduled"), all: items };
}

/** One item as the calendar shows it (after reconciling), or undefined. */
export async function getItem(id: string): Promise<CalendarItem | undefined> {
  return (await listCalendar()).all.find((i) => i.id === id);
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
  if (status === "dropped") throw new CalendarError("Calendar item not found.", 404);
  if (patch.postId) {
    const [p] = rowsOf<{ id: string }>(await db.execute(sql`select id from post where id = ${patch.postId} and deleted_at is null`));
    if (!p) throw new CalendarError("That post does not exist.", 400);
  }
  if (patch.ownerId) {
    const [u] = rowsOf<{ id: string }>(await db.execute(sql`select id from "user" where id = ${patch.ownerId} and role in ('admin', 'author')`));
    if (!u) throw new CalendarError("The owner must be an admin or author.", 400);
  }
  await db.execute(sql`
    update seo_editorial_calendar set
      title = coalesce(${patch.title ?? null}, title),
      category = case when ${patch.category !== undefined} then ${patch.category || null} else category end,
      cluster = case when ${patch.cluster !== undefined} then ${patch.cluster || null} else cluster end,
      brief = brief || ${JSON.stringify(patch.brief ?? {})}::jsonb,
      owner_id = case when ${patch.ownerId !== undefined} then ${patch.ownerId ?? null} else owner_id end,
      post_id = case when ${patch.postId !== undefined} then ${patch.postId ?? null}::uuid else post_id end,
      updated_at = now()
    where id = ${id}`);
  await syncPublished();
  return { before: { title: cur.title, postId: cur.post_id ?? null, ownerId: cur.owner_id ?? null, category: cur.category ?? null, cluster: cur.cluster ?? null, ...(patch.brief ? { brief: cur.brief } : {}) }, after: patch };
}

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "draft";

/**
 * Delete an item from the calendar. It is hidden (status "dropped"), not removed, so a suggestion with the same
 * fingerprint is not added again; its post, if any, is kept (calendar-schedule.ts unschedules it first).
 */
export async function deleteItem(id: string) {
  const db = await getDb();
  const [row] = rowsOf<{ id: string }>(await db.execute(sql`update seo_editorial_calendar set status = 'dropped', target_date = null, target_time = null, scheduled_by = null, schedule_note = null, updated_at = now() where id = ${id} and status <> 'dropped' returning id`));
  if (!row) throw new CalendarError("Calendar item not found.", 404);
}

/**
 * The item's CMS draft post: an outline from the brief (the Editorial Crew then writes it, see orchestrate.ts). Never
 * publishes. An item whose post still holds only the outline reuses that post; one with a real draft is refused.
 */
export async function createDraftFromItem(id: string, actor: Actor, now = new Date()) {
  await reconcileCalendar();
  const db = await getDb();
  const [item] = rowsOf<Row>(await db.execute(sql`select c.*, p.body as post_body from seo_editorial_calendar c left join post p on p.id = c.post_id and p.deleted_at is null where c.id = ${id} and c.status <> 'dropped'`));
  if (!item) throw new CalendarError("Calendar item not found.", 404);
  if (item.status === "published") throw new CalendarError("This item is already published.", 409);
  if (item.post_id && !isOutline(item.post_body as string | null)) throw new CalendarError("This item already has a draft. Use Improve to revise it.", 409);
  if (item.post_id) {
    await db.execute(sql`update seo_editorial_calendar set status = 'drafting', updated_at = now() where id = ${id}`);
    return { postId: String(item.post_id), editorUrl: `/admin/posts/${String(item.post_id)}`, reused: true };
  }
  const brief = (item.brief as { outline?: string[]; audience?: string; intent?: string; supportingQueries?: string[]; internalLinks?: { title: string; path: string }[]; codeExamples?: string[]; diagrams?: string[]; gap?: string }) ?? {};
  const body = [
    `${OUTLINE_MARKER} (${String(item.kind) === "measured" ? "measured: backed by Search Console data" : "editorial idea"}). Replace these notes before review.`,
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
