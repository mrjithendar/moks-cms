# SEO intelligence platform: manual setup

Steps only a person can do. Until they are done, the admin Dashboard's Search & traffic view and Admin → Integrations show **Disconnected** and no Google data is fetched.

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
kubectl -n jithendar rollout restart deployment/jithendar-com
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
   read -rs KEY && kubectl -n jithendar patch secret jithendar-com-env --type merge \
     -p "{\"stringData\":{\"ANTHROPIC_API_KEY\":\"$KEY\"}}" && unset KEY
   ```
3. Budget and models (non-secret) in ConfigMap `jithendar-com-public`:
   ```bash
   kubectl -n jithendar patch configmap jithendar-com-public --type merge \
     -p '{"data":{"SEO_LLM_MONTHLY_BUDGET_USD":"15","SEO_DRAFT_MODEL":"claude-sonnet-5-5","SEO_CLASSIFY_MODEL":"claude-haiku-5-5"}}'
   kubectl -n jithendar rollout restart deployment/jithendar-com
   ```
   The budget is a hard cap on month-to-date spend (UTC month) across all SEO Claude calls; Settings can lower it but
   not raise it. When reached, jobs pause and the search, review and automation admin pages show a banner.
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

# agents (CrewAI Flows and Crews, pgvector)

Everything below is off until you do it. Until then, the site keeps running the v2 path. Do the steps in order;
details are in [AGENTS.md](AGENTS.md) and [RAG.md](RAG.md).

## 13. Enable pgvector (one time, needs the database superuser)
The cluster's CloudNativePG image (`ghcr.io/cloudnative-pg/postgresql:18`) ships pgvector **0.8.6**, but the extension
isn't marked *trusted*, so the app's role (`jithendar`) can't create it. This was checked read-only on 2026-11-10. Run
this once on the **primary**, as the superuser:
```bash
P=$(kubectl -n postgres-db get pod -l cnpg.io/cluster=postgres-cluster,cnpg.io/instanceRole=primary -o name)
kubectl -n postgres-db exec -it "$P" -c postgres -- psql -d jithendar -c 'CREATE EXTENSION IF NOT EXISTS vector;'
kubectl -n postgres-db exec -it "$P" -c postgres -- psql -d jithendar -c "select extversion from pg_extension where extname = 'vector';"
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
1. Merge → CI (`ci-seo-agent.yml`) builds and pushes `registry.jithendar.com/jithendar/seo-agent:pr-<number>` and `:latest`
   (the Deployment runs `:pr-<number>`, the flow-trigger CronJobs `:latest` with `imagePullPolicy: Always`).
2. Apply the site group as usual (the `deploy to kubernetes` workflow, on merge): it adds the `jithendar-com-internal` Service (callback port 9465, not
   routed by the VirtualService) and the NetworkPolicy rules. It's harmless before step 5.
3. Apply the agent group (a person, once; CI only renders it):
   ```bash
   scripts/manifests.sh seo-agent | kubectl apply -f -
   kubectl -n jithendar rollout status deploy/seo-agent
   kubectl -n jithendar exec deploy/seo-agent -- python -c "import urllib.request as u; print(u.urlopen('http://127.0.0.1:8080/readyz').read().decode())"
   ```
4. RBAC: `kubernetes/80-ci-deployer.yaml` now lets CI restart `seo-agent` too. The `deploy to kubernetes` workflow applies it on merge (before 2026-11-14 a person did, with `./deploy.sh`). To let
   CI restart the agent after each release, set the repository variable `SEO_AGENT_DEPLOY=true`.

## 16. Prometheus scrape job, alerts, dashboard (miniKube / tools repos)
- Scrape job, in the miniKube repo's Prometheus config, like `jithendar-com`:
  ```yaml
  - job_name: seo-agent
    metrics_path: /metrics
    dns_sd_configs: [{ names: [seo-agent-metrics.jithendar.svc.cluster.local], type: A, port: 8080 }]
  ```
