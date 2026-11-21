import type { ReactNode } from "react";
import AgentLimitsSection from "./agent-limits";
import AskTheBlogSection from "./ask-the-blog";
import LlmBudgetSection from "./llm-budget";
import LlmProvidersSection from "./llm-providers";
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
 * The sections of Admin → AI & SEO → Settings (/admin/automation?section=<id>), in the order the list shows them.
 * One file per section, so two changes to different sections do not touch the same file. Only the open section is
 * rendered: each loads its own data and saves on its own.
 *
 * The ids of the eight SEO areas are the tab ids of lib/seo-intel/settings-meta.ts, so an old #tab-<id> link maps
 * straight onto ?section=<id>.
 */
export type AiSeoSection = { id: string; label: string; /** Called by the page (not drawn as an element), so it may be async and must not nest another async component. */ render: () => ReactNode | Promise<ReactNode> };

export const AI_SEO_SECTIONS: AiSeoSection[] = [
  { id: "overview", label: "Overview", render: OverviewSection },
  { id: "llm-providers", label: "LLM providers & models", render: LlmProvidersSection },
  { id: "llm-budget", label: "LLM budget", render: LlmBudgetSection },
  { id: "agent-limits", label: "Agent limits", render: AgentLimitsSection },
  { id: "ask-the-blog", label: "Ask the Blog", render: AskTheBlogSection },
  { id: "ml", label: "ML & retrieval", render: MlSection },
  { id: "mcp", label: "MCP", render: McpSection },
  { id: "data", label: "Data sources", render: SeoDataSection },
  { id: "schedules", label: "Schedules", render: SeoSchedulesSection },
  { id: "scoring", label: "Scoring & rules", render: SeoScoringSection },
  { id: "content", label: "Content & links", render: SeoContentSection },
  { id: "ai", label: "AI & drafts", render: SeoAiSection },
  { id: "crawler", label: "Crawler", render: SeoCrawlerSection },
  { id: "reports", label: "Reports", render: SeoReportsSection },
  { id: "runs", label: "Run history", render: SeoRunsSection },
];

export const AI_SEO_SETTINGS_PATH = "/admin/automation";
