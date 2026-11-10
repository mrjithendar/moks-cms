# SEO intelligence platform: manual setup

Steps only a person can do. Until they are done, `/admin/seo` shows **Disconnected** and no Google data is fetched.

## 1. Google Cloud project and APIs
1. https://console.cloud.google.com → select or create a project (e.g. `jithendar-seo`). No billing is needed for these
   APIs at this site's volume; do not enable paid features.
2. APIs & Services → Library → enable:
   - **Google Search Console API**
   - **Google Analytics Data API**
   - (optional) **PageSpeed Insights API**

## 2. Service account and key
1. IAM & Admin → Service accounts → **Create service account**: name `jithendar-seo-reader`. Grant **no** project roles.
2. Open it → Keys → Add key → **Create new key** → JSON. Download it once; keep it out of Git, chat and email.
   (Workload identity is not available on Minikube, so a key is used. Rotate it yearly: create a new key, re-run step 5,
   then delete the old key.)
3. Copy the service-account email (`…@….iam.gserviceaccount.com`).
4. (optional, PageSpeed) APIs & Services → Credentials → Create credentials → API key → restrict it to the PageSpeed
   Insights API.

## 3. Search Console access
1. https://search.google.com/search-console → property **jithendar.com** (domain property) → Settings → **Users and
   permissions** → Add user → the service-account email → permission **Restricted** (read access to performance data).
2. Only if you will enable URL Inspection: use **Full** instead.
3. Note the property: `sc-domain:jithendar.com` for a domain property, or `https://jithendar.com/` for a URL-prefix one.

## 4. GA4 access
1. https://analytics.google.com → Admin → **Property access management** → `+` → Add users → the service-account email
   → role **Viewer** → Add.
2. Admin → Property details → copy the **Property ID** (digits only, not the `G-…` measurement id).

## 5. Store credentials and property ids in the cluster
```bash
cd jithendar.com
scripts/set-seo-config.sh ~/Downloads/jithendar-seo-reader-key.json      # context mk4 by default
# prompts: Search Console property, GA4 property id, optional PageSpeed key
kubectl --context mk4 -n jithendar rollout restart deployment/jithendar-com
rm ~/Downloads/jithendar-seo-reader-key.json                              # the Secret now holds it
```
The script merges `GOOGLE_SEO_SERVICE_ACCOUNT_JSON` (+ `PAGESPEED_API_KEY`) into Secret `jithendar-com-env` and
`SEO_GSC_PROPERTY` / `SEO_GA4_PROPERTY_ID` into ConfigMap `jithendar-com-public`. Property ids can also be set in
Admin → SEO intelligence → Settings (which then win).

## 6. Verify
1. Admin → SEO intelligence → **Integrations** → **Test connection**. Both must say *connected* (a real request to
   Google succeeded). GA4 also reports the property's time zone.
2. **Sync history** → **Backfill Search Console (16 months)** and **Backfill GA4 (16 months)**. Refresh until the last
   run of each is `succeeded` (GA4 may stop as `partial` on quota; run it again later).
3. **Sync history**: rows written > 0, errors empty. **Overview**: KPIs show values and "Last sync".
4. **Recommendations** → **Generate now**; **Technical SEO** → **Scan now**.

## 7. Optional
- **LLM explanations / proposals**: Settings → LLM: enable, provider (`openai` for OpenAI or an OpenAI-compatible endpoint
  such as Ollama via base URL, `gemini`, `bedrock`), model id, key (or rely on `OPENAI_API_KEY` / `GEMINI_API_KEY`),
  daily limit. Check the provider's pricing first; nothing is enabled by default.
- **URL Inspection**: Settings → Google → URL inspection enabled + daily limit (≤ 2,000/day per property; Full permission).
- **PageSpeed**: Settings → Google → PageSpeed enabled (needs `PAGESPEED_API_KEY`).
- **Report emails**: Admin → Storage & email must be configured; then Settings → Reports: enable and add recipients.
- **Alerts**: copy `services/www/docs/seo/prometheus-alerts.yml` into the miniKube repo (OPERATIONS.md#alerts).
- **Dashboard**: sync the `grafana` Argo CD app after merge.

---

# v2 additions (drafts, submission)

## 8. Anthropic API key and the monthly budget
1. https://console.anthropic.com → (optionally a dedicated workspace `jithendar-seo`) → **API keys** → Create key
   `jithendar-seo-drafts`. In the workspace's **Limits**, set a spend limit a little above the budget below (a second,
   provider-side cap).
