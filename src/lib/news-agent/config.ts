/**
 * The news agent's secrets (mrjithendar/newsroom; the news desk's engine since 2026-11-21, image news-agent:latest).
 * Like the seo-agent's, two different secrets, so one leaked direction is not both.
 */
type Env = Record<string, string | undefined>;

/** Web app → news agent bearer token (its NEWS_AGENT_TOKEN). */
export const newsAgentToken = (env: Env = process.env) => env.NEWS_AGENT_TOKEN?.trim() || null;
/**
 * News agent → web app callback bearer token. The callback server accepts it on the news agent's routes only
 * (internal-server.ts NEWS_AGENT_ROUTES), never on drafts, publishing or reports.
 */
export const newsCallbackToken = (env: Env = process.env) => env.NEWS_AGENT_CALLBACK_TOKEN?.trim() || null;
