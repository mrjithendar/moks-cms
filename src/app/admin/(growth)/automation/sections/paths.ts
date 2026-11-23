/**
 * Addresses of AI & SEO → Settings, apart from the section list (index.ts imports every section, and a section that
 * links to another imports this file, not index.ts).
 */
export const AI_SEO_SETTINGS_PATH = "/admin/automation";

/**
 * Old section ids → where they live now, and the element to scroll to. "LLM providers & models" and "LLM budget"
 * became one section, and so did "MCP" and "MCP access" (owner, 2026-11-23).
 */
export const SECTION_ALIASES: Record<string, { section: string; anchor: string }> = {
  "llm-providers": { section: "llm", anchor: "llm-providers" },
  "llm-budget": { section: "llm", anchor: "llm-budget" },
  "mcp-access": { section: "mcp", anchor: "mcp-clients-h" },
};

/** The address of a section (and optionally an element in it): `/admin/automation?section=llm#llm-budget`. */
export const aiSeoSectionHref = (section: string, anchor?: string) => `${AI_SEO_SETTINGS_PATH}?section=${encodeURIComponent(section)}${anchor ? `#${anchor}` : ""}`;

/**
 * Where an old section id (and the rest of its query, such as &scope=day) now lives, or null for a current id. The
 * page redirects there, so a bookmark or a link in an old e-mail still opens the right card.
 */
export function aliasTarget(query: Record<string, string | undefined>): string | null {
  const alias = query.section ? SECTION_ALIASES[query.section] : undefined;
  if (!alias) return null;
  const params = new URLSearchParams();
  params.set("section", alias.section);
  for (const [k, v] of Object.entries(query)) if (k !== "section" && v !== undefined) params.set(k, v);
  return `${AI_SEO_SETTINGS_PATH}?${params.toString()}#${alias.anchor}`;
}