2. Store it as a secret reference only — it is never saved in the database:
   ```bash
   cd jithendar.com
   read -rs KEY && kubectl --context mk4 -n jithendar patch secret jithendar-com-env --type merge \
     -p "{\"stringData\":{\"ANTHROPIC_API_KEY\":\"$KEY\"}}" && unset KEY
   ```
3. Budget and models (non-secret) in ConfigMap `jithendar-com-public`:
   ```bash
   kubectl --context mk4 -n jithendar patch configmap jithendar-com-public --type merge \
     -p '{"data":{"SEO_LLM_MONTHLY_BUDGET_USD":"10","SEO_DRAFT_MODEL":"claude-sonnet-5-5","SEO_CLASSIFY_MODEL":"claude-haiku-5-5"}}'
   kubectl --context mk4 -n jithendar rollout restart deployment/jithendar-com
   ```
   The budget is a hard cap on month-to-date spend (UTC month) across all SEO Claude calls; Settings can lower it but
   not raise it. When reached, jobs pause and every `/admin/seo` page shows a banner.
4. Verify: Admin → SEO → Settings → **Claude usage this month** says "Key: configured". On an article's SEO panel,
   **Draft with Claude** → the draft appears in the Review queue within a minute; the usage card shows the call and
   its cost.

## 9. Search Console permission for sitemap resubmission
`sitemaps.submit` needs the **write** scope (`https://www.googleapis.com/auth/webmasters`) and a user with **Full** (or
Owner) permission. In Search Console → Settings → Users and permissions, change the service account from *Restricted*
to **Full**. The app requests the write scope only for that call; syncing stays read-only. Without it, submissions show
"error … needs Full or Owner permission"; IndexNow is unaffected.

## 10. IndexNow
Nothing to do: the key is generated automatically on the first SEO submission and served at
`https://jithendar.com/{key}.txt` (or set `INDEXNOW_KEY` yourself). If you turned IndexNow off in Admin → Integrations,
it stays off. Optional: verify the site in **Bing Webmaster Tools** (https://www.bing.com/webmasters, import from Search
Console) to see IndexNow submissions and crawl reports there — the app does not need it.

## 11. Submission kill switch
`SEO_SUBMISSION_ENABLED` is on by default only when `APP_ENV=production`. Set it to `false` in the ConfigMap to stop all
submissions (each event is still logged as `skipped`).

## 12. Digest recipients
Settings → Drafts → digest → recipients (requires email in Admin → Storage & email). Until a recipient is set, nothing
is emailed.

# v3: agents (LangGraph, CrewAI, pgvector)

Everything below is off until you do it. Until then, the site keeps running the v2 path. Do the steps in order;
details are in [AGENTS.md](AGENTS.md) and [RAG.md](RAG.md).

## 13. Enable pgvector (one time, needs the database superuser)
The cluster's CloudNativePG image (`ghcr.io/cloudnative-pg/postgresql:18`) ships pgvector **0.8.6**, but the extension
isn't marked *trusted*, so the app's role (`jithendar`) can't create it. This was checked read-only on 2026-11-10. Run
this once on the **primary**, as the superuser:
```bash
P=$(kubectl --context mk4 -n postgres-db get pod -l cnpg.io/cluster=postgres-cluster,cnpg.io/instanceRole=primary -o name)
kubectl --context mk4 -n postgres-db exec -it "$P" -c postgres -- psql -d jithendar -c 'CREATE EXTENSION IF NOT EXISTS vector;'
kubectl --context mk4 -n postgres-db exec -it "$P" -c postgres -- psql -d jithendar -c "select extversion from pg_extension where extname = 'vector';"
```
To keep it declarative, add it to the database in the miniKube repo instead: a CloudNativePG `Database` resource with
`spec.extensions: [{name: vector, ensure: present}]` (minikube-infrastructure). No image change is needed. Without
it, `seo-agent` starts anyway: `/readyz` says "pgvector extension is not enabled", Ask the Blog falls back, and drafting
works without related articles.

## 14. Secrets
```bash
scripts/create-seo-agent-secrets.sh            # seo-agent-env + the two tokens in jithendar-com-env
```
`ANTHROPIC_API_KEY` is copied from `jithendar-com-env` (the v2 key: one key, one budget) unless you export a different
one first. `SEO_AGENT_TOKEN` (web → agent) and `SEO_AGENT_CALLBACK_TOKEN` (agent → web) are separate random 64-hex values.
Rotate by running the script again and restarting both Deployments.

