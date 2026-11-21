import "server-only";
import { bothCrews, bothFlows, type ConsoleCrew, type ConsoleFlow } from "./agents";

/**
 * Both agents' flow catalogues by name (lib/crewai/agents.ts), or null while neither answers (pages still render from
 * the database). An agent that is off simply has no entries.
 */
export async function agentFlows(): Promise<Map<string, ConsoleFlow> | null> {
  const { flows, reachable } = await bothFlows();
  return reachable.seo || reachable.news ? flows : null;
}

/** Both agents' crews (code defaults), or null while neither answers. */
export async function agentCrews(): Promise<ConsoleCrew[] | null> {
  const { crews, reachable } = await bothCrews();
  return reachable.seo || reachable.news ? crews : null;
}
