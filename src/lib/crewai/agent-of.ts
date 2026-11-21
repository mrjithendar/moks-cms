/**
 * Which agent owns a flow, a crew or a run (no I/O, so client components and SQL filters can use it too). Since the news
 * desk became its own service (2026-11-21, mrjithendar/newsroom) the CrewAI console talks to two agents:
 * news_* flows and the `news` crew's test runs are the news agent's, everything else the seo-agent's.
 */
export type AgentId = "seo" | "news";
export const AGENT_IDS: readonly AgentId[] = ["seo", "news"];
export const AGENT_LABEL: Record<AgentId, string> = { seo: "SEO agent", news: "News agent" };
export const NEWS_CREWS: ReadonlySet<string> = new Set(["news"]);

export const agentOfCrew = (crew: string): AgentId => (NEWS_CREWS.has(crew) ? "news" : "seo");

export function agentOfFlow(flow: string, inputs?: Record<string, unknown> | null): AgentId {
  if (flow.startsWith("news_")) return "news";
  if (flow === "crew_test_flow" && typeof inputs?.crew === "string") return agentOfCrew(inputs.crew);
  return "seo";
}
