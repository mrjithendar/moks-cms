import remarkDirective from "remark-directive";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import type { Root, RootContent } from "mdast";
import { z } from "zod";

/**
 * Draft change sets (v2 Phase 1): a list of atomic, individually reviewable changes against one base version of an
 * article. Pure module (no I/O) shared by generation, validation, the diff view and publishing.
 *
 * Locations are block ids of the base body ("b12" = the 13th top-level Markdown block), plus the heading path for
 * humans. Change mechanics:
 * - title / meta_description: field values (seoTitle / seoDescription); `before` must equal the current value.
 * - paragraph_edit, internal_link, alt_text: replace `before` (must occur exactly once in the block) with `after`.
 * - heading: replace the heading text (level kept). code_block: replace a whole fenced block.
 * - paragraph_add: insert `after` as new block(s) after the block (`before` is empty).
 * - schema: not produced; JSON-LD is derived from fields, so its diff is computed (see diff-model.ts).
 */
export const CHANGE_TYPES = ["title", "meta_description", "heading", "paragraph_edit", "paragraph_add", "code_block", "internal_link", "external_link", "link_fix", "alt_text", "schema"] as const;
export type ChangeType = (typeof CHANGE_TYPES)[number];
/** What Claude may propose. Internal links come only from the deterministic planner (internal-links.ts). */
export const MODEL_CHANGE_TYPES = ["title", "meta_description", "heading", "paragraph_edit", "paragraph_add", "code_block", "alt_text"] as const;

export type FlagSeverity = "error" | "warning";
export type Flag = { code: string; severity: FlagSeverity; message: string; changeId?: string };

export type Change = {
  id: string;
  type: ChangeType;
  location: { blockId: string | null; headingPath: string | null; field: "seoTitle" | "seoDescription" | null };
  before: string;
  after: string;
  rationale: string;
  /** Recommendation ids ("rec:<uuid>") and evidence rows ("ev:<uuid>") this change rests on. */
  evidenceRef: string[];
  sourceUrls: string[];
  origin: "claude" | "rules";
  decision: "pending" | "accepted" | "rejected";
  /** The reviewer's own version of `after` (accepted with edits). */
  edited: string | null;
  flags: Flag[];
  /** For internal links: the target path (used by limits and the link graph). */
  target?: string;
};

export type Fields = { title: string; description: string; seoTitle: string | null; seoDescription: string | null };
export type BaseSnapshot = Fields & { body: string; collection: string; slug: string; version: number; updatedAt?: string | null };

export type BlockKind = "heading" | "paragraph" | "code" | "list" | "blockquote" | "table" | "html" | "thematicBreak" | "directive" | "other";
export type Block = { id: string; kind: BlockKind; depth?: number; lang?: string | null; headingPath: string; start: number; end: number; source: string; hasImage: boolean; firstSentenceEnd?: number };

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkDirective);

export function parseMarkdown(body: string): Root {
  return parser.parse(body) as Root;
}

const kindOf = (n: RootContent): BlockKind => {
  switch (n.type) {
    case "heading":
    case "paragraph":
    case "code":
    case "list":
    case "blockquote":
    case "table":
    case "html":
    case "thematicBreak":
      return n.type;
    case "containerDirective":
    case "leafDirective":
      return "directive";
    default:
      return "other";
  }
};

export function headingText(n: RootContent): string {
  const out: string[] = [];
  visit(n, (c) => {
    if (c.type === "text" || c.type === "inlineCode") out.push((c as { value: string }).value);
  });
  return out.join("").trim();
}

/** Top-level blocks with stable ids and the heading path above each (e.g. "Setup › Install"). */
export function blocksOf(body: string): Block[] {
  const tree = parseMarkdown(body);
  const path: { depth: number; text: string }[] = [];
  return tree.children.map((n, i) => {
    const start = n.position?.start.offset ?? 0;
    const end = n.position?.end.offset ?? start;
    if (n.type === "heading") {
      while (path.length && path[path.length - 1]!.depth >= n.depth) path.pop();
      path.push({ depth: n.depth, text: headingText(n) });
    }
    let hasImage = false;
    visit(n, "image", () => {
      hasImage = true;
    });
    return {
      id: `b${i}`,
      kind: kindOf(n),
      ...(n.type === "heading" ? { depth: n.depth } : {}),
      ...(n.type === "code" ? { lang: n.lang ?? null } : {}),
      headingPath: path.map((p) => p.text).join(" › "),
      start,
      end,
      source: body.slice(start, end),
      hasImage,
    };
  });
}