- Alerts: copy group `jithendar-com-seo-agent` from [prometheus-alerts.yml](prometheus-alerts.yml).
- Dashboard: `grafana/jithendar-com-seo-agent.json` in `mrjithendar/jithendar.com` (Argo CD `grafana` app). **Since the site
  moved to its own repository (2026-11-16), the app must read repository `mrjithendar/jithendar.com`, path `grafana`** (tools repo, `deploy/minikube/applications/grafana.yaml`).

## 17. Switch drafting to the agent (superseded by §22)

> v3 ran drafting on LangGraph; v4 replaced it with CrewAI Flows. `SEO_ORCHESTRATOR=langgraph` still works as an alias
> of `crewai` (existing ConfigMaps keep working), but set `crewai` and follow §20–§28.

**Rollback:** set `SEO_ORCHESTRATOR=legacy` and restart. Drafts that runs created stay reviewable, but their
approval needs the agent; reject them, or regenerate them under legacy.

## 18. Ask the Blog (off until an admin turns it on)
Since D-89 the manifests set the deployment switch `ASK_BLOG_ENABLED=true` for both workloads (the web Deployment in
`kubernetes/30-jithendar-com.yaml`, and `seo-agent-config`), so nothing needs patching. The two manifests are in
different groups and are applied separately:

