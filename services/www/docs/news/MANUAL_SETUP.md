# News desk: manual setup

Everything is off by default. These steps are for a person with cluster access (`kubectl`). Nothing here
is applied by CI.

## 1. Prerequisites

The SEO v4 setup is complete (docs/seo/MANUAL_SETUP.md): seo-agent deployed with Secret `seo-agent-env`,
`SEO_ORCHESTRATOR=crewai` on the web app (the callback listener only runs then), media storage (R2) configured if you
want covers stored. pgvector is optional (novelty vs the site is skipped without it).

## 2. Deploy

1. Merge, let CI build both images, restart the web app (CI does after the merge; or run the `deploy to kubernetes` workflow), which applies migration `0017_news_desk.sql`
   on start-up.
2. Apply the agent group (the ConfigMap now has `NEWS_DESK_ENABLED: "false"`, and three news CronJobs):
   `scripts/manifests.sh seo-agent | kubectl apply -f -`
3. Check: `kubectl -n jithendar get cronjob news-dispatch news-train news-style-review`.

## 3. Enable the desk

Both sides read `NEWS_DESK_ENABLED`:

- seo-agent: `kubectl -n jithendar patch configmap seo-agent-config -p '{"data":{"NEWS_DESK_ENABLED":"true"}}'`
  then `kubectl -n jithendar rollout restart deploy/seo-agent`.
- web app: add `NEWS_DESK_ENABLED=true` to ConfigMap `jithendar-com-public` (or the `jithendar-com-env` Secret), then
  restart the web Deployment. While it is off, Admin → News desk shows a banner and "Run now" is refused.

Pausing later needs no deploy: Admin → News desk → Settings → Paused.

## 4. First job

Follow JOBS.md "First job": import starter sources (disabled), review terms and enable some, create a job (disabled),
dry run, inspect the candidates, enable.

## 5. Image providers (optional)

- **Template**: nothing to do (default).
- **Gemini**: configure Admin → Integrations → Gemini image generation (the same integration the editor uses). Set the
  job's or profile's provider to `gemini` and Settings → image price. Covers are stored in the media library (R2 needed).
- **OpenAI**: add `OPENAI_API_KEY` to Secret `seo-agent-env`
  (`kubectl -n jithendar patch secret seo-agent-env -p '{"stringData":{"OPENAI_API_KEY":"…"}}'`), optionally
  `NEWS_OPENAI_IMAGE_MODEL`, restart seo-agent. The agent's NetworkPolicy already allows 443 to public IPs (core
  NetworkPolicy cannot restrict by domain; an Istio egress gateway would be needed for that).
- `NEWS_IMAGE_PROVIDER` (ConfigMap) overrides Settings for every job without a provider override.

## 6. Google News sitemap and feed

Nothing to set up: `/news-sitemap.xml` already exists (news/analysis articles, last 48 hours) and is in robots.txt;
`/news/feed.xml` is new. Optionally add the news sitemap in Search Console (Sitemaps → add `news-sitemap.xml`); the v2
submission path already resubmits it after a news article is published. Google News inclusion is automatic and is not
claimed by this work (AGENTS.md rule 9). Confirm the publication name used in the news sitemap and JSON-LD
(`site.publicationName`) with the owner.

## 7. Alerts and dashboard

- Copy `docs/news/prometheus-alerts.yml` into the miniKube repo's `alerts.yml` (group `jithendar-com-news`).
- The dashboard `grafana/jithendar-com-news.json` in `mrjithendar/jithendar.com` loads after merge and an Argo CD sync of the `grafana` app.

## 8. Notifications (optional)

The run summary, job failure and budget emails use the SEO alert recipients (SEO → Settings → Drafts digest recipients /
report recipients) and Admin → Storage & email. Without them nothing is sent.

## 9. MCP

The admin MCP server (if enabled, docs/seo/MCP.md) now has news tools: `list_news_jobs`, `get_news_job`,
`list_news_runs`, `get_news_run`, `kickoff_news_job` (dry run by default), `list_news_drafts`, `get_news_candidates`,
`reject_news_draft`. The public server has `search_news`. No tool approves or publishes.
