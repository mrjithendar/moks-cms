# AI News Desk: where things run

Since 2026-11-21 the news desk's engine is its own service, the **news agent**
([mrjithendar/newsroom](https://github.com/mrjithendar/newsroom), image `news-agent:latest`). Its own docs cover the
flows, the data model, the ML, the quality gates, covers and costs:
[ARCHITECTURE](https://github.com/mrjithendar/newsroom/blob/master/docs/ARCHITECTURE.md) · [ML](https://github.com/mrjithendar/newsroom/blob/master/docs/ML.md) · [QUALITY_GATES](https://github.com/mrjithendar/newsroom/blob/master/docs/QUALITY_GATES.md) · [IMAGES](https://github.com/mrjithendar/newsroom/blob/master/docs/IMAGES.md) · [COSTS](https://github.com/mrjithendar/newsroom/blob/master/docs/COSTS.md).

| Part | Where |
|---|---|
| Flows, News Desk crew, ML, quality gates, covers, the news crew's Test run | the news agent (mrjithendar/newsroom `app/news/`, `app/flows/news.py`) |
| Fetching (SSRF-safe, robots.txt), CMS drafts, media storage, Gemini images, notifications | this web app's callback API (`src/lib/news/callbacks.ts`), with the news agent's own token `NEWS_AGENT_CALLBACK_TOKEN` (`src/lib/seo-agent/internal-server.ts` NEWS_AGENT_ROUTES: those routes only) |
| Newsroom admin UI and API, review queue, publishing additions, corrections, public pages, feed, news sitemap | this web app (`src/app/admin/news`, `src/app/api/admin/news`, `src/lib/news`, `src/app/news`) |
| Kick-offs and run status | `src/lib/news-agent/client.ts` → the news agent (`NEWS_AGENT_TOKEN`), found by `src/lib/news-agent/endpoint.ts` |
| Publishing an approved news draft | the seo-agent's `publish_flow`, as for every draft |
| Site search (site match, the crew's search tool) and the one LLM budget | the seo-agent: `POST /search`, `POST /llm-budget/reserve|settle` with `SEO_AGENT_NEWS_TOKEN` |
| Schedules | rows `news-dispatch`, `news-train`, `news-style-review` of `seo_flow_schedules` (CrewAI console → Schedules); the news agent's own dispatcher CronJob starts them |
| Flow runs and run history | `seo_flow_runs` and `seo_flow_run_*` (shared with the seo-agent; each agent touches only its own flows), shown in the CrewAI console with an Agent column |
| Data | the shared Postgres, migration `0017_news_desk.sql` (17 `news_*` tables) and later ones; the news agent has its own database role |

The CrewAI console talks to both agents (`src/lib/crewai/agents.ts`, the rule in `src/lib/crewai/agent-of.ts`): news
flows and the news crew go to the news agent, everything else to the seo-agent. The runs list says which agent ran each
run and filters by it; an agent that does not answer has its flows' start buttons disabled and its crews listed
read-only. Nothing in the news agent can publish.

The news agent's own settings (its Claude key, sealed with `NEWS_AGENT_SETTINGS_KEY`; default models; limits; the
embeddings connection) are shown and saved in Newsroom → Settings, below the News agent card
(`/api/admin/news/agent-settings/{group}` → its `PUT /admin-settings/{group}`). A callback refused for the news
agent's token is written to the audit log (`agent.callback_forbidden`).
