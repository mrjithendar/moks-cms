import { sql } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
import { log } from "../log";
import { updatePost, type Actor } from "../posts";
import type { Role } from "../auth";

/**
 * Editorial calendar → CMS, with no separate review step: when the Editorial Crew finishes a calendar article, its
 * title, meta description and body are written straight into the item's CMS draft post. The owner edits and publishes
 * it in the normal post editor (calendar status follows the post: calendar.ts syncs "published").
 *
 * Only replaces the generated outline: if someone already edited the post body, nothing is overwritten and the draft
 * stays where it was. The crew's notes (fact-check flags) stay on the seo_drafts row and the editor shows them.
 * News desk drafts are not handed off (they have their own desk).
 */

/** The reviewer sometimes wraps the article: "## Corrected MDX body", notes, a ```mdx fence, then its notes after. */
export function cleanCrewBody(raw: string): string {
  // A trailing notes section the parser did not split off.
  const text = (raw ?? "").trim().replace(/\n#{1,6}\s*needs[_ ]fact[_ ]check[\s\S]*$/i, "").trim();
  const lines = text.split("\n");
  const open = lines.findIndex((l) => /^```(?:mdx|markdown|md)\s*$/i.test(l.trim()));
  if (open === -1) return text.replace(/^#{1,6}\s*corrected\b[^\n]*\n+/i, "").trim();
  // Inner code blocks come in pairs of fence lines: with an odd count the last bare ``` closes the wrapper; with an
  // even count the wrapper was cut off (e.g. the crew hit its token cap) and everything after the opening is body.
  let inner = lines.slice(open + 1);
  const fences = inner.map((l, i) => (l.trim().startsWith("```") ? i : -1)).filter((i) => i !== -1);
  const last = fences.at(-1);
  if (fences.length % 2 === 1 && last !== undefined && inner[last]!.trim() === "```") inner = inner.slice(0, last);
  return inner.join("\n").trim();
}

type HandoffRow = { id: string; article_id: string; collection: string; kind: string; status: string; calendar_id: string | null; document: unknown; base_snapshot: unknown; p_body: string; p_status: string; p_version: number; p_deleted: string | null; p_description: string; author_id: string; author_role: string; author_email: string };

const asObj = (v: unknown): Record<string, unknown> | null => (typeof v === "string" ? (JSON.parse(v) as Record<string, unknown>) : (v as Record<string, unknown> | null));

/** Move a finished calendar draft into its CMS post. Safe to call repeatedly. */
export async function handOffToCms(draftId: string, db?: Db): Promise<{ handedOff: boolean; reason?: string; version?: number }> {
  db ??= await getDb();
  const [r] = rowsOf<HandoffRow>(
    await db.execute(sql`
      select d.id, d.article_id, d.collection, d.kind, d.status, d.calendar_id, d.document, d.base_snapshot,
        p.body as p_body, p.status as p_status, p.version as p_version, p.deleted_at as p_deleted, p.description as p_description,
        p.author_id, u.role as author_role, u.email as author_email
      from seo_drafts d join post p on p.id = d.article_id join "user" u on u.id = p.author_id
      where d.id = ${draftId}`),
  );
  if (!r) return { handedOff: false, reason: "not_found" };
  if (r.kind !== "new_article" || !r.calendar_id || r.collection === "news") return { handedOff: false, reason: "not_calendar" };
  if (r.status !== "ready_for_review") return { handedOff: false, reason: `status_${r.status}` };
  if (r.p_deleted || !["draft", "review"].includes(r.p_status)) return { handedOff: false, reason: "post_not_draft" };
  const doc = asObj(r.document) ?? {};
  const body = cleanCrewBody(String(doc.body_mdx ?? ""));
  if (!body) return { handedOff: false, reason: "empty_body" };
  const outline = String(asObj(r.base_snapshot)?.body ?? "");
  if (r.p_body.trim() !== outline.trim()) return { handedOff: false, reason: "post_edited" };

  const actor: Actor = { id: r.author_id, role: (["admin", "author"].includes(r.author_role) ? r.author_role : "admin") as Role, label: r.author_email };
  const title = String(doc.title ?? "").trim();
  const meta = String(doc.meta_description ?? "").trim();
  const patch: Record<string, unknown> = { body, ...(title ? { title: title.slice(0, 110) } : {}), ...(meta ? { description: meta, seoDescription: meta } : {}) };
  const row = await updatePost(actor, r.article_id, patch, { baseVersion: Number(r.p_version), reason: "ai-draft", incompleteDrafts: true, notifySearchEngines: false });
  await db.execute(sql`update seo_drafts set status = 'superseded', summary = ${`Moved into the CMS editor (post version ${row.version}).`}, updated_at = now() where id = ${draftId} and status = 'ready_for_review'`);
  await db.execute(sql`update seo_editorial_calendar set status = 'in_review', updated_at = now() where id = ${r.calendar_id} and status in ('approved', 'drafting')`);
  log.info("calendar draft moved into the CMS", { operation: "seo_handoff", outcome: "handed_off" });
  return { handedOff: true, version: row.version };
}

/** The open calendar draft of a post, handed off if it is ready (the editor calls this so older drafts move too). */
export async function handOffForPost(postId: string): Promise<boolean> {
  const db = await getDb();
  const [d] = rowsOf<{ id: string }>(await db.execute(sql`select id from seo_drafts where article_id = ${postId} and kind = 'new_article' and calendar_id is not null and status = 'ready_for_review' limit 1`));
  if (!d) return false;
  try {
    return (await handOffToCms(d.id, db)).handedOff;
  } catch (err) {
    log.warn("calendar draft handoff failed", { err, operation: "seo_handoff" });
    return false;
  }
}

/** The crew's notes for a post's latest calendar draft (shown in the CMS editor). */
export async function crewNotesForPost(postId: string): Promise<{ flags: { severity: string; message: string }[]; incomplete: string | null } | null> {
  const db = await getDb();
  const [d] = rowsOf<{ flags: unknown; document: unknown }>(await db.execute(sql`select flags, document from seo_drafts where article_id = ${postId} and kind = 'new_article' and calendar_id is not null order by created_at desc limit 1`));
  if (!d) return null;
  const flags = (typeof d.flags === "string" ? JSON.parse(d.flags) : d.flags) as { severity: string; message: string; code?: string }[] | null;
  const doc = asObj(d.document) ?? {};
  return { flags: (flags ?? []).filter((f) => f.code !== "incomplete"), incomplete: doc.incomplete ? String(doc.incomplete_reason ?? "the crew stopped early") : null };
}
