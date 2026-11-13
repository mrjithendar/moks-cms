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

type Block = { type: string; position?: { start: { offset?: number }; end: { offset?: number } } };

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
  return rest ? { preview: `${preview}\n`, rest: `${rest}\n` } : { preview: body, rest: "" };
}
