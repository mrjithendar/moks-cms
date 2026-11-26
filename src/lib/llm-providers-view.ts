import { AgentError, getLlmModels, getLlmProviders, type AgentLlmModel, type AgentLlmProvidersView } from "./seo-agent/client";

/**
 * Admin → AI & SEO → Settings → LLM providers & budget (the providers card). Providers, keys and models belong to the seo-agent, which
 * makes the LLM calls: it stores them (keys sealed with its own key), validates a save and never sends a key back
 * (seo-agent/app/llm_providers). This app only shows the agent's answer and hands a save to it.
 */
export type LlmProvidersLoad = {
  view: AgentLlmProvidersView | null;
  error: string | null;
  /** The agent answered, but it is a release from before it had providers. */
  tooOld: boolean;
};

export const PROVIDERS_TOO_OLD = "This needs a newer seo-agent: the one running cannot store providers and models yet. Release and restart the seo-agent.";

export async function loadLlmProviders(): Promise<LlmProvidersLoad> {
  try {
    const view = await getLlmProviders();
    if (!view || !Array.isArray(view.providers) || !Array.isArray(view.kinds)) return { view: null, error: PROVIDERS_TOO_OLD, tooOld: true };
    return { view, error: null, tooOld: false };
  } catch (e) {
    if (e instanceof AgentError && (e.status === 404 || e.status === 405)) return { view: null, error: PROVIDERS_TOO_OLD, tooOld: true };
    return { view: null, error: e instanceof AgentError ? e.message : "The SEO agent could not be asked.", tooOld: false };
  }
}

export type LlmModelsLoad = { models: AgentLlmModel[]; error: string | null; tooOld: boolean };

/** For ModelPicker: the models that may be chosen. Empty with a reason when the agent cannot be asked. */
export async function loadLlmModels(): Promise<LlmModelsLoad> {
  try {
    const r = await getLlmModels();
    if (!r || !Array.isArray(r.models)) return { models: [], error: PROVIDERS_TOO_OLD, tooOld: true };
    return { models: r.models, error: null, tooOld: false };
  } catch (e) {
    if (e instanceof AgentError && (e.status === 404 || e.status === 405)) return { models: [], error: PROVIDERS_TOO_OLD, tooOld: true };
    return { models: [], error: e instanceof AgentError ? e.message : "The SEO agent could not be asked.", tooOld: false };
  }
}
