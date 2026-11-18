import { diffWords } from "diff";
import { z } from "zod";
import type { Db } from "@/db";
import { applyChanges, blocksOf, CHANGE_TYPES, validateChangeSet, type Change } from "./changeset";
import { loadBase, validationContext } from "./drafts";
import { ALLOWED_EXTERNAL_URLS } from "./external-links";
import { listKeywords } from "./link-keywords";
import { planArticleLinks } from "./link-plan";
import type { SeoSettings } from "./settings";

/**
 * Link suggestions in the post editor (Link Whisper-style; owner decision 2026-11-10). Planned against the editor's
 * CURRENT text (unsaved edits included) with the same planners as the weekly auto-linker, but more candidates for a
 * person to choose from. Inserting one goes through the change validator and applyChanges on the server, so a
 * suggestion can only ever wrap existing words in a link to an allowed target. Nothing is saved: the editor gets the
 * new body back and the author saves as usual.
 */
export type Suggestion = Change & { kind: "keyword" | "related" | "docs"; excerpt: string };

const MAX_BODY = 200_000;
export const suggestInput = z.object({ postId: z.string().uuid(), body: z.string().max(MAX_BODY) });
export const applyInput = z.object({
  postId: z.string().uuid(),
  body: z.string().max(MAX_BODY),
  change: z.object({
    id: z.string().max(20),
    type: z.enum(CHANGE_TYPES),
    location: z.object({ blockId: z.string().nullable(), headingPath: z.string().nullable(), field: z.null() }),
    before: z.string().max(500),
    after: z.string().max(1200),
    target: z.string().max(500),
  }),
});

function excerptOf(body: string, c: Change): string {
  const b = blocksOf(body).find((x) => x.id === c.location.blockId);
  if (!b) return c.before;
  const i = b.source.indexOf(c.before);
  const from = Math.max(0, i - 70);
  const to = Math.min(b.source.length, i + c.before.length + 70);
  return `${from > 0 ? "…" : ""}${b.source.slice(from, to).replace(/\s+/g, " ")}${to < b.source.length ? "…" : ""}`;
}

export async function suggestLinks(db: Db, s: SeoSettings, input: z.output<typeof suggestInput>): Promise<Suggestion[]> {
  const base = { ...(await loadBase(db, input.postId)), body: input.body };
  const changes = await planArticleLinks(db, s, base, input.postId, "editor");
  return changes.map((c) => ({
    ...c,
    kind: c.evidenceRef.some((e) => e.startsWith("keyword:")) ? "keyword" : c.type === "internal_link" ? "related" : "docs",
    excerpt: excerptOf(input.body, c),
  }));
}

export class SuggestionError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Apply one suggestion to the editor's body (validated like a draft change). Returns the new body. */
export async function applySuggestion(db: Db, s: SeoSettings, input: z.output<typeof applyInput>): Promise<string> {
  const c = input.change;
  if (c.type !== "internal_link" && c.type !== "external_link") throw new SuggestionError("Only link suggestions can be inserted here.", 400);
  if (c.after !== `[${c.before}](${c.target})` && !(c.type === "internal_link" && c.after.startsWith(`[${c.before}](${c.target}#`))) throw new SuggestionError("That suggestion has been changed; refresh the suggestions.", 400);
  const base = { ...(await loadBase(db, input.postId)), body: input.body };
  const change: Change = { ...c, rationale: "", evidenceRef: [], sourceUrls: c.type === "external_link" ? [c.target] : [], origin: "rules", decision: "accepted", edited: null, flags: [] };
  const keywordUrls = (await listKeywords(db, { enabledOnly: true })).map((k) => k.url);
  const ctx = { ...(await validationContext(db, s, input.postId, ["internal_links"])), externalAllow: new Set([...ALLOWED_EXTERNAL_URLS, ...keywordUrls]) };
  const v = validateChangeSet(base, [change], ctx, diffWords);
  if (v.errors.length) throw new SuggestionError(`That link can't be inserted any more (${v.errors[0]}). Refresh the suggestions.`, 409);
  const out = applyChanges(base, [change]);
  if (out.conflicts.length) throw new SuggestionError("The text changed since the suggestion was made; refresh the suggestions.", 409);
  return out.body;
}
