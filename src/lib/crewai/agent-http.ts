import "server-only";
import { AgentError } from "../seo-agent/client";
import { SeoApiError } from "../seo-intel/http";

/** An SEO agent error as the console's API answers it: the agent's 4xx with its reason and issues, otherwise 503. */
export function agentApiError(e: unknown): never {
  if (e instanceof AgentError) throw new SeoApiError(e.message, [400, 403, 404, 409, 422, 429].includes(e.status) ? e.status : 503, "agent", e.issues);
  throw e;
}