- web Deployment (site group): the `deploy to kubernetes` workflow applies it when the pull request is merged;
- `seo-agent-config` (seo-agent group): `scripts/manifests.sh seo-agent | kubectl apply -f -`, then
  `kubectl -n jithendar rollout restart deploy/seo-agent`. No workflow applies this group until the pull request
  "remove deploy.sh" (#59) is merged; after that the workflow applies it and restarts the agent.

The assistant is still **off** until an admin switches it on:

1. Run a reindex first so there's something to retrieve: Admin → SEO → (API) `POST /api/admin/seo/agent/reindex {"full": true}`,
   or wait for the Sunday CronJob.
2. Recommended before going public: run the **RAG eval (manual)** workflow with the real model (RAG.md "Evaluation"),
   including the hard set, and the opt-in generation eval.
3. Admin → Automation & AI → **Ask the Blog**: tick "Ask the Blog is on", choose **Signed-in readers only** (the
   default) or **Everyone**, set the limits and daily budget, save. The site applies it at once; the agent within
   about 30 seconds.

**Turn it off:** untick the same switch (no restart). **Hard kill switch:** `ASK_BLOG_ENABLED=false`:
```bash
kubectl -n jithendar patch configmap seo-agent-config --type merge -p '{"data":{"ASK_BLOG_ENABLED":"false"}}'
kubectl -n jithendar rollout restart deploy/seo-agent
```
The agent then answers `disabled` to every question (the widget says it is switched off). For the web app the value is
in the Deployment manifest: set it to `"false"` there in a pull request and merge it. An `ASK_BLOG_ENABLED` key left in
`jithendar-com-public` from the earlier instructions no longer has any effect (the Deployment's own `env` wins); it
can be removed.

`ASK_BLOG_DAILY_BUDGET_USD` in `seo-agent-config` is the ceiling: the budget saved in the admin can be lower, never
higher.

## 19. Embeddings model choice
The default is `EMBEDDINGS_PROVIDER=onnx` (bge-small-en-v1.5, baked into the image). To use an Ollama already in the
cluster: set `EMBEDDINGS_PROVIDER=ollama`, `OLLAMA_URL`, `OLLAMA_EMBED_MODEL` in `seo-agent-config`, allow egress to it
in the `seo-agent` NetworkPolicy, restart, then run a full reindex right away: the new-dimension table is built next
to the old one and swapped in when the reindex completes; until then Ask the Blog answers with the fallback (RAG.md
"Embeddings"). A
third-party API (`EMBEDDINGS_PROVIDER=api`) needs `EMBEDDINGS_API_URL`/`EMBEDDINGS_API_KEY` in `seo-agent-env`, and
it sends article text to that provider.

---

# v4: CrewAI flows, MCP, report PDFs

Everything below is off or inert until a person does it. Order matters: §20 → §21 → §22 (switch), then §23–§28 as
needed. Status of each item: PROGRESS.md "v4".

## 20. Migration 0016 and the image
1. Merge → CI builds `registry.jithendar.com/jithendar/seo-agent:latest` and the site image. Migration
   `0016_seo_v4.sql` (flow runs, review notes, MCP OAuth tables; additive) runs when the site starts.
2. Apply the site group (the `deploy to kubernetes` workflow, on merge): it renames `seo-agent-reindex` to `seo-agent-trigger` in the `istio-sidecars`
   NetworkPolicy (the trigger pods' sidecars need istiod and DNS). CI applies that NetworkPolicy too.
3. Apply the agent group and remove the v3 CronJob (it is no longer in the manifests):
   ```bash
   kubectl -n jithendar delete cronjob seo-agent-reindex --ignore-not-found
   kubectl -n jithendar delete networkpolicy seo-agent-reindex --ignore-not-found
   scripts/manifests.sh seo-agent | kubectl apply -f -
   kubectl -n jithendar rollout status deploy/seo-agent
   kubectl -n jithendar exec deploy/seo-agent -- python -c "import urllib.request as u; print(u.urlopen('http://127.0.0.1:8080/readyz').read().decode()); print(u.urlopen('http://127.0.0.1:8090/healthz').read().decode())"
   ```
   The CronJobs (`seo-flow-*`) are created by this apply. They only call the agent; until §22 the agent's callbacks are
   off (the web app's callback listener starts only with `SEO_ORCHESTRATOR=crewai`), so a trigger before the switch
   fails harmlessly. To keep them quiet until then, suspend them:
   ```bash
   for c in $(kubectl -n jithendar get cronjob -l app=seo-agent-trigger -o name); do
     kubectl -n jithendar patch "$c" -p '{"spec":{"suspend":true}}'
   done
   ```

## 21. Secrets
No new secret: v4 uses `seo-agent-env` (ANTHROPIC_API_KEY, SEO_AGENT_TOKEN, SEO_AGENT_CALLBACK_TOKEN) as in §14. The
admin MCP's OAuth tokens are opaque and stored as SHA-256 hashes in Postgres, so **no OAuth signing keys** exist to
create or rotate. R2 credentials are the site's existing ones (Admin → Storage, or `R2_*` in `jithendar-com-env`).

## 22. Switch to the CrewAI flows
```bash
kubectl -n jithendar patch configmap jithendar-com-public --type merge -p '{"data":{"SEO_ORCHESTRATOR":"crewai"}}'
kubectl -n jithendar rollout restart deploy/jithendar-com
# if the CronJobs were suspended in §20: set "suspend": false again
```
From now on the web app's in-process scheduler skips gsc/ga4 sync, technical scan, recommendations, weekly drafts,
batch polling and reports; the `seo-flow-*` CronJobs run them through the flows. Check:
- SEO › Sync history → **Sync now**: a `gsc_sync_flow` run appears (MCP `list_flow_runs`, or `GET /flows/runs` on the agent).
- An article's SEO panel → **Draft with Claude**: the review page shows "CrewAI flow · Agent working…", then
  "Waiting for your review". Approve one change: `publish_flow` publishes, verifies, submits and reindexes.
- SEO › Reports → **Generate weekly**: a report with a "Summary" and **Download PDF** (R2) appears.
Keep `SEO_LLM_MONTHLY_BUDGET_USD` equal in `jithendar-com-public` and `seo-agent-config` (COSTS.md: v4 crews cost more;
consider $15).

## 23. Schedules
Edit `schedule:` in `kubernetes/seo-agent-60-flow-triggers.yaml` and re-apply, or patch one CronJob:
`kubectl -n jithendar patch cronjob seo-flow-gsc-sync -p '{"spec":{"schedule":"30 5 * * *"}}'`. The Settings page's
schedule fields only apply to the legacy path.

## 24. Report PDFs in R2
They use the site's existing R2 bucket and client (Admin → Storage must be configured; check Admin → System status).
Objects go to the private prefix `jithendar/www/reports/seo/{weekly|monthly}/{yyyy}/…-{uuid}.pdf` with
`Cache-Control: private, no-store`; admins download them via a 5-minute presigned link. If the bucket has a public
delivery domain, the random UUID makes keys unguessable, but consider an R2 rule that blocks public access to
`jithendar/www/reports/` for defence in depth. Email (if enabled with recipients) includes the PDF link, not the file.

## 25. The public MCP server (optional)
```bash
kubectl -n jithendar patch configmap seo-agent-config --type merge -p '{"data":{"PUBLIC_MCP_ENABLED":"true"}}'
kubectl -n jithendar patch configmap jithendar-com-public --type merge -p '{"data":{"PUBLIC_MCP_ENABLED":"true"}}'
kubectl -n jithendar rollout restart deploy/seo-agent deploy/jithendar-com
```
The site then shows `/ai-assistants` and a footer link. Needs the gateway route (§27) and a reindex (§18).

## 26. The admin MCP server and OAuth (after verifying it)
```bash
kubectl -n jithendar patch configmap seo-agent-config --type merge -p '{"data":{"ADMIN_MCP_ENABLED":"true"}}'
kubectl -n jithendar patch configmap jithendar-com-public --type merge -p '{"data":{"ADMIN_MCP_ENABLED":"true"}}'
kubectl -n jithendar rollout restart deploy/seo-agent deploy/jithendar-com
```
No client registration is needed: Claude and MCP Inspector register themselves (RFC 7591). Verify, in order:
1. `curl -s https://jithendar.com/.well-known/oauth-protected-resource/mcp/admin` and `…/.well-known/oauth-authorization-server`.
2. `curl -si -X POST https://jithendar.com/mcp/admin -H 'Content-Type: application/json' -d '{}'` → 401 with `WWW-Authenticate … resource_metadata=…`.
3. MCP Inspector UI (`npx @modelcontextprotocol/inspector@2.12.0`, Streamable HTTP, URL `https://jithendar.com/mcp/admin`,
   Auth → OAuth flow): consent page as admin → tools listed → `get_overview` works.
4. Claude: Settings › Connectors › Add custom connector → `https://jithendar.com/mcp/admin`; allow; ask "triage my SEO
   review queue". Mark "Claude custom connector" as verified in PROGRESS.md.
5. SEO › Settings › MCP access lists both clients; **Revoke** one and confirm its next call fails.

## 27. Gateway routes for /mcp/* (Kong; additive)
The entities are in `kubernetes/kong/seo-agent-mcp.deck.yaml` (one Service, two Routes, rate-limiting and
request-size-limiting, no buffering, 5-minute read timeout, `preserve_host`). They are **not applied** by anything:
1. Copy them into the tools repo's Kong config (`kong-config/seed/kong.yaml`, docs/kong) or sync just these:
   `deck gateway diff kubernetes/kong/seo-agent-mcp.deck.yaml --select-tag seo-agent-mcp` then `… sync …`.
2. **Mesh:** namespace `jithendar` is STRICT mTLS. Kong must call `seo-agent-mcp:8090` with a mesh identity (a sidecar
   in the `kong` namespace), or the call is refused before the NetworkPolicy matters. Once Kong is meshed and the
   `allow-known-callers` AuthorizationPolicy leaves dry-run, add `kong` to its `namespaces`.
3. **Before the Kong cutover** (master today routes through the Istio gateway): the equivalent is a match for
   `/mcp/public` and `/mcp/admin` (prefix, exact and with `/`) → `seo-agent-mcp.jithendar.svc.cluster.local:8090` in the
   root VirtualService of the miniKube repo (`deploy/minikube/istio/edge`), placed before the site's default route, with
   the gateway's rate limiting. This was not changed here (existing routes stay untouched); it is a person's decision.

## 28. Rollback
1. `SEO_ORCHESTRATOR=legacy` in `jithendar-com-public`, restart the site: v2's scheduler and direct Claude path resume.
2. Suspend the CronJobs (§20 loop with `"suspend": true`), set `ADMIN_MCP_ENABLED=false` / `PUBLIC_MCP_ENABLED=false`.
3. Or redeploy the previous image/manifests (`git checkout <previous> -- kubernetes/seo-agent-*.yaml`, apply; restore
   `seo-agent-60-reindex.yaml` from git history if you also go back to v3's agent).
4. Data: migration 0016 is additive; its manual rollback is `src/db/rollback/0016_seo_v4.down.sql` (deletes flow-run
   history, notes and every MCP client/grant/token). Report PDFs stay in R2.


---

# v5: RAG quality and SEO-side ML

Nothing here is automatic: each step is for a person, in order. The kube-context guard (`scripts/lib/kube-context.sh`)
asks which cluster to use unless you set `KUBE_CONTEXT`.

## 29. Migrations 0018 and 0019 (additive)

They run when the web app starts (like every migration). 0018 adds two columns to `seo_ask_log`. 0019 adds the ML
tables (`seo_ml_*`, `seo_ga4_page_pairs`, `seo_rag_eval_runs`) and the `prompt_version` / `source` columns on
`seo_query_intents` / `seo_query_clusters`. Manual rollbacks: `src/db/rollback/0019_seo_v5_ml.down.sql`, then
`0018_seo_v5_rag.down.sql`.

## 30. Apply the seo-agent group (ConfigMap + the new CronJob)

```bash
scripts/manifests.sh seo-agent | kubectl diff -f -
scripts/manifests.sh seo-agent | kubectl apply -f -
kubectl -n jithendar rollout restart deploy/seo-agent
```

New in `seo-agent-config`: `RAG_MODE=vector`, `RAG_MAX_PER_ARTICLE=3`, `ASK_BLOG_MIN_SCORE=0.66`,
`RAG_RERANKER_ENABLED=false` (RAG.md "Defaults"). New CronJob `seo-flow-ml` (Sundays 04:47 UTC) → `seo_ml_flow`.
`SEO_LLM_MONTHLY_BUDGET_USD` is now `15` here; set the same value in `jithendar-com-public` if it is set there.

## 31. First reindex after the deploy (re-embeds everything once)

The token-aware chunker changes every chunk's stored hash, so the next reindex embeds all ~1.8k chunks once (like a
full reindex: a few minutes, ~0.7 GiB peak). Run it on demand instead of waiting for Sunday:

```bash
kubectl -n jithendar create job --from=cronjob/seo-flow-reindex seo-reindex-v5
```

(or `POST /api/admin/seo/agent/reindex` as an admin, or the admin MCP `kickoff_flow`). Check: Grafana "SEO agents" →
**ML & RAG** → "Truncated chunks" stays 0, and the p95 of embedded chunk tokens is under 480.

## 32. First evaluation runs

- **Retrieval, real model:** GitHub → Actions → **RAG eval (manual)** → Run workflow (defaults compare all
  configurations). The job summary has the table; commit the reports worth keeping under `docs/seo/rag-eval/`.
- **Retrieval, live index:** the first `seo_ml_flow` run records it (ML models → "Retrieval evaluation"). To run it
  now: Admin → SEO → ML models → **Run now**.
- **Floor check after a week of Ask-the-Blog traffic** (read-only):
  `DATABASE_URL=… uv run python scripts/rag_calibrate.py` in `services/seo-agent`.

## 33. Your labelling tasks

1. **Query groupings (clusters):** ML models → **Ask Claude for suggestions** (one Haiku call), then Labelling →
   Query groupings. Confirm or change the group of each of the 200 queries. The clustering model can be activated
   once ≥ 100 are confirmed and it beats the token-set rule.
2. **Intent disagreements:** after the first training with ≥ 300 Haiku labels, Labelling → Intent disagreements:
   pick the right intent for up to 50 queries. The classifier is used only after these 50 checks and macro-F1 ≥ 0.85.
3. **Decay back-test review:** when ML models shows the decay model as "needs review", read its real back-test (alert
   rate vs the rule, agreement) and click **Reviewed: use the model** if it looks right.
4. **Weight proposals** (after ≥ 50 measured outcomes): Settings → "ML models & retrieval" → approve or dismiss.

## 34. Related-articles experiment

It starts by itself with the first `seo_ml_flow` run: even article ids show the model's list. To measure it, GA4 must
receive the `related_click` event (sent by the block, consent permitting): in GA4 → Admin → Custom definitions, add an
event-scoped dimension `arm` (and optionally `position`). After ≥ 28 days compare `related_click` ÷ article page views
per arm (Explore → Free form). The page-pair report for co-visitation is tried by the daily GA4 sync; Integrations
shows `pagePairs: unsupported` if the property can't provide it.

## 35. Alerts and dashboard

- Alerts: copy the groups from [alerts-for-minikube-repo.yaml](alerts-for-minikube-repo.yaml) into the miniKube repo
  (OPERATIONS.md "Alerts handoff"). New group: `jithendar-com-seo-ml`.
- Dashboard: `grafana/jithendar-com-seo-agent.json` (in `mrjithendar/jithendar.com`) has a new **ML & RAG** row (Argo CD `grafana` app).

## 36. v5 rollback

- One ML feature: ML models → its **Use** select → `force the rule` (no restart).
- All ML: `kubectl -n jithendar patch cronjob seo-flow-ml -p '{"spec":{"suspend":true}}'`. Outputs go stale after 14
  days and every feature falls back to its rule.
- Retrieval: `RAG_MODE=vector` (already the default), `RAG_MAX_PER_ARTICLE=0` for v4's undiversified list,
  `ASK_BLOG_MIN_SCORE=0.15` for v4's floor, then `rollout restart deploy/seo-agent`.
- Code: `kubectl -n jithendar set image deploy/seo-agent seo-agent=registry.jithendar.com/jithendar/seo-agent:pr-<earlier number>`
  (every release keeps its tag), or revert the merge.

## 37. Promotion: Reddit API app and the promotion CronJobs

Promotion ([PROMOTION.md](PROMOTION.md)) works without any of this from the articles and Search Console data. These
steps add Reddit threads as a signal and the two schedules. Only a person can do them.

1. **Deploy order.** Merge, let CI build both images, then restart the site first (migration `0027_seo_promotion.sql`
   runs on start and adds three tables; the callback routes `/promotion/*` come with it) and the seo-agent second
   (`promotion_flow`, `content_ideas_flow`). Rollback of the tables: `src/db/rollback/0027_seo_promotion.down.sql`.
2. **Reddit app (requires manual configuration).** At <https://www.reddit.com/prefs/apps> choose "create another app",
   type **script**, any name (for example `jithendar-promotion`), redirect URI `https://jithendar.com` (unused, but the
   form requires one). Reddit may first ask you to accept its API terms; read the current terms and limits. The client
   id is the string under the app's name; the secret is labelled "secret".
3. **Store the credentials** (merged into the Secret `jithendar-com-env`; nothing is printed):

   ```bash
   KUBE_CONTEXT=mk4 scripts/set-reddit-config.sh
   kubectl -n jithendar rollout restart deployment/jithendar-com
   ```

4. **Test.** Admin → Promotion → Settings → "Test connection" makes one real read-only request. Then review the
   subreddits and channels on the same page.
5. **Schedules.** Apply the seo-agent group; it now includes `seo-agent-62-promotion-triggers.yaml` (CronJobs
   `seo-flow-promotion`, daily 07:40 UTC, and `seo-flow-content-ideas`, Tuesdays 05:20 UTC):

   ```bash
   scripts/manifests.sh seo-agent | kubectl diff -f -
   scripts/manifests.sh seo-agent | kubectl apply -f -
   ```

   Until then, the buttons "Find opportunities" and "Suggest content ideas" start the same flows by hand.
6. **To stop it.** Promotion → Settings → switch it off (the flows then end as `disabled`), or suspend the CronJobs:
   `kubectl -n jithendar patch cronjob seo-flow-promotion -p '{"spec":{"suspend":true}}'`.
