# News desk: manual setup

Everything is off by default. These steps are for a person with cluster access (`kubectl`). Nothing here
is applied by CI.

## 1. Prerequisites

The news desk runs in its own service since 2026-11-21: the **news agent** ([mrjithendar/newsroom](https://github.com/mrjithendar/newsroom),
image `news-agent:latest`, Deployment `news-agent`). The web app keeps the Newsroom admin, the review queue, the
callbacks (fetching, drafts, media, notifications) and the public pages. The seo-agent keeps publishing (after a
person approves a news draft), the one LLM budget and the site's index, which the news agent uses.

You need: the web app migrated (`0017_news_desk.sql` is applied on start-up), media storage (R2) if you want covers
stored, and for site match and the LLM budget a seo-agent with `SEO_AGENT_NEWS_TOKEN` (optional: without it the news
agent has no site search and no budget check besides the Anthropic Console's own limit).

## 2. Deploy

The site repository has the manifests (jithendar.com: `kubernetes/news-agent-*.yaml`, `scripts/create-news-agent-secrets.sh`).

1. Secrets: `scripts/create-news-agent-secrets.sh` creates `news-agent-env` (`NEWS_AGENT_TOKEN`,
   `NEWS_AGENT_CALLBACK_TOKEN`, `SEO_AGENT_NEWS_TOKEN`, optional `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`) and adds the
   matching keys to `jithendar-com-env` (`NEWS_AGENT_TOKEN`, `NEWS_AGENT_CALLBACK_TOKEN`) and `seo-agent-env`
   (`SEO_AGENT_NEWS_TOKEN`). Restart the web app and the seo-agent so they read them.
2. Apply: `scripts/manifests.sh news-agent | kubectl apply -f -` (Deployment, Service, NetworkPolicy and the
   dispatcher CronJob `news-flow-dispatcher`, which starts the `news-*` schedules of the CrewAI console).
3. Check: Admin → System status shows "News agent: ready"; Newsroom → Settings → News agent shows where it was found.
   The web app finds it at `NEWS_AGENT_URL`, the endpoint saved there, or `http://news-agent:8080`.

## 3. Enable the desk

Newsroom → Settings → General → the switch. `NEWS_DESK_ENABLED=false` in ConfigMap `news-agent-config` (or the web
app's environment) forces it off whatever the switch says; remove it to control the desk from the admin. While the
desk is off, or the news agent is not found, the Newsroom shows a banner and "Run now" is refused.

## 4. First job

Follow JOBS.md "First job": import starter sources (disabled), review terms and enable some, create a job (disabled),
dry run, inspect the candidates, enable.

## 5. Image providers (optional)

- **Template**: nothing to do (default).
- **Gemini**: configure Admin → Integrations → Gemini image generation (the same integration the editor uses). Set the
  job's or profile's provider to `gemini` and Settings → image price. Covers are stored in the media library (R2 needed).
- **OpenAI**: add `OPENAI_API_KEY` to Secret `news-agent-env`
  (`kubectl -n jithendar patch secret news-agent-env -p '{"stringData":{"OPENAI_API_KEY":"…"}}'`), optionally
  `NEWS_OPENAI_IMAGE_MODEL`, restart `deploy/news-agent`. Its NetworkPolicy allows 443 to public IPs (core
  NetworkPolicy cannot restrict by domain; an Istio egress gateway would be needed for that).
- `NEWS_IMAGE_PROVIDER` (ConfigMap) overrides Settings for every job without a provider override.

## 6. Google News sitemap and feed

Nothing to set up: `/news-sitemap.xml` already exists (news/analysis articles, last 48 hours) and is in robots.txt;
`/news/feed.xml` is new. Optionally add the news sitemap in Search Console (Sitemaps → add `news-sitemap.xml`); the v2
submission path already resubmits it after a news article is published. Google News inclusion is automatic and is not
claimed by this work (AGENTS.md rule 9). Confirm the publication name used in the news sitemap and JSON-LD
(`site.publicationName`) with the owner.

## 7. Alerts and dashboard

- `docs/news/prometheus-alerts.yml` (group `jithendar-com-news`, `job="news-agent"`) is part of
  `docs/seo/alerts-for-minikube-repo.yaml` (scripts/build-alerts.py); copy that file into the miniKube repo.
- The dashboard `grafana/jithendar-com-news.json` in `mrjithendar/jithendar.com` (job `news-agent`) loads after merge
  and an Argo CD sync of the `grafana` app.

## 8. Notifications (optional)

The run summary, job failure and budget emails use the SEO alert recipients (SEO → Settings → Drafts digest recipients /
report recipients) and Admin → Storage & email. Without them nothing is sent.

## 9. MCP

The public MCP server (the seo-agent's) has `search_news` (published news posts). The admin MCP news tools were
removed when the desk moved to the news agent, which has no MCP server. No tool approves or publishes.
