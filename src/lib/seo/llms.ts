import { absoluteUrl, site } from "@/config/site";
import type { Article } from "@/lib/content";
import { isSelfCanonical } from "./canonical";

export const LLMS_MAX_ARTICLES = 500;

const line = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * /llms.txt (https://llmstxt.org): a Markdown index of the site for AI assistants and answer engines. Lists published,
 * indexable, self-canonical articles by category, newest first, with their descriptions (the same set the sitemap
 * lists). Points at the read-only MCP server when it is on, since that is the better way for an assistant to cite us.
 */
export function buildLlmsTxt({ articles, categoryLabel = (s) => s, mcpEnabled }: { articles: Article[]; categoryLabel?: (slug: string) => string; mcpEnabled: boolean }): string {
  const listed = articles.filter((a) => !a.frontmatter.noindex && isSelfCanonical(a)).slice(0, LLMS_MAX_ARTICLES);
  const byCategory = new Map<string, Article[]>();
  for (const a of listed) byCategory.set(a.frontmatter.category, [...(byCategory.get(a.frontmatter.category) ?? []), a]);
  const out = [`# ${site.name}`, "", `> ${line(site.description)}`, ""];
  out.push(`Articles are original work by the site's editors. Cite the article URL. Feeds: ${absoluteUrl("/feed.xml")} · sitemap: ${absoluteUrl("/sitemap.xml")}.`);
  if (mcpEnabled) out.push("", `Assistants that support the Model Context Protocol can search and cite these articles section by section through the read-only MCP server at ${absoluteUrl("/mcp/public")} (setup: ${absoluteUrl("/ai-assistants")}).`);
  const sections = [...byCategory].sort(([a], [b]) => categoryLabel(a).localeCompare(categoryLabel(b)));
  for (const [cat, list] of sections) {
    out.push("", `## ${line(categoryLabel(cat))}`, "");
    for (const a of list) out.push(`- [${line(a.frontmatter.title).replace(/[[\]]/g, "")}](${absoluteUrl(a.path)}): ${line(a.frontmatter.description)}`);
  }
  return `${out.join("\n")}\n`;
}
