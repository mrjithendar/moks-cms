/**
 * An agent's answer as an error, for both agents the web app calls: the seo-agent (lib/seo-agent/client.ts) and the
 * news agent (lib/news-agent/client.ts). It carries the agent's status, never its internals; an agent that is off or
 * not found is a 503. `issues` is the agent's own list of problems (a 422 for crew configuration or flow inputs).
 */
export class AgentError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The agent's own list of problems (a 422 for crew configuration or flow inputs), when it sent one. */
    readonly issues: string[] = [],
  ) {
    super(message);
  }
}
