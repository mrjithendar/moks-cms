import "server-only";
import * as news from "../news-agent/client";
import * as seo from "../seo-agent/client";
import type { AgentCrew, AgentFlow } from "../seo-agent/client";

/**
 * The CrewAI console talks to two agents since the news desk became its own service (2026-11-21): the seo-agent
 * (moks-seo-agent) and the news agent (mrjithendar/newsroom). Both write the same run tables, so the console's lists and
 * run pages read the database as before; every action goes to the agent that owns the flow or the crew:
 *
 * - news_* flows, and a crew test run of the `news` crew → the news agent;
 * - everything else → the seo-agent.
 *
 * The agents' catalogues say the same with an "agent" field on each flow and crew; an older seo-agent without it is
 * read as "seo".
 */
import { agentOfCrew, agentOfFlow, NEWS_CREWS, type AgentId } from "./agent-of";

export { AGENT_LABEL, agentOfCrew, agentOfFlow, NEWS_CREWS, type AgentId } from "./agent-of";

type Started = { run_id: string; status: string; existing: boolean };
type KickoffOpts = { triggeredBy?: "manual" | "cron"; actor?: string };

export function kickoffFor(flow: string, inputs: Record<string, unknown>, opts: KickoffOpts = {}): Promise<Started> {
  return agentOfFlow(flow, inputs) === "news" ? news.kickoff(flow as news.NewsAgentFlowName, inputs, opts) : seo.kickoff(flow as seo.FlowName, inputs, opts);
}

export function cancelRunFor(runId: string, flow: string, inputs?: Record<string, unknown> | null): Promise<{ status: string }> {
  return agentOfFlow(flow, inputs) === "news" ? news.cancelRun(runId) : seo.cancelRun(runId);
}

export function validateFlowInputsFor(flow: string, inputs: Record<string, unknown>): Promise<{ inputs: Record<string, unknown> }> {
  return agentOfFlow(flow, inputs) === "news" ? news.validateFlowInputs(flow, inputs) : seo.validateFlowInputs(flow, inputs);
}

export function validateCrewConfigFor(crew: string, config: Record<string, unknown>): Promise<{ config: Record<string, unknown>; default_hash: string; prompt_version: string }> {
  return agentOfCrew(crew) === "news" ? news.validateCrewConfig(crew, config) : seo.validateCrewConfig(crew, config);
}

export type ConsoleFlow = AgentFlow & { agent: AgentId };
export type ConsoleCrew = AgentCrew & { agent: AgentId };

const tagged = <T extends { agent?: unknown }>(items: T[], fallback: AgentId): (T & { agent: AgentId })[] => items.map((i) => ({ ...i, agent: i.agent === "news" || i.agent === "seo" ? i.agent : fallback }));

/**
 * Both agents' flows by name (null for an agent that is off or not found: its entries are left out and the pages say
 * so). crew_test_flow exists in both; the seo-agent's entry is kept (its Test runs start from Crews, never from here).
 */
export async function bothFlows(): Promise<{ flows: Map<string, ConsoleFlow>; reachable: Record<AgentId, boolean> }> {
  const [s, n] = await Promise.all([seo.flowCatalogue().then((r) => r.items, () => null), news.flowCatalogue().then((r) => r.items, () => null)]);
  const flows = new Map<string, ConsoleFlow>();
  for (const f of tagged(s ?? [], "seo")) flows.set(f.name, f);
  for (const f of tagged(n ?? [], "news")) if (!flows.has(f.name)) flows.set(f.name, f);
  return { flows, reachable: { seo: s !== null, news: n !== null } };
}

/** Both agents' crews (code defaults). */
export async function bothCrews(): Promise<{ crews: ConsoleCrew[]; reachable: Record<AgentId, boolean> }> {
  const [s, n] = await Promise.all([seo.crewCatalogue().then((r) => r.items, () => null), news.crewCatalogue().then((r) => r.items, () => null)]);
  return { crews: [...tagged(s ?? [], "seo"), ...tagged(n ?? [], "news").filter((c) => NEWS_CREWS.has(c.crew))], reachable: { seo: s !== null, news: n !== null } };
}
