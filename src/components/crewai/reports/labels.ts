/** Short names for the report categories (chips in the library and the viewer); full names are in lib/reports/catalog.ts. */
export const CATEGORY_SHORT: Record<string, string> = {
  crewai: "CrewAI",
  seo: "SEO",
  traffic: "Traffic",
  search: "Keywords",
  content: "Content",
  editorial: "Editorial",
  quality: "Quality",
  ai_usage: "AI usage",
  llm_cost: "LLM cost",
  reliability: "Reliability",
  agents: "Agents",
  rag: "RAG",
  technical: "Technical",
  operations: "Operations",
  business: "Business",
};
export const kb = (bytes: number) => (bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
export const duration = (ms: number | null) => (ms === null ? "—" : ms >= 60_000 ? `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s` : `${Math.max(1, Math.round(ms / 1000))} s`);
