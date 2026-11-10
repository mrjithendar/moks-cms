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
- **Alerts**: copy `www/docs/seo/prometheus-alerts.yml` into the miniKube repo (OPERATIONS.md#alerts).
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
