import type { ReactNode } from "react";
import AgentLimitsSection from "./agent-limits";
import AskTheBlogSection from "./ask-the-blog";
import LlmSection from "./llm";
import McpSection from "./mcp";
import MlSection from "./ml";
import OverviewSection from "./overview";
import SeoAiSection from "./seo-ai";
import SeoContentSection from "./seo-content";
import SeoCrawlerSection from "./seo-crawler";
import SeoDataSection from "./seo-data";
import SeoReportsSection from "./seo-reports";
import SeoRunsSection from "./seo-runs";
import SeoSchedulesSection from "./seo-schedules";
import SeoScoringSection from "./seo-scoring";

/**
 * The sections of Admin → AI & SEO → Settings (/admin/automation?section=<id>), in the order the list shows them,
 * under four headings (owner, 2026-11-23): the agent itself, the models it calls, how outside assistants reach the
 * site, and the SEO settings by area. One file per section, so two changes to different sections do not touch the
 * same file. Only the open section is rendered: each loads its own data and saves on its own.
 *
 * The ids of the seven SEO areas and Run history are the tab ids of lib/seo-intel/settings-meta.ts, so an old
 * #tab-<id> link maps straight onto ?section=<id>. Sections that were merged keep their old id as an alias
 * (paths.ts SECTION_ALIASES), so a bookmark still opens the right place.
 */
export type AiSeoSection = {
  id: string;
  label: string;
  /** The heading the section is listed under. */
  group: AiSeoGroup;
  /** Called by the page with the address's query (not drawn as an element), so it may be async and must not nest another async component. */
  render: (params: Record<string, string | undefined>) => ReactNode | Promise<ReactNode>;
};

export type AiSeoGroup = "SEO agent" | "Models & AI" | "Assistants" | "SEO";

export const AI_SEO_SECTIONS: AiSeoSection[] = [
  { id: "overview", label: "Overview", group: "SEO agent", render: OverviewSection },
  { id: "agent-limits", label: "Agent limits", group: "SEO agent", render: AgentLimitsSection },
  { id: "runs", label: "Run history", group: "SEO agent", render: SeoRunsSection },
  { id: "llm", label: "LLM providers & budget", group: "Models & AI", render: LlmSection },
  { id: "ai", label: "AI & drafts", group: "Models & AI", render: SeoAiSection },
  { id: "ml", label: "ML & retrieval", group: "Models & AI", render: MlSection },
  { id: "ask-the-blog", label: "Ask the Blog", group: "Assistants", render: AskTheBlogSection },
  { id: "mcp", label: "MCP", group: "Assistants", render: McpSection },
  { id: "data", label: "Data sources", group: "SEO", render: SeoDataSection },
  { id: "schedules", label: "Schedules", group: "SEO", render: SeoSchedulesSection },
  { id: "scoring", label: "Scoring & rules", group: "SEO", render: SeoScoringSection },
  { id: "content", label: "Content & links", group: "SEO", render: SeoContentSection },
  { id: "crawler", label: "Crawler", group: "SEO", render: SeoCrawlerSection },
  { id: "reports", label: "Reports", group: "SEO", render: SeoReportsSection },
];

export { AI_SEO_SETTINGS_PATH, aiSeoSectionHref, aliasTarget, SECTION_ALIASES } from "./paths";
