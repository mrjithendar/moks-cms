import { AgentError } from "../agent-error";
import type { AgentSettingsLoad } from "../seo-agent/settings-client";
import { getNewsAgentSettings } from "./client";

/**
 * The news agent's settings (Newsroom → Settings → News agent): its Claude key (sealed), default models, limits and the
 * embeddings connection. The news agent owns them (mrjithendar/newsroom app/admin_settings); this app shows its answer
 * and hands a save to it.
 */
export const NEWS_TOO_OLD = "This needs a newer news agent: the one running does not have admin-editable settings yet. Release and restart it.";

export async function loadNewsAgentSettings(): Promise<AgentSettingsLoad> {
  try {
    const view = await getNewsAgentSettings();
    if (!view || !Array.isArray(view.groups)) return { view: null, error: NEWS_TOO_OLD, tooOld: true };
    return { view, error: null, tooOld: false };
  } catch (e) {
    if (e instanceof AgentError && (e.status === 404 || e.status === 405)) return { view: null, error: NEWS_TOO_OLD, tooOld: true };
    return { view: null, error: e instanceof AgentError ? e.message : "The news agent could not be asked.", tooOld: false };
  }
}
