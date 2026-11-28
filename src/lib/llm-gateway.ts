/**
 * LiteLLM as the gateway for this web app's own model calls (D-109; the SEO agent's are in seo-agent/app/llm_gateway.py).
 *
 * With LITELLM_BASE_URL (its OpenAI-compatible API, …/v1) and LITELLM_API_KEY set, the web app's text calls go to
 * LiteLLM instead of to each provider: the SEO drafts and keyword intents (lib/seo-intel/claude.ts), the SEO enrichment
 * (lib/seo-intel/llm.ts) and the Python practice tutor (lib/practice/ai/tutor.ts). AI visibility still asks each
 * assistant itself (it measures those assistants), and images and video are made by their providers directly.
 *
 * - Models are LiteLLM aliases: a Claude Haiku id is asked as `moks-cms-fast`, any other Claude id as
 *   `moks-cms-default`, any other name as it is (LITELLM_MODEL_DEFAULT / LITELLM_MODEL_FAST rename the two). The
 *   tutor asks for LITELLM_MODEL_PRACTICE (the fast alias unless set). Which provider and model answer is set in LiteLLM.
 * - Budgets are LiteLLM's: the SEO calls use LITELLM_API_KEY, the tutor LITELLM_PRACTICE_API_KEY (its own budget;
 *   the SEO key when unset), all in the team "jithendar.com". LiteLLM refuses a call over a budget with HTTP 422
 *   `budget_exceeded` (GatewayBudgetError here). The usage rows record what LiteLLM charged (x-litellm-response-cost).
 * Keys never leave this module's requests: not in a message, a log line or an error.
 */

export type LlmGateway = {
  /** …/v1 */
  baseUrl: string;
  /** LiteLLM's own routes (/key/info) are at the root. */
  root: string;
  seoKey: string;
  practiceKey: string;
  modelDefault: string;
  modelFast: string;
  modelPractice: string;
};

type Env = Record<string, string | undefined>;

export function llmGateway(env: Env = process.env): LlmGateway | null {
  const baseUrl = (env.LITELLM_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const seoKey = (env.LITELLM_API_KEY ?? "").trim();
  if (!baseUrl || !seoKey) return null;
  const modelFast = env.LITELLM_MODEL_FAST?.trim() || "moks-cms-fast";
  return {
    baseUrl,
    root: baseUrl.endsWith("/v1") ? baseUrl.slice(0, -3) : baseUrl,
    seoKey,
    practiceKey: env.LITELLM_PRACTICE_API_KEY?.trim() || seoKey,
    modelDefault: env.LITELLM_MODEL_DEFAULT?.trim() || "moks-cms-default",
    modelFast,
    modelPractice: env.LITELLM_MODEL_PRACTICE?.trim() || modelFast,
  };
}

/** The alias LiteLLM is asked for: a Claude id by its tier, any other name as it is. */
export function gatewayModel(gw: LlmGateway, model: string | null | undefined): string {
  const m = (model ?? "").trim();
  if (m.startsWith("claude-")) return m.includes("haiku") ? gw.modelFast : gw.modelDefault;
  return m || gw.modelDefault;
}

/** LiteLLM refused a call: the budget of the key or of its team is used up. */
export class GatewayBudgetError extends Error {
  readonly code = "budget";
  constructor(
    message: string,
    readonly scope: "key" | "team",
  ) {
    super(message);
  }
}

function errorOf(body: unknown): { message: string; type: string | null } {
  const err = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  if (err && typeof err === "object") {
    const e = err as { message?: unknown; type?: unknown; code?: unknown };
    return { message: typeof e.message === "string" ? e.message.slice(0, 400) : "", type: typeof e.type === "string" ? e.type : typeof e.code === "string" ? e.code : null };
  }
  return { message: "", type: null };
}

/** LiteLLM's answer to a call over a budget (HTTP 422/400, error.type budget_exceeded) as GatewayBudgetError; else null. */
export function budgetRefusal(status: number, body: unknown, caller: string): GatewayBudgetError | null {
  const { message, type } = errorOf(body);
  if (type !== "budget_exceeded" && !/budget has been exceeded/i.test(message)) return null;
  const team = /Team=/.test(message);
  const spent = message.includes("Current cost:") ? ` (${message.split("Current cost:")[1]!.trim()})` : "";
  return new GatewayBudgetError(
    `LiteLLM refused the call: the budget of ${team ? "the jithendar.com team" : caller} is used up${spent}. Raise it or wait for its reset in LiteLLM (https://jithendar.com/llm/ui).`,
    team ? "team" : "key",
  );
}

/** LiteLLM's message and type for any other refusal (never the key). */
export function gatewayErrorText(status: number, body: unknown): string {
  const { message, type } = errorOf(body);
  return `LiteLLM: ${message || `HTTP ${status}`} (HTTP ${status}${type ? ` ${type}` : ""})`;
}

export type GatewayKeyView = {
  caller: "seo" | "practice";
  alias: string | null;
  spendUsd: number | null;
  maxBudgetUsd: number | null;
  budgetDuration: string | null;
  budgetResetAt: string | null;
  models: string[];
};

/** LiteLLM's view of this web app's keys (read with each key itself; spend trails the last calls by up to a minute). */
export async function gatewayKeys(gw: LlmGateway, fetchImpl: typeof fetch = fetch): Promise<{ keys: GatewayKeyView[]; errors: string[] }> {
  const callers: ["seo" | "practice", string][] = [["seo", gw.seoKey]];
  if (gw.practiceKey !== gw.seoKey) callers.push(["practice", gw.practiceKey]);
  const keys: GatewayKeyView[] = [];
  const errors: string[] = [];
  for (const [caller, key] of callers) {
    try {
      const res = await fetchImpl(`${gw.root}/key/info`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8_000) });
      const info = res.ok ? ((await res.json()) as { info?: Record<string, unknown> }).info : undefined;
      if (!info) throw new Error(`HTTP ${res.status}`);
      const num = (v: unknown) => (typeof v === "number" ? v : null);
      const str = (v: unknown) => (typeof v === "string" ? v : null);
      keys.push({ caller, alias: str(info.key_alias), spendUsd: num(info.spend), maxBudgetUsd: num(info.max_budget), budgetDuration: str(info.budget_duration), budgetResetAt: str(info.budget_reset_at), models: Array.isArray(info.models) ? info.models.filter((m): m is string => typeof m === "string") : [] });
    } catch {
      errors.push(`LiteLLM did not describe the ${caller === "seo" ? "web app's SEO" : "Practice tutor's"} key.`);
    }
  }
  return { keys, errors };
}
