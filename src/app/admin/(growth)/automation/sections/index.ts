import type { ReactNode } from "react";
import AgentLimitsSection from "./agent-limits";
import AskTheBlogSection from "./ask-the-blog";
import McpSection from "./mcp";
import MlSection from "./ml";
import SeoAiSection from "./seo-ai";
import SeoContentSection from "./seo-content";
import SeoCrawlerSection from "./seo-crawler";
import SeoDataSection from "./seo-data";
import SeoReportsSection from "./seo-reports";
import SeoRunsSection from "./seo-runs";
import SeoSchedulesSection from "./seo-schedules";
import SeoScoringSection from "./seo-scoring";

/**
 * The SEO agent's settings sections (AI & SEO → Settings, /admin/automation, until 2026-11-26). They are drawn in the
 * Settings area now, each under its category (lib/settings-areas.ts: AI & models, SEO agent, Assistants, Search & SEO),
 * and only while the SEO agent module is set up. One file per section, so two changes to different sections do not
 * touch the same file; only the open section is rendered, and each loads its own data and saves on its own.
 *
 * The ids of the seven SEO areas and Run history are the tab ids of lib/seo-intel/settings-meta.ts.
 */
export type SectionRender = (params: Record<string, string | undefined>) => ReactNode | Promise<ReactNode>;

export const AI_SEO_RENDERS: Record<string, SectionRender> = {
  "agent-limits": AgentLimitsSection,
  runs: SeoRunsSection,
  ai: SeoAiSection,
  ml: MlSection,
  "ask-the-blog": AskTheBlogSection,
  mcp: McpSection,
  data: SeoDataSection,
  schedules: SeoSchedulesSection,
  scoring: SeoScoringSection,
  content: SeoContentSection,
  crawler: SeoCrawlerSection,
  reports: SeoReportsSection,
};
