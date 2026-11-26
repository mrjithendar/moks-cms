import "server-only";
import { agentToken } from "@/lib/seo-agent/config";
import { agentBaseUrl } from "@/lib/seo-agent/endpoint";
import { AgentError, reserveLlmBudget, settleLlmBudget, type AgentDeps } from "@/lib/seo-agent/client";
import { log } from "../log";

/**
 * The one LLM budget, for the LLM calls this web app makes itself (drafts on the legacy path, keyword intents, the
 * weekly batch, AI visibility). The budget lives in the seo-agent (seo-agent/app/llm_budgets.py); this web app
 * keeps no limit of its own. Before a call: `reserve` the call's upper bound (POST /llm-budget/reserve). After the
 * usage row is written: `settle` (POST /llm-budget/settle), and from then on the row is the spend.
 *
 * What happens when the budget cannot be asked:
 * - no seo-agent is set up (no SEO_AGENT_TOKEN or no endpoint): the call is allowed. There is no budget anywhere.
 * - the seo-agent is older than the one budget (404/405): the call is allowed, with a warning in the log.
 * - the seo-agent is set up but does not answer: the call is refused. A limit that cannot be checked is not skipped.
 */
export type GateAnswer = { ok: true; id: string | null } | { ok: false; detail: string };
export type LlmGate = { reserve(maxUsd: number, purpose: string): Promise<GateAnswer>; settle(id: string | null): Promise<void> };

/** Purposes are lower-case names the agent accepts ([a-z][a-z0-9_.-]{1,60}). */
export const gatePurpose = (purpose: string) => {
  const p = purpose.toLowerCase().replace(/[^a-z0-9_.-]/g, "_").slice(0, 60);
  return /^[a-z]/.test(p) && p.length >= 2 ? p : `web_${p}`.slice(0, 60);
};

export const UNCHECKED = "The LLM budget could not be checked: the seo-agent did not answer. No call was made.";

export function agentGate(deps: AgentDeps = {}): LlmGate {
  return {
    async reserve(maxUsd, purpose) {
      if (!agentToken(deps.env)) return { ok: true, id: null };
      try {
        if (!(await agentBaseUrl(deps))) return { ok: true, id: null };
      } catch {
        return { ok: false, detail: UNCHECKED };
      }
      try {
        const r = await reserveLlmBudget(Math.min(1000, Math.max(0, maxUsd)), gatePurpose(purpose), deps);
        return { ok: true, id: typeof r.id === "string" ? r.id : null };
      } catch (e) {
        if (e instanceof AgentError && e.status === 402) return { ok: false, detail: e.message };
        if (e instanceof AgentError && (e.status === 404 || e.status === 405)) {
          log.warn("llm budget not checked: the seo-agent is older than the one budget", { operation: "llm_budget", outcome: "too_old" });
          return { ok: true, id: null };
        }
        log.warn("llm budget could not be checked", { operation: "llm_budget", outcome: "error", errorCode: e instanceof AgentError ? String(e.status) : "unknown" });
        return { ok: false, detail: UNCHECKED };
      }
    },
    async settle(id) {
      if (!id) return;
      try {
        await settleLlmBudget(id, deps);
      } catch {
        /* the hold lapses on its own (moks-seo-agent HOLD_SECONDS) */
      }
    },
  };
}

/** For tests and callers that have already been admitted. */
export const OPEN_GATE: LlmGate = { reserve: async () => ({ ok: true, id: null }), settle: async () => undefined };