/** Fenced code blocks (language + content), in order: used to prove code was left untouched. */
export function codeBlocksOf(body: string): { lang: string | null; value: string }[] {
  const out: { lang: string | null; value: string }[] = [];
  visit(parseMarkdown(body), "code", (n) => {
    out.push({ lang: n.lang ?? null, value: n.value });
  });
  return out;
}

/**
 * Broken-link fixes (link_fix): point every inline link / <autolink> to `oldUrl` in `md` at `newUrl`, or unwrap it to
 * its text when `newUrl` is null (autolinks can only be replaced). Images are never touched.
 */
export function rewriteLink(md: string, oldUrl: string, newUrl: string | null): string {
  const esc = oldUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let out = md.replace(new RegExp(`(?<!!)\\[([^\\]]*)\\]\\(\\s*<?${esc}>?(\\s+"[^"]*")?\\s*\\)`, "g"), (_m, text: string, title?: string) => (newUrl ? `[${text}](${newUrl}${title ?? ""})` : text));
  if (newUrl) out = out.replace(new RegExp(`<${esc}>`, "g"), `<${newUrl}>`);
  return out;
}

export function linksIn(markdown: string): string[] {
  const out: string[] = [];
  visit(parseMarkdown(markdown), "link", (n) => {
    out.push(n.url);
  });
  return out;
}

const countOccurrences = (hay: string, needle: string) => {
  if (!needle) return 0;
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
};

export const effectiveAfter = (c: Change) => c.edited ?? c.after;
export const isActive = (c: Change) => c.decision !== "rejected";

export type ApplyResult = { body: string; fields: Fields; conflicts: string[] };

/**
 * Apply the active (non-rejected) changes to the base. Changes that no longer apply (their `before` vanished
 * because an earlier change in the same block rewrote it) are reported as conflicts and skipped.
 */
