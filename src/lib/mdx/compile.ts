import { evaluate } from "@mdx-js/mdx";
import rehypeShiki from "@shikijs/rehype";
import type { MDXContent } from "mdx/types";
import type { ShikiTransformer } from "shiki";
import * as runtime from "react/jsx-runtime";
import rehypeSlug from "rehype-slug";
import remarkDirective from "remark-directive";
import remarkGfm from "remark-gfm";
import { collectHeadings, demoteH1, type Heading } from "./headings";
import { remarkShortcodes } from "./shortcodes";
import { rehypeSafeUrls } from "./safe-urls";
import { rehypeTableScroll } from "./tables";

/** Expose each fence's language on <pre data-language> so CodeBlock can label the block. */
const languageAttribute: ShikiTransformer = {
  pre(node) {
    node.properties["data-language"] = this.options.lang;
  },
};

/**
 * Fence meta (opt-in, per block): ```ts title="lib/x.ts" {2,4-6}
 * - title= / filename= → <pre data-title>, shown by CodeBlock in the block's header;
 * - {ranges} → the listed lines get class "highlighted" (styled in globals.css). Blocks without meta are unchanged.
 */
export function fenceMeta(raw: string | undefined): { title: string | null; lines: Set<number> } {
  const m = raw ?? "";
  const t = /\b(?:title|filename)=(?:"([^"]{1,120})"|'([^']{1,120})'|([^\s{}]{1,120}))/.exec(m);
  const lines = new Set<number>();
  const r = /\{([\d,\s-]{1,200})\}/.exec(m)?.[1];
  for (const part of r ? r.split(",") : []) {
    const [a, b] = part.trim().split("-").map(Number);
    if (!Number.isInteger(a) || a! < 1) continue;
    for (let i = a!; i <= Math.min((Number.isInteger(b) ? b! : a!), a! + 500); i++) lines.add(i);
  }
  return { title: t ? (t[1] ?? t[2] ?? t[3]!) : null, lines };
}

const fenceMetaTransformer: ShikiTransformer = {
  name: "fence-meta",
  pre(node) {
    const { title } = fenceMeta((this.options.meta as { __raw?: string } | undefined)?.__raw);
    if (title) node.properties["data-title"] = title;
  },
  line(node, line) {
    const { lines } = fenceMeta((this.options.meta as { __raw?: string } | undefined)?.__raw);
    if (lines.has(line)) {
      this.addClassToHast(node, "highlighted");
      node.properties["data-highlighted"] = "";
    }
  },
};

export type CompiledMdx = { Content: MDXContent; headings: Heading[] };

const compiled = new Map<string, CompiledMdx>();
const MAX_CACHED = 300;

/**
 * Compile article/page bodies on the server: heading ids + TOC and syntax highlighting (no client JS).
 * Bodies are compiled as plain Markdown (`format: "md"`): JSX, JavaScript expressions and raw HTML are
 * NOT executed, so authors and API keys can never run code on the server. Results are memoised by body.
 */
export async function compileMdx(source: string): Promise<CompiledMdx> {
  const hit = compiled.get(source);
  if (hit) return hit;
  const headings: Heading[] = [];
  const { default: Content } = await evaluate(source, {
    ...runtime,
    format: "md",
    development: false,
    // GFM: tables, strikethrough, task lists, autolinks.
    remarkPlugins: [remarkGfm, remarkDirective, remarkShortcodes],
    rehypePlugins: [
      demoteH1,
      rehypeSlug,
      rehypeTableScroll,
      rehypeSafeUrls,
      collectHeadings(headings),
      [
        rehypeShiki,
        {
          themes: { light: "github-light", dark: "github-dark" },
          lazy: true,
          fallbackLanguage: "text",
          transformers: [languageAttribute, fenceMetaTransformer],
        },
      ],
    ],
  });
  const result = { Content, headings };
  if (compiled.size >= MAX_CACHED) compiled.delete(compiled.keys().next().value!);
  compiled.set(source, result);
  return result;
}
