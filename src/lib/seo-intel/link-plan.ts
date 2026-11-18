import type { Db } from "@/db";
import type { BaseSnapshot, Change } from "./changeset";
import { renumber, validationContext } from "./drafts";
import { externalLinksIn, planExternalLinks } from "./external-links";
import { internalLinksOf, linkChangesFor, proseWords } from "./internal-links";
import { keywordLinkChanges, listKeywords } from "./link-keywords";
import type { SeoSettings } from "./settings";
import { siteOrigin } from "./urls";

/**
 * Every link planner for one article, in priority order (one new link per paragraph across all of them):
 *   1. the owner's keyword links (link-keywords.ts),
 *   2. related articles (internal-links.ts planner, every limit),
 *   3. official docs (external-links.ts).
 * `mode: "auto"` uses the conservative weekly limits; `mode: "editor"` (suggestions a person chooses from) proposes
 * more candidates: up to 8 internal and 5 external, no spacing rule, still never in headings/code/captions/first
 * sentence and never past the density cap.
 */
export async function planArticleLinks(db: Db, s: SeoSettings, base: BaseSnapshot, articleId: string, mode: "auto" | "editor"): Promise<Change[]> {
  if (!s.links.enabled) return [];
  const editor = mode === "editor";
  const origin = siteOrigin().origin;
  const selfPath = `/${base.collection}/${base.slug}`;
  const links = editor ? { ...s.links, maxNewPerDraft: 8, minWordsBetween: 0, maxInboundPerTargetPerRun: 1_000 } : s.links;
  const externalMax = editor ? 5 : s.links.auto.maxExternalPerArticle;
  const words = proseWords(base.body);
  const densityLeft = Math.floor(words / s.links.wordsPerLink) - internalLinksOf(base.body).length;
  const internalBudget = Math.max(0, Math.min(links.maxNewPerDraft, densityLeft));
  const externalBudget = Math.max(0, externalMax - externalLinksIn(base.body, origin).length);
  const taken = new Set<string>();

  const ctx = await validationContext(db, s, articleId, ["internal_links"]);
  const keywords = keywordLinkChanges(base, await listKeywords(db, { enabledOnly: true }), { selfPath, knownPaths: ctx.knownPaths, internalBudget, externalBudget, minWordsBetween: links.minWordsBetween, origin, takenBlocks: taken, startAt: 1 });
  const kwInternal = keywords.filter((c) => c.type === "internal_link").length;
  const kwExternal = keywords.length - kwInternal;
  const kwTargets = new Set(keywords.map((c) => c.target));

  const related: Change[] = [];
  if (internalBudget - kwInternal > 0 && words >= 150) {
    for (const c of await linkChangesFor(db, { ...s, links }, base, articleId, editor ? ["editor:suggestions"] : ["auto:links"], 1)) {
      if (related.length >= internalBudget - kwInternal) break;
      const block = c.location.blockId ?? "";
      if (taken.has(block) || kwTargets.has(c.target)) continue;
      taken.add(block);
      related.push(c);
    }
  }

  const docsBudget = externalBudget - kwExternal;
  const docs = docsBudget > 0 && words >= 150
    ? planExternalLinks(base.body, { maxExternalPerArticle: docsBudget + externalLinksIn(base.body, origin).length, minWordsBetween: links.minWordsBetween }, origin, undefined, taken).planned.map((p) => ({
        id: "c0",
        type: "external_link" as const,
        location: { blockId: p.blockId, headingPath: p.headingPath || null, field: null },
        before: p.anchor,
        after: `[${p.anchor}](${p.entry.url})`,
        rationale: `First mention of ${p.anchor}: link to the official ${p.entry.title} (nofollow).`,
        evidenceRef: [],
        sourceUrls: [p.entry.url],
        origin: "rules" as const,
        decision: "pending" as const,
        edited: null,
        flags: [],
        target: p.entry.url,
      }))
    : [];
  return renumber([...keywords, ...related, ...docs]);
}