export function applyChanges(base: BaseSnapshot, changes: Change[]): ApplyResult {
  const blocks = blocksOf(base.body);
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const fields: Fields = { title: base.title, description: base.description, seoTitle: base.seoTitle, seoDescription: base.seoDescription };
  const conflicts: string[] = [];
  const blockText = new Map<string, string>();
  const inserts = new Map<string, string[]>();
  for (const c of changes.filter(isActive)) {
    const after = effectiveAfter(c);
    if (c.type === "title") fields.seoTitle = after.trim();
    else if (c.type === "meta_description") fields.seoDescription = after.trim();
    else if (c.type === "schema") continue;
    else {
      const b = c.location.blockId ? byId.get(c.location.blockId) : undefined;
      if (!b) {
        conflicts.push(c.id);
        continue;
      }
      if (c.type === "paragraph_add") {
        inserts.set(b.id, [...(inserts.get(b.id) ?? []), after.trim()]);
        continue;
      }
      const cur = blockText.get(b.id) ?? b.source;
      if (c.type === "code_block") {
        if (cur !== b.source) conflicts.push(c.id);
        else blockText.set(b.id, after.trim());
      } else if (c.type === "heading") {
        const m = /^(#{1,6})\s+/.exec(cur);
        if (!m || headingText(parseMarkdown(cur).children[0]!) !== c.before.trim()) conflicts.push(c.id);
        else blockText.set(b.id, `${m[1]} ${after.trim()}`);
      } else if (countOccurrences(cur, c.before) !== 1) conflicts.push(c.id);
      else blockText.set(b.id, cur.replace(c.before, () => after));
    }
  }
  let body = base.body;
  for (const b of [...blocks].reverse()) {
    const text = blockText.get(b.id) ?? b.source;
    const add = inserts.get(b.id);
    const replacement = add?.length ? `${text}\n\n${add.join("\n\n")}` : text;
    if (replacement !== b.source) body = body.slice(0, b.start) + replacement + body.slice(b.end);
  }
  return { body, fields, conflicts };
}

// --- Model output ---------------------------------------------------------------------------------------------

/** JSON schema sent as `output_config.format` (every property required; "" = not applicable). */
export const MODEL_OUTPUT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "changes"],
  properties: {
    summary: { type: "string", description: "One or two sentences: what this draft changes and why." },
    changes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "block_id", "before", "after", "rationale", "evidence_ref", "source_urls"],
        properties: {
          type: { type: "string", enum: [...MODEL_CHANGE_TYPES] },
          block_id: { type: "string", description: 'Block id from the article data (e.g. "b12"); "" for title and meta_description.' },
          before: { type: "string" },
          after: { type: "string" },
          rationale: { type: "string" },
          evidence_ref: { type: "array", items: { type: "string" } },
          source_urls: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

export const modelOutputSchema = z.object({
  summary: z.string().max(1000),
  changes: z
    .array(
      z.object({
        type: z.enum(MODEL_CHANGE_TYPES),
        block_id: z.string().max(12),
        before: z.string().max(20_000),
        after: z.string().max(20_000),
        rationale: z.string().min(1).max(1500),
        evidence_ref: z.array(z.string().max(80)).max(20),
        source_urls: z.array(z.string().url().max(500)).max(10),
      }),
    )
    .max(40),
});
export type ModelOutput = z.infer<typeof modelOutputSchema>;

/** Model output → changes (ids assigned by the caller's numbering). Locations resolved against the base. */
export function toChanges(out: ModelOutput, base: BaseSnapshot, startAt = 1): Change[] {
  const blocks = new Map(blocksOf(base.body).map((b) => [b.id, b]));
  return out.changes.map((c, i) => ({
    id: `c${startAt + i}`,
    type: c.type,
    location: {
      blockId: c.type === "title" || c.type === "meta_description" ? null : c.block_id || null,
      headingPath: blocks.get(c.block_id)?.headingPath ?? null,
      field: c.type === "title" ? "seoTitle" : c.type === "meta_description" ? "seoDescription" : null,
    },
    before: c.before,
    after: c.after,
    rationale: c.rationale.trim(),
    evidenceRef: c.evidence_ref,
    sourceUrls: c.source_urls,
    origin: "claude",
    decision: "pending",
    edited: null,
    flags: [],
  }));
}

// --- Validation -------------------------------------------------------------------------------------------------

export type ValidationContext = {
  /** Effective search titles of every other article (lower-cased) for the duplicate check. */
  otherTitles: Set<string>;
  /** Paths that exist (published, indexable) for internal links. */
  knownPaths: Set<string>;
  maxRewriteRatio: number;
  /** Categories this draft works on; expansion/freshness/new_article allow larger rewrites. */
  categories: string[];
  linkLimits: { wordsPerLink: number };
  /** external_link targets that may be added (the official-docs allowlist, external-links.ts). Empty = none. */
  externalAllow?: ReadonlySet<string>;
};

export type ValidationResult = {
  /** Structural problems with the model output: the generation is retried once, then marked failed. */
  errors: string[];
  /** Per-change and draft-level flags shown to the reviewer. Severity "error" blocks approval of that change. */
  flags: Flag[];
  rewriteRatio: number;
};

export const SERP_TITLE_SOFT_MAX = 60;
export const META_SOFT_MAX = 155;
const STOP = new Set("a an and are as at be by for from how in into is it of on or the to with your you what why when vs".split(" "));
const words = (s: string) => s.toLowerCase().match(/[a-z0-9][a-z0-9+#.-]*/g) ?? [];
export const effectiveTitle = (f: Fields) => (f.seoTitle?.trim() || f.title).trim();
export const effectiveMeta = (f: Fields) => (f.seoDescription?.trim() || f.description).trim();

/** A content word repeated ≥ `max` times reads as stuffing. */
export function stuffedWords(text: string, max: number): string[] {
  const counts = new Map<string, number>();
  for (const w of words(text)) if (w.length > 2 && !STOP.has(w)) counts.set(w, (counts.get(w) ?? 0) + 1);
  return [...counts].filter(([, n]) => n >= max).map(([w]) => w);
}

/** Version numbers, inline code / commands and URLs a text introduces that the original article does not contain. */
export function newTechnicalTokens(after: string, original: string): { versions: string[]; commands: string[]; urls: string[] } {
  const versions = [...new Set(after.match(/\bv?\d+\.\d+(?:\.\d+)*(?:-[a-z0-9.]+)?\b/gi) ?? [])].filter((v) => !original.includes(v));
  const commands = [...new Set([...after.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!.trim()))].filter((c) => !original.includes(c));
  const urls = [...new Set([...(after.match(/https?:\/\/[^\s)<>\]"']+/g) ?? []), ...linksIn(after).filter((u) => /^https?:/.test(u))])].filter((u) => !original.includes(u));
  return { versions, commands, urls };
}

/** Share of the body's words removed or inserted (0–1+), on whitespace-normalised word sequences. */
export function rewriteRatio(before: string, after: string, diffWords: (a: string, b: string) => { added?: boolean; removed?: boolean; value: string }[]): number {
  const total = words(before).length || 1;
  let changed = 0;
  for (const part of diffWords(before, after)) if (part.added || part.removed) changed += words(part.value).length;
  return changed / total;
}

const EXPANSION = new Set(["striking_expansion", "freshness", "new_article"]);

/**
 * Validate a change set against its base. `diffWords` is injected (jsdiff) so this module stays dependency-light
 * for the browser bundle.
 */
export function validateChangeSet(base: BaseSnapshot, changes: Change[], ctx: ValidationContext, diffWords: Parameters<typeof rewriteRatio>[2]): ValidationResult {
  const errors: string[] = [];
  const flags: Flag[] = [];
  const blocks = new Map(blocksOf(base.body).map((b) => [b.id, b]));
  const original = `${base.title}\n${base.description}\n${base.seoTitle ?? ""}\n${base.seoDescription ?? ""}\n${base.body}`;
  const flag = (c: Change | null, code: string, severity: FlagSeverity, message: string) => {
    const f: Flag = { code, severity, message, ...(c ? { changeId: c.id } : {}) };
    flags.push(f);
    c?.flags.push(f);
  };
  for (const c of changes) c.flags = [];

  for (const c of changes) {
    const after = effectiveAfter(c);
    const label = `${c.id} (${c.type})`;
    if (!after.trim() && c.type !== "alt_text") errors.push(`${label}: "after" is empty`);
    if (after === c.before) errors.push(`${label}: "after" is identical to "before"`);
    if (c.type === "title" || c.type === "meta_description") {
      const current = c.type === "title" ? effectiveTitle(base) : effectiveMeta(base);
      if (c.before.trim() !== current) errors.push(`${label}: "before" must be the current ${c.type === "title" ? "search title" : "meta description"} exactly`);
      if (/[\n#*`[\]]/.test(after)) errors.push(`${label}: plain text only (no Markdown or line breaks)`);
      const len = after.trim().length;
      if (c.type === "title") {
        if (len > SERP_TITLE_SOFT_MAX) flag(c, "title_length", "warning", `Search title is ${len} characters; Google usually truncates around ${SERP_TITLE_SOFT_MAX}.`);
        if (ctx.otherTitles.has(after.trim().toLowerCase())) flag(c, "duplicate_title", "error", "Another article already uses this exact search title.");
        const stuffed = stuffedWords(after, 3);
        if (stuffed.length) flag(c, "keyword_stuffing", "warning", `Repeats "${stuffed.join('", "')}" — reads as keyword stuffing.`);
      } else {
        if (len > META_SOFT_MAX) flag(c, "meta_length", "warning", `Meta description is ${len} characters; snippets are usually cut around ${META_SOFT_MAX}.`);
        if (len < 70) flag(c, "meta_length", "warning", `Meta description is only ${len} characters.`);
        const stuffed = stuffedWords(after, 4);
        if (stuffed.length) flag(c, "keyword_stuffing", "warning", `Repeats "${stuffed.join('", "')}" — reads as keyword stuffing.`);
      }
      continue;
    }
    if (c.type === "schema") {
      errors.push(`${label}: schema changes are derived from fields and cannot be proposed directly`);
      continue;
    }
    const b = c.location.blockId ? blocks.get(c.location.blockId) : undefined;
    if (!b) {
      errors.push(`${label}: unknown block "${c.location.blockId ?? ""}"`);
      continue;
    }
    if (c.type === "heading") {
      if (b.kind !== "heading") errors.push(`${label}: block ${b.id} is not a heading`);
      else if (headingText(parseMarkdown(b.source).children[0]!) !== c.before.trim()) errors.push(`${label}: "before" must be the heading's current text`);
      if (/\n|^#/.test(after.trim())) errors.push(`${label}: give the heading text only (one line, no #)`);
    } else if (c.type === "code_block") {
      if (b.kind !== "code") errors.push(`${label}: block ${b.id} is not a code block`);
      else if (c.before.trim() !== b.source.trim()) errors.push(`${label}: "before" must be the whole code block`);
      if (!/^(```|~~~)/.test(after.trim())) errors.push(`${label}: "after" must be a fenced code block`);
    } else if (c.type === "paragraph_add") {
      if (c.before) errors.push(`${label}: "before" must be empty for an insertion`);
      if (/^\s*(```|~~~)/m.test(after)) errors.push(`${label}: new code blocks need a code_block change and a source`);
      if (/^#\s/m.test(after)) errors.push(`${label}: no H1 headings in the body`);
    } else {
      // paragraph_edit, internal_link, alt_text: an exact, unique substring of the block.
      if (!["paragraph", "list", "blockquote", "table"].includes(b.kind)) errors.push(`${label}: block ${b.id} (${b.kind}) cannot be edited this way`);
      const n = countOccurrences(b.source, c.before);
      if (n !== 1) errors.push(`${label}: "before" must occur exactly once in block ${b.id} (found ${n})`);
      if (/^\s*(```|~~~)|^#{1,6}\s/m.test(after)) errors.push(`${label}: an edit cannot add code blocks or headings`);
      if (c.type === "alt_text") {
        const src = (s: string) => /!\[[^\]]*\]\(\s*<?([^)\s>]+)/.exec(s)?.[1];
        if (!src(c.before) || src(c.before) !== src(after)) errors.push(`${label}: alt-text changes must keep the same image`);
      }
    }
    // Links: Claude never adds internal links (the planner does); external URLs only with a cited source.
    const newLinks = linksIn(after).filter((u) => !linksIn(c.before).includes(u));
    if (c.origin === "claude" && newLinks.some((u) => u.startsWith("/"))) errors.push(`${label}: internal links are added by the link planner, not in prose edits`);
    if (c.type === "internal_link" && c.target && !ctx.knownPaths.has(c.target)) errors.push(`${label}: link target ${c.target} is not a published, indexable page`);
    // link_fix: the broken-link checker's one-click fix. target = the broken URL, sourceUrls[0] = the replacement ("" =
    // unlink); "after" must be exactly "before" with that link rewritten, nothing else.
    if (c.type === "link_fix" && (c.origin !== "rules" || !c.target || effectiveAfter(c) !== rewriteLink(c.before, c.target, c.sourceUrls[0] || null) || effectiveAfter(c) === c.before)) errors.push(`${label}: a link fix may only re-point or unlink the broken link`);
    if (c.type === "external_link" && (c.origin !== "rules" || !c.target || !ctx.externalAllow?.has(c.target) || effectiveAfter(c) !== `[${c.before}](${c.target})`)) errors.push(`${label}: external links come only from the official-docs allowlist, linking the existing text`);
    const fresh = newTechnicalTokens(after, original);
    const invented = fresh.urls.filter((u) => !c.sourceUrls.includes(u));
    if (invented.length) errors.push(`${label}: introduces URLs that are neither in the article nor cited as sources: ${invented.join(", ")}`);
    if ((fresh.versions.length || fresh.commands.length) && c.sourceUrls.length === 0) {
      flag(c, "needs_fact_check", "warning", `New technical detail without a source (${[...fresh.versions, ...fresh.commands].slice(0, 5).join(", ")}): verify before accepting.`);
    } else if (c.sourceUrls.length && c.type !== "internal_link" && c.type !== "external_link" && c.type !== "link_fix") {
      flag(c, "verify_source", "warning", `Cites ${c.sourceUrls.length} source(s); check they support the change.`);
    }
  }
  if (errors.length) return { errors, flags, rewriteRatio: 0 };

  // Whole-draft checks on the result.
  const applied = applyChanges(base, changes);
  for (const id of applied.conflicts) {
    const c = changes.find((x) => x.id === id);
    flag(c ?? null, "conflict", "error", "This change no longer applies because another change rewrote the same text.");
  }
  try {
    parseMarkdown(applied.body);
  } catch {
    errors.push("the edited body is no longer valid Markdown");
  }
  const editsCode = changes.some((c) => c.type === "code_block" && isActive(c));
  if (!editsCode && JSON.stringify(codeBlocksOf(applied.body)) !== JSON.stringify(codeBlocksOf(base.body))) errors.push("code blocks changed without an explicit code_block change");
  const ratio = rewriteRatio(base.body, applied.body, diffWords);
  if (ratio > ctx.maxRewriteRatio && !ctx.categories.some((c) => EXPANSION.has(c))) {
    flag(null, "large_rewrite", "warning", `Rewrites ${(ratio * 100).toFixed(0)}% of the body (limit ${(ctx.maxRewriteRatio * 100).toFixed(0)}%), more than its recommendations call for.`);
  }
  const bodyWords = words(applied.body.replace(/(```|~~~)[\s\S]*?\1/g, "")).length;
  const internalLinks = linksIn(applied.body).filter((u) => u.startsWith("/") && !u.startsWith("/media/")).length;
  const cap = Math.max(1, Math.floor(bodyWords / ctx.linkLimits.wordsPerLink));
  const linkChanges = changes.filter((c) => c.type === "internal_link" && isActive(c));
  if (linkChanges.length && internalLinks > cap) for (const c of linkChanges) flag(c, "link_density", "error", `The article would have ${internalLinks} internal links; the cap is 1 per ${ctx.linkLimits.wordsPerLink} words (${cap}).`);
  return { errors, flags, rewriteRatio: ratio };
}

/** Title/meta/alt/link-only changes do not count as a substantive content update (sitemap <lastmod> stays). */
export function isSubstantive(changes: Change[]): boolean {
  return changes.some((c) => isActive(c) && ["heading", "paragraph_edit", "paragraph_add", "code_block"].includes(c.type));
}
