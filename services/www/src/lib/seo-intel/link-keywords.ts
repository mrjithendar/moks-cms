import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db";
import { rowsOf } from "@/db/rows";
import type { BaseSnapshot, Change } from "./changeset";
import { externalLinksIn, planMentionLinks, type MentionEntry } from "./external-links";
import { internalLinksOf } from "./internal-links";

/**
 * The owner's keyword → URL list (Link Whisper-style "auto-link keywords"; owner decision 2026-11-10).
 *
 * A keyword's FIRST mention in an article links to its URL: a site path (/blog/x, must be a published, indexable page)
 * or an https URL (rendered nofollow like every external link). The usual placement rules apply (planMentionLinks).
 * Used by the weekly auto-linker and the editor's link suggestions; keywords go before the automatic planners, so the
 * owner's choice wins a paragraph.
 */
export type LinkKeyword = { id: string; keyword: string; url: string; caseSensitive: boolean; enabled: boolean; createdBy: string | null; createdAt: string };

const KEYWORD = z.string().trim().min(2).max(80).refine((k) => /\w/.test(k), "A keyword needs letters or numbers");
const URL_OR_PATH = z
  .string()
  .trim()
  .max(500)
  .refine((u) => /^\/(?!\/)[^\s]*$/.test(u) || /^https:\/\/[^\s/]+\.[^\s]+$/.test(u), "Use a site path like /blog/post or an https:// URL");

export const keywordInput = z.object({ keyword: KEYWORD, url: URL_OR_PATH, caseSensitive: z.boolean().default(false), enabled: z.boolean().default(true) });
export const keywordPatch = z.object({ keyword: KEYWORD, url: URL_OR_PATH, caseSensitive: z.boolean(), enabled: z.boolean() }).partial().refine((v) => Object.keys(v).length > 0, "Nothing to change.");

export class KeywordError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const shape = (r: Record<string, unknown>): LinkKeyword => ({
  id: String(r.id),
  keyword: String(r.keyword),
  url: String(r.url),
  caseSensitive: r.case_sensitive === true || r.case_sensitive === "t",
  enabled: r.enabled === true || r.enabled === "t",
  createdBy: (r.created_by as string | null) ?? null,
  createdAt: new Date(String(r.created_at)).toISOString(),
});

export async function listKeywords(db: Db, opts: { enabledOnly?: boolean } = {}): Promise<LinkKeyword[]> {
  const rows = rowsOf<Record<string, unknown>>(await db.execute(sql`select * from seo_link_keywords ${opts.enabledOnly ? sql`where enabled` : sql``} order by lower(keyword)`));
  return rows.map(shape);
}

/** A site path must be a published, indexable page (no links to drafts, noindex or missing pages). */
async function checkTarget(db: Db, url: string) {
  if (!url.startsWith("/")) return;
  const path = url.split("#")[0]!.replace(/\/+$/, "");
  const [hit] = rowsOf<{ n: number }>(
    await db.execute(sql`
      select count(*)::int as n from (
        select '/' || collection || '/' || slug as path from post where deleted_at is null and status = 'published' and noindex = false
        union all select '/' || slug from page where deleted_at is null and noindex = false
      ) x where path = ${path}`),
  );
  if (!Number(hit?.n)) throw new KeywordError(`${path} is not a published, indexable page on this site.`, 400);
}

export async function createKeyword(db: Db, input: z.output<typeof keywordInput>, actor: string): Promise<LinkKeyword> {
  await checkTarget(db, input.url);
  try {
    const [r] = rowsOf<Record<string, unknown>>(
      await db.execute(sql`
        insert into seo_link_keywords (keyword, url, case_sensitive, enabled, created_by)
        values (${input.keyword}, ${input.url}, ${input.caseSensitive}, ${input.enabled}, ${actor}) returning *`),
    );
    return shape(r!);
  } catch (e) {
    if (/unique|duplicate/i.test(String((e as { cause?: unknown }).cause ?? e))) throw new KeywordError(`“${input.keyword}” is already in the list.`, 409);
    throw e;
  }
}

export async function updateKeyword(db: Db, id: string, patch: z.output<typeof keywordPatch>): Promise<LinkKeyword> {
  if (patch.url) await checkTarget(db, patch.url);
  const [r] = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      update seo_link_keywords set
        keyword = coalesce(${patch.keyword ?? null}, keyword), url = coalesce(${patch.url ?? null}, url),
        case_sensitive = coalesce(${patch.caseSensitive ?? null}, case_sensitive), enabled = coalesce(${patch.enabled ?? null}, enabled), updated_at = now()
      where id = ${id} returning *`),
  );
  if (!r) throw new KeywordError("Keyword not found.", 404);
  return shape(r);
}

export async function deleteKeyword(db: Db, id: string): Promise<boolean> {
  return rowsOf(await db.execute(sql`delete from seo_link_keywords where id = ${id} returning id`)).length > 0;
}

const entry = (k: LinkKeyword): MentionEntry => ({ key: `kw:${k.id}`, names: [k.keyword], url: k.url, title: k.keyword, caseSensitive: k.caseSensitive });

/**
 * Keyword link changes for one article: internal targets become internal_link changes, https targets external_link.
 * `selfPath` is never linked; `knownPaths` (published, indexable) bounds internal targets; budgets are per kind.
 */
export function keywordLinkChanges(base: BaseSnapshot, keywords: LinkKeyword[], o: { selfPath: string; knownPaths: Set<string>; internalBudget: number; externalBudget: number; minWordsBetween: number; origin?: string; takenBlocks: Set<string>; startAt: number }): Change[] {
  const internal = keywords.filter((k) => k.enabled && k.url.startsWith("/") && k.url.split("#")[0] !== o.selfPath && o.knownPaths.has(k.url.split("#")[0]!.replace(/\/+$/, "")));
  const external = keywords.filter((k) => k.enabled && k.url.startsWith("https://"));
  const haveInternal = new Set(internalLinksOf(base.body));
  const haveExternal = new Set(externalLinksIn(base.body, o.origin));
  const plannedInternal = planMentionLinks(base.body, internal.map(entry), { budget: o.internalBudget, minWordsBetween: o.minWordsBetween, alreadyLinked: (u) => haveInternal.has(u.split("#")[0]!.replace(/\/+$/, "")), takenBlocks: o.takenBlocks });
  const plannedExternal = planMentionLinks(base.body, external.map(entry), { budget: o.externalBudget, minWordsBetween: o.minWordsBetween, alreadyLinked: (u) => haveExternal.has(u), takenBlocks: o.takenBlocks });
  return [...plannedInternal, ...plannedExternal].map((p, i) => {
    const isInternal = p.entry.url.startsWith("/");
    return {
      id: `c${o.startAt + i}`,
      type: isInternal ? ("internal_link" as const) : ("external_link" as const),
      location: { blockId: p.blockId, headingPath: p.headingPath || null, field: null },
      before: p.anchor,
      after: `[${p.anchor}](${p.entry.url})`,
      rationale: `Keyword link from your list: first mention of “${p.anchor}” → ${p.entry.url}${isInternal ? "" : " (nofollow)"}.`,
      evidenceRef: [`keyword:${p.entry.key.slice(3)}`],
      sourceUrls: isInternal ? [] : [p.entry.url],
      origin: "rules" as const,
      decision: "pending" as const,
      edited: null,
      flags: [],
      target: isInternal ? p.entry.url.split("#")[0]!.replace(/\/+$/, "") : p.entry.url,
    };
  });
}
