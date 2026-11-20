import { AgentError, getAgentSettings, type AgentSettingsView } from "./client";

/**
 * Settings the seo-agent lets an admin change (Admin → Automation & AI). The agent owns them: its registry says which
 * fields exist, it validates a save, stores it in its own table and applies it (moks-seo-agent/app/admin_settings).
 * This app only shows the agent's answer and hands a save to it. Nothing is kept here.
 */
export type AgentSettingsLoad = {
  /** The agent's answer, or null with `error` when it cannot be asked. */
  view: AgentSettingsView | null;
  error: string | null;
  /** The agent answered, but it is a release from before it had these settings. */
  tooOld: boolean;
};

export const TOO_OLD_MESSAGE = "This needs a newer seo-agent: the one running does not have admin-editable settings yet. Release and restart the seo-agent.";

export async function loadAgentSettings(): Promise<AgentSettingsLoad> {
  try {
    const view = await getAgentSettings();
    // An older agent has no such route (404), or something else answered in its place.
    if (!view || !Array.isArray(view.groups)) return { view: null, error: TOO_OLD_MESSAGE, tooOld: true };
    return { view, error: null, tooOld: false };
  } catch (e) {
    if (e instanceof AgentError && (e.status === 404 || e.status === 405)) return { view: null, error: TOO_OLD_MESSAGE, tooOld: true };
    return { view: null, error: e instanceof AgentError ? e.message : "The SEO agent could not be asked.", tooOld: false };
  }
}
