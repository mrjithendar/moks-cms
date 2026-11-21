import "server-only";
import { crewCatalogue, flowCatalogue, type AgentCrew, type AgentFlow } from "../seo-agent/client";

/** The agent's flow catalogue by name, or null while the agent is off (pages still render from the database). */
export async function agentFlows(): Promise<Map<string, AgentFlow> | null> {
  try {
    return new Map((await flowCatalogue()).items.map((f) => [f.name, f]));
  } catch {
    return null;
  }
}

/** The agent's crews (code defaults), or null while the agent is off. */
export async function agentCrews(): Promise<AgentCrew[] | null> {
  try {
    return (await crewCatalogue()).items;
  } catch {
    return null;
  }
}