## 15. Image and manifests
1. Merge → CI (`ci-seo-agent.yml`) builds and pushes `registry.jithendar.com/jithendar/seo-agent:latest`.
2. Apply the site group as usual (`./deploy.sh`): it adds the `jithendar-com-internal` Service (callback port 9465, not
   routed by the VirtualService) and the NetworkPolicy rules. It's harmless before step 5.
3. Apply the agent group (a person, once; CI only renders it):
   ```bash
   scripts/manifests.sh seo-agent | kubectl --context mk4 apply -f -
   kubectl --context mk4 -n jithendar rollout status deploy/seo-agent
   kubectl --context mk4 -n jithendar exec deploy/seo-agent -- python -c "import urllib.request as u; print(u.urlopen('http://127.0.0.1:8080/readyz').read().decode())"
   ```
4. RBAC: `minikube/80-ci-deployer.yaml` now lets CI restart `seo-agent` too. A person applies it (`./deploy.sh`). To let
   CI restart the agent after each release, set the repository variable `SEO_AGENT_DEPLOY=true`.

## 16. Prometheus scrape job, alerts, dashboard (miniKube / tools repos)
- Scrape job, in the miniKube repo's Prometheus config, like `jithendar-com`:
  ```yaml
  - job_name: seo-agent
    metrics_path: /metrics
    dns_sd_configs: [{ names: [seo-agent-metrics.jithendar.svc.cluster.local], type: A, port: 8080 }]
  ```
- Alerts: copy group `jithendar-com-seo-agent` from [prometheus-alerts.yml](prometheus-alerts.yml).
- Dashboard: `services/grafana/jithendar-com-seo-agent.json` (Argo CD `grafana` app). **Since the `services/` move, the
  app's path must be `services/grafana`** (tools repo, `deploy/minikube/applications/grafana.yaml`).

## 17. Switch drafting to LangGraph
```bash
kubectl --context mk4 -n jithendar patch configmap jithendar-com-public --type merge -p '{"data":{"SEO_ORCHESTRATOR":"langgraph"}}'
kubectl --context mk4 -n jithendar rollout restart deploy/jithendar-com
```
Check: on an article's SEO panel, **Draft with Claude**. The review page shows "LangGraph run · Agent working…", then
"Waiting for your review". Approve one change: the run publishes, verifies and submits, and the strip shows
"Run published". Keep `SEO_LLM_MONTHLY_BUDGET_USD` equal in `jithendar-com-public` and `seo-agent-config`, because
both read the same usage table.
**Rollback:** set `SEO_ORCHESTRATOR=legacy` and restart. Drafts that runs created stay reviewable, but their
approval needs the agent; reject them, or regenerate them under legacy.

## 18. Ask the Blog (optional; off by default)
Turn it on in **both** places: the widget and `/api/ask` live in the web app; answering lives in the agent.
```bash
kubectl --context mk4 -n jithendar patch configmap jithendar-com-public --type merge -p '{"data":{"ASK_BLOG_ENABLED":"true"}}'
kubectl --context mk4 -n jithendar patch configmap seo-agent-config --type merge -p '{"data":{"ASK_BLOG_ENABLED":"true","ASK_BLOG_DAILY_BUDGET_USD":"1"}}'
kubectl --context mk4 -n jithendar rollout restart deploy/seo-agent deploy/jithendar-com
```
Run a reindex first so there's something to retrieve: Admin → SEO → (API) `POST /api/admin/seo/agent/reindex {"full": true}`,
or wait for the Sunday CronJob. Turn it off the same way with `"false"`.

## 19. Embeddings model choice
The default is `EMBEDDINGS_PROVIDER=onnx` (bge-small-en-v1.5, baked into the image). To use an Ollama already in the
cluster: set `EMBEDDINGS_PROVIDER=ollama`, `OLLAMA_URL`, `OLLAMA_EMBED_MODEL` in `seo-agent-config`, allow egress to it
in the `seo-agent` NetworkPolicy, restart, then run a full reindex (the table is rebuilt for the new dimension). A
third-party API (`EMBEDDINGS_PROVIDER=api`) needs `EMBEDDINGS_API_URL`/`EMBEDDINGS_API_KEY` in `seo-agent-env`, and
it sends article text to that provider.
