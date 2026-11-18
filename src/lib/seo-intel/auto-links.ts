import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import { rowsOf } from "@/db/rows";
import { audit } from "../audit";
import { log } from "../log";
import type { Actor } from "../posts";
import { validateChangeSet, type Change } from "./changeset";
import { diffWords } from "diff";
import { loadBase, reserveDraft, validationContext } from "./drafts";
import { ALLOWED_EXTERNAL_URLS } from "./external-links";
import { listKeywords } from "./link-keywords";
import { planArticleLinks } from "./link-plan";
import { autoPublishLinkDraft } from "./publish";
import type { SeoSettings } from "./settings";

/**
 * Weekly automatic link maintenance (owner decision 2026-11-10; docs/seo/INTERNAL_LINKING.md "Automatic publishing").
 *
 * For up to `links.auto.maxArticlesPerRun` published articles it plans internal links (every limit of the v2 planner)
 * and official-docs external links (external-links.ts), records them as an ordinary draft (trigger auto_links, every
 * change accepted, audit trail and one-click rollback like any draft) and publishes it at once with
 * autoPublishLinkDraft. Not aggressive: a few articles a week, a cool-down per article, and an article is skipped
 * while anyone may be working on it (an open draft, unsaved editor changes, or an edit in the last 24 hours).
 */
export type AutoLinkResult = { articles: number; published: number; links: number; skipped: Record<string, number>; failed: string[] };

/** The admin the automatic updates act as (the CMS records every edit against a user): the earliest admin account. */
async function systemActor(db: Db): Promise<Actor | null> {
  const [u] = rowsOf<{ id: string; email: string }>(await db.execute(sql`select id, email from "user" where role = 'admin' order by created_at asc limit 1`));
  return u ? { id: u.id, role: "admin", label: `auto-links (${u.email})` } : null;
}

/** Published, indexable articles that are due, least recently auto-linked first. */
async function candidates(db: Db, s: SeoSettings, now: Date): Promise<{ id: string; reason: string | null }[]> {
  const rows = rowsOf<{ id: string; open_draft: boolean; autosaved: boolean; recently_edited: boolean; cooling: boolean }>(
    await db.execute(sql`
      select p.id,
        exists (select 1 from seo_drafts d where d.article_id = p.id and d.status in ('generating', 'ready_for_review', 'generation_failed', 'scheduled', 'publishing')) as open_draft,
        exists (select 1 from autosave a where a.entity = 'post' and a.entity_id = p.id::text) as autosaved,
        p.saved_at > ${new Date(now.getTime() - 86_400_000).toISOString()}::timestamptz as recently_edited,
        exists (select 1 from seo_drafts d where d.article_id = p.id and d.trigger = 'auto_links' and d.created_at > ${new Date(now.getTime() - s.links.auto.cooldownDays * 86_400_000).toISOString()}::timestamptz) as cooling
      from post p
      where p.deleted_at is null and p.status = 'published' and p.noindex = false and (p.canonical_url is null or p.canonical_url = '')
        and (p.published_at is null or p.published_at <= now())
      order by (select max(d.created_at) from seo_drafts d where d.article_id = p.id and d.trigger = 'auto_links') asc nulls first, p.published_at desc nulls last`),
  );
  return rows.map((r) => ({
    id: r.id,
    reason: r.cooling ? "cooldown" : r.open_draft ? "open_draft" : r.autosaved ? "unsaved_editor_changes" : r.recently_edited ? "edited_in_last_24h" : null,
  }));
}

export async function runAutoLinks(db: Db, s: SeoSettings, now = new Date()): Promise<AutoLinkResult> {
  const out: AutoLinkResult = { articles: 0, published: 0, links: 0, skipped: {}, failed: [] };
  if (!s.links.enabled || !s.links.auto.enabled) return out;
  const actor = await systemActor(db);
  if (!actor) {
    out.skipped.no_admin = 1;
    return out;
  }
  // External targets that may be added: the official docs and the owner's own keyword URLs.
  const keywordUrls = new Set((await listKeywords(db, { enabledOnly: true })).map((k) => k.url));
  const skip = (why: string) => (out.skipped[why] = (out.skipped[why] ?? 0) + 1);
  for (const c of await candidates(db, s, now)) {
    if (out.articles >= s.links.auto.maxArticlesPerRun) break;
    if (c.reason) {
      skip(c.reason);
      continue;
    }
    const base = await loadBase(db, c.id);
    const changes: Change[] = (await planArticleLinks(db, s, base, c.id, "auto")).map((ch) => ({ ...ch, decision: "accepted" as const }));
    const internal = changes.filter((ch) => ch.type === "internal_link");
    const external = changes.filter((ch) => ch.type === "external_link");
    if (!changes.length) {
      skip("nothing_to_link");
      continue;
    }
    out.articles++;
    const ctx = { ...(await validationContext(db, s, c.id, ["internal_links"])), externalAllow: new Set([...ALLOWED_EXTERNAL_URLS, ...keywordUrls]) };
    const v = validateChangeSet(base, changes, ctx, diffWords);
    const draft = await reserveDraft(db, c.id, base, "auto_links");
    if (v.errors.length || v.flags.some((f) => f.severity === "error")) {
      const reason = `Automatic links not published: ${[...v.errors, ...v.flags.filter((f) => f.severity === "error").map((f) => f.message)].slice(0, 3).join("; ")}`.slice(0, 1000);
      // Superseded, not left open: the article isn't blocked, and the cool-down stops a retry until next time.
      await db.execute(sql`update seo_drafts set status = 'superseded', failure_reason = ${reason}, updated_at = now() where id = ${draft.id}`);
      out.failed.push(c.id);
      continue;
    }
    const summary = `Automatic link update: ${internal.length} internal, ${external.length} official-docs (nofollow).`;
    await db.execute(sql`
      update seo_drafts set status = 'ready_for_review', changes = ${JSON.stringify(changes)}::jsonb, flags = '[]'::jsonb, summary = ${summary},
        categories = '{internal_links}'::text[], failure_reason = null, generated_at = now(), updated_at = now()
      where id = ${draft.id}`);
    try {
      await autoPublishLinkDraft(draft.id, actor, now);
      out.published++;
      out.links += changes.length;
      await audit(actor, "seo.links.auto_publish", c.id, { draftId: draft.id, internal: internal.map((x) => x.target), external: external.map((x) => x.target) });
    } catch (e) {
      // Left as a normal draft for a person to look at; the next run skips the article (open draft).
      await db.execute(sql`update seo_drafts set failure_reason = ${`Automatic publish failed: ${(e as Error).message}`.slice(0, 1000)}, updated_at = now() where id = ${draft.id}`);
      out.failed.push(c.id);
    }
  }
  log.info("seo auto links", { operation: "seo_auto_links", outcome: out.failed.length ? "partial" : "succeeded", published: out.published, links: out.links });
  return out;
}
