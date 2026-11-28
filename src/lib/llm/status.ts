import "server-only";
import { checkLlm, llmConfig, llmMissing, llmUsage, type LlmConfig, type LlmHealth, type LlmKeyView, type LlmTeamView } from "./client";
import { AgentError, getLlmStatus, type AgentLlmStatus } from "../seo-agent/client";

/**
 * Settings → AI & models → LiteLLM (D-110), and the alias pickers: what the web app and the SEO agent each see of
 * LiteLLM, read only. Budgets, models and provider keys are changed in LiteLLM's own Admin UI; nothing here holds or
 * shows a key (and never LiteLLM's master key).
 */
export type LlmStatusLoad = {
  web: { config: Pick<LlmConfig, "baseUrl" | "model" | "modelFast" | "modelPractice"> | null; missing: string[]; health: LlmHealth; usage: { keys: LlmKeyView[]; team: LlmTeamView | null; errors: string[] } | null };
  agent: AgentLlmStatus | null;
  agentError: string | null;
  uiUrl: string | null;
};

export async function loadLlmStatus(): Promise<LlmStatusLoad> {
  const cfg = llmConfig();
  const [health, usage, agent] = await Promise.all([
    checkLlm({ config: cfg }),
    cfg ? llmUsage({ config: cfg }) : Promise.resolve(null),
    getLlmStatus().then(
      (a) => ({ a, e: null as string | null }),
      (e) => ({ a: null, e: e instanceof AgentError && (e.status === 404 || e.status === 405) ? "The SEO agent running is older than D-110 (no GET /llm-status): release and restart it." : e instanceof AgentError ? e.message : "The SEO agent could not be asked." }),
    ),
  ]);
  return {
    web: { config: cfg ? { baseUrl: cfg.baseUrl, model: cfg.model, modelFast: cfg.modelFast, modelPractice: cfg.modelPractice } : null, missing: llmMissing(), health, usage },
    agent: agent.a,
    agentError: agent.e,
    uiUrl: cfg?.uiUrl ?? (process.env.LITELLM_UI_URL?.trim() || null),
  };
}

/** The aliases a crew, flow or profile may name: what LiteLLM lists for the agent's key (it runs them), else the web app's. */
export async function loadAliases(): Promise<{ aliases: string[]; defaults: { default: string; fast: string } | null; error: string | null }> {
  const agent = await getLlmStatus().catch(() => null);
  const web = agent?.models.length ? null : await checkLlm();
  const names = new Set<string>();
  for (const m of agent?.models ?? []) if (m.name) names.add(m.name);
  for (const a of web?.aliases ?? []) names.add(a);
  const defaults = agent?.aliases ?? (llmConfig() ? { default: llmConfig()!.model, fast: llmConfig()!.modelFast } : null);
  if (defaults) for (const a of [defaults.default, defaults.fast]) names.add(a);
  names.delete("all-proxy-models");
  return { aliases: [...names].sort(), defaults, error: names.size ? null : agent?.errors[0] ?? web?.error ?? "LiteLLM could not be asked for its aliases." };
}
