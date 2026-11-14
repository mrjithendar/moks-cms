import remarkDirective from "remark-directive";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

/**
 * Members-only articles. A post marked "members only" shows signed-out readers the first part of its body and a
 * prompt to sign in or create an account; any signed-in reader gets the whole article.
 *
 * How much is shown: a percentage of the article's text. The site default is set by an admin (Admin → Advanced
 * settings → Members-only articles, MEMBERS_PREVIEW_PERCENT, 30 when unset) and a single post can override it in
 * the editor. The cut is made **between blocks**, never inside a paragraph, list, table or code block, so the
 * preview is the smallest run of whole blocks that reaches the percentage.
 *
 * The rest of the article is never sent to a signed-out reader: the public page is rendered from the preview only
 * and the remainder is loaded by a server action that checks the session (app/_actions/members.tsx).
 */
export const DEFAULT_PREVIEW_PERCENT = 30;
export const MIN_PREVIEW_PERCENT = 5;
export const MAX_PREVIEW_PERCENT = 95;

const clamp = (n: number) => Math.min(Math.max(Math.round(n), MIN_PREVIEW_PERCENT), MAX_PREVIEW_PERCENT);

/** The site default from settings (anything unusable falls back to 30). */
export function sitePreviewPercent(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.MEMBERS_PREVIEW_PERCENT);
  return Number.isFinite(n) && n > 0 ? clamp(n) : DEFAULT_PREVIEW_PERCENT;
}

/** The percentage for one post: its own setting when it has one, otherwise the site default. */
export function previewPercentFor(postPercent: number | null | undefined, siteDefault: number): number {
  return typeof postPercent === "number" && Number.isFinite(postPercent) ? clamp(postPercent) : clamp(siteDefault);
}

export type MembersSplit = { preview: string; rest: string };

type Block = { type: string; identifier?: string; children?: Block[]; position?: { start: { offset?: number }; end: { offset?: number } } };

/** `[label]: https://…` and `[^note]: …`, written once (usually at the end) and referred to from anywhere. */
const DEFINITIONS: Record<string, string> = { definition: "link", footnoteDefinition: "footnote" };
const REFERENCES: Record<string, string> = { linkReference: "link", imageReference: "link", footnoteReference: "footnote" };

type Definition = { text: string; start: number; end: number; node: Block };

/** "link:label" / "footnote:label" for every definition these blocks refer to. */
function referencesIn(blocks: Block[], found = new Set<string>()): Set<string> {
  for (const b of blocks) {
    const kind = REFERENCES[b.type];
    if (kind && b.identifier) found.add(`${kind}:${b.identifier}`);
    if (b.children) referencesIn(b.children, found);
  }
  return found;
}

/**
 * Append the definitions one half refers to but does not contain. The two halves are rendered on their own, so a
 * reference whose definition fell on the other side of the cut would show as literal `[text][label]`.
 * Only what the half itself refers to is added (following references inside a definition), so the public preview
 * never receives a footnote that is only cited behind the gate.
 */
function withDefinitions(half: string, blocks: Block[], definitions: Map<string, Definition>, contains: (d: Definition) => boolean): string {
  const missing: Definition[] = [];
  const seen = new Set<string>();
  const queue = [...referencesIn(blocks)];
  for (let key = queue.pop(); key !== undefined; key = queue.pop()) {
    if (seen.has(key)) continue;
    seen.add(key);
    const d = definitions.get(key);
    if (!d) continue;
    if (!contains(d)) missing.push(d);
    queue.push(...referencesIn(d.node.children ?? []));
  }
  if (missing.length === 0) return half;
  missing.sort((a, b) => a.start - b.start);
  return `${half.trimEnd()}\n\n${missing.map((d) => d.text).join("\n\n")}\n`;
}

/**
 * Split a Markdown body into the public preview and the members-only rest. `rest` is empty when the article is too
 * short to split (a single block), in which case the whole article is public.
 */
export function splitForMembers(body: string, percent: number): MembersSplit {
  const tree = unified().use(remarkParse).use(remarkGfm).use(remarkDirective).parse(body) as { children: Block[] };
  // Link and footnote definitions carry no reading text and may sit anywhere; they never decide the cut.
  const blocks = tree.children.filter((b) => b.type !== "definition" && b.type !== "footnoteDefinition" && typeof b.position?.end.offset === "number");
  if (blocks.length < 2) return { preview: body, rest: "" };
  const size = (b: Block) => (b.position!.end.offset ?? 0) - (b.position!.start.offset ?? 0);
  const total = blocks.reduce((n, b) => n + size(b), 0);
  const target = (total * clamp(percent)) / 100;
  let shown = 0;
  let cut = -1;
  // At least one block is shown and at least one is held back.
  for (let i = 0; i < blocks.length - 1; i++) {
    shown += size(blocks[i]!);
    cut = blocks[i]!.position!.end.offset!;
    if (shown >= target) break;
  }
  // A heading left dangling at the end of the preview belongs with the text it introduces.
  const last = blocks.filter((b) => b.position!.end.offset! <= cut);
  if (last.length > 1 && last.at(-1)!.type === "heading") cut = last.at(-2)!.position!.end.offset!;
  const preview = body.slice(0, cut).trimEnd();
  const rest = body.slice(cut).trim();
  if (!rest) return { preview: body, rest: "" };

  // The first definition of a label wins, as in Markdown.
  const definitions = new Map<string, Definition>();
  for (const node of tree.children) {
    const kind = DEFINITIONS[node.type];
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (!kind || !node.identifier || typeof start !== "number" || typeof end !== "number") continue;
    const key = `${kind}:${node.identifier}`;
    if (!definitions.has(key)) definitions.set(key, { text: body.slice(start, end), start, end, node });
  }
  const shownBlocks = blocks.filter((b) => b.position!.end.offset! <= cut);
  const heldBlocks = blocks.filter((b) => b.position!.end.offset! > cut);
  return {
    preview: withDefinitions(`${preview}\n`, shownBlocks, definitions, (d) => d.end <= cut),
    rest: withDefinitions(`${rest}\n`, heldBlocks, definitions, (d) => d.start >= cut),
  };
}
