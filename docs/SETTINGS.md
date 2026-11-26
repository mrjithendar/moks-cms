# Settings: inventory and proposed organization

Status: **for the owner's review** (2026-11-26). Nothing here changes a setting, a default or a value. It records
every setting of moks-cms (the web app and, since D-105, the SEO agent in `seo-agent/`) and of jithendar.com's
deployment, sorts them into categories, lists what is wrong with today's arrangement and proposes one place per knob.
The reorganization itself comes after the decisions at the end, in small pull requests, one category at a time.

The full tables (every field, its storage, default, unit, precedence, reader `file:line`) are in:

| File | What | Rows |
|---|---|---:|
| [settings/admin-ui.md](settings/admin-ui.md) | Every setting an admin sees in `/admin`: the menu tree, where each field is stored, 31 flags | 523 |
| [settings/environment.md](settings/environment.md) | Every environment variable the web app reads, and how jithendar.com sets it (names only for Secrets) | 157 |
| [settings/seo-agent.md](settings/seo-agent.md) | Every agent setting: env, the admin registry groups, its own tables, the `seo-agent-config` ConfigMap | 172 |

Read at moks-cms `5645bd6` (D-105 merge) and jithendar.com #31. A row is one control or one group of sibling
controls; the same knob can appear in two files (an env var with an admin override is in both). Anything the
inventories mark *unverified* was inferred from code, not seen in the running site.

## 1. How a value is decided today

**Where settings live**

| Store | Holds | Edited in |
|---|---|---|
| `site_config` table (draft, published) | Appearance: identity, header, footer, homepage, blog, media display, Hire me, Settings → General | Appearance editor (needs **Publish**) |
| `setting` table, one row per key: `runtime`, `integrations`, `email`, `storage.r2`, `backups`, `invoices`, `practice`, `seo`, `promotion`, `ask_blog`, `seo_agent`, `crewai-repository`, `news` | Everything else in the web admin (saved at once) | Settings, Tools, AI & SEO, Billing, Practice, Posts → Promotion |
| Agent admin registry (`seo-agent/app/admin_settings`, 5 groups: agent-limits, retrieval, embeddings, mcp, knowledge-base) | 35 agent fields, through the agent's API | AI & SEO → Settings (4 of the 5 groups are drawn) |
| Agent tables | LLM providers and models, the one LLM budget | AI & SEO → Settings → LLM providers & budget |
| Records | Flow schedules, ML overrides, crews and their agents' models, content flows, profiles, skills | Their own pages |
| Environment: jithendar.com `30-jithendar-com.yaml` (both containers), ConfigMaps `jithendar-com-public` and `seo-agent-config`, Secrets `jithendar-com-env`, `seo-agent-env`, `seo-agent-rag`, … | Deployment facts and secrets, plus many values that also have an admin field | Git / `scripts/set-*.sh` / `create-*-secrets.sh`, then a restart |

**Which wins when the env and the admin both set a value** depends on the store (admin-ui.md flag 19,
environment.md flag 6, seo-agent.md F1):

| Admin wins | Env wins (the admin field is hidden, ignored or capped) |
|---|---|
| Runtime groups (but a boolean can only be forced **on**: unticking deletes the value and the env applies again) | Media storage `R2_*`/`S3_*` (form hidden) |
| Social sign-in, Gemini, once saved (even "disabled") | `INDEXNOW_KEY` |
| Email, once saved (`SMTP_URL` until then) | `SEO_AGENT_URL` (the endpoint card does nothing on jithendar.com) |
| CrewAI repository | `SEO_ORCHESTRATOR`, `NEWS_DESK_ENABLED=false`, `ASK_BLOG_ENABLED` (kill switches) |
| SEO property ids | `ASK_BLOG_DAILY_BUDGET_USD` caps the admin's Ask budget |
| 17 agent ConfigMap keys that are also registry fields | `NEWS_IMAGE_PROVIDER` overrides the admin's cover provider, with no warning |

## 2. Proposed organization

**Rules** (proposal, for decision D1–D3 below):
1. **One home per knob.** Every setting is edited in exactly one place; other pages link to it.
2. **Settings are under Settings.** Feature pages (Posts, Flows, Runs, Practice…) keep their operational content
   and a "Settings" link to their category; they hold no settings of their own.
3. **The environment holds deployment facts only**: URLs and ports between services, secrets, the database,
   observability, and documented kill switches. Anything else that has an admin field is the admin's; where the env
   still sets it, the field says "set by the deployment" and is read-only.
4. **Empty means "no limit" or "off"**, everywhere (no preset numbers; values stay as they are until the owner sets
   them).
5. **One unit per kind**: durations in seconds (minutes or days only where the name says so), money in USD with 2
   decimals, sizes in MB, shares as a percent. Every field shows its unit, its default and what empty means.

**Proposed categories and their homes**

| # | Category | Home (proposed) | What moves there (today's place) |
|---|---|---|---|
| 1 | **Site & appearance** | Appearance (draft → Publish), unchanged | Identity, branding, header, navigation, footer, typography, homepage, blog, media display, Hire me layout |
| 2 | **Access & users** | Settings → Access | Reader sign-up and maintenance mode (Settings → General, now behind Publish), social sign-in and Turnstile (Integrations), members-only articles and profile pictures (Users → All users) |
| 3 | **Content & publishing** | Settings → Publishing | Comment moderation (General), promotion settings (Posts → Promotion), **one** IndexNow switch and one URL Inspection switch (Integrations + AI & SEO → Content & links), sitemap/submission |
| 4 | **Email & notifications** | Settings → Email | Provider, test message, and every recipient list (reports, draft digest) |
| 5 | **Media & storage** | Settings → Media & storage | R2/S3, video destinations, Cloudflare Stream; image display stays in Appearance |
| 6 | **Payments & bookings** | Settings → Payments | Razorpay (Billing → Payments), invoice settings (`/admin/invoices/settings`, not in the menu), Cal.com (Comments → Bookings), paid-call prices (Hire me) |
| 7 | **Search & SEO** | Settings → Search & SEO, **reachable without the SEO agent** | GSC/GA4 properties, sync, scoring, crawler, reports, DataForSEO, keyword refresh times (today all behind the agent's module gate although the web worker uses them when the agent is off) |
| 8 | **AI models, keys & spend** | Settings → AI | One list of providers and keys (the agent's LLM providers) used by everything: Gemini images and video, SEO enrichment, the practice tutor, crews, news, Ask. One model picker. **One "Spend & limits" page** with the one LLM budget and every other cap side by side |
| 9 | **SEO agent** | AI & SEO → Settings | Endpoint (once, not twice), agent limits and timeouts, run history, retrieval and embeddings, **knowledge base (moks-rag)** (registered but drawn nowhere today), schedules (one page: flow schedules) |
| 10 | **Assistants** | AI & SEO → Settings → Assistants | Ask the Blog **with** its retrieval knobs (today split into ML & retrieval), MCP with **one** switch per server that both containers read |
| 11 | **Content flows (news desk)** | AI & SEO → Settings → Content flows | The `news` settings, image provider (once: per profile, with one default), content-flow limits (today under "Agent limits") and log retention (today under "Run history") |
| 12 | **Practice** | Settings → Practice | The 24 settings of the Practice page's last card; its tutor uses category 8's keys and budget |
| 13 | **Integrations** | Settings → Integrations | Analytics & ads, search engine verification, Hybrid RAG (moks-rag), CrewAI configuration repository, and **all Cloudflare credentials** (today on Cache, Integrations and Media & storage) |
| 14 | **System** | Tools | Backups (which should include the `setting` rows), cache policy, site health, database, audit log |

## 3. Problems, most serious first

Evidence (`file:line`) is in the detail files; the number in brackets is the flag there.

### P1. Settings that do not do what they say

1. **MCP on/off is in two stores.** The web gates `/ai-assistants`, `/mcp-oauth`, `llms.txt` and the footer link on its
   own env `PUBLIC_MCP_ENABLED`/`ADMIN_MCP_ENABLED`, which only `seo-agent-config` sets; the admin switch edits the
   agent's registry copy. Switching a server on in the admin changes nothing on the web side. [admin-ui A1, environment 1]
2. **Saved LLM providers and models are not used for calls.** A switched-off model still runs, a saved key is unused
   and admin-entered prices are ignored; a crew agent's model comes from five other sources. [seo-agent F7]
3. **`NEWS_IMAGE_PROVIDER=template` silently overrides the admin's cover provider**; the warning only appears when the
   web container has the variable, which it never does. [seo-agent F4, environment 2]
4. **The docs allowlist can only shrink**: the admin field changes the agent's check, but the web's fetcher keeps its
   own env/default list, so an added host is still refused. [seo-agent F2]
5. **The "Shared knowledge base" agent group has no page**, so semantic cannibalization stays off and the moks-rag
   timeouts have no UI, though the agent README points to it. [seo-agent F3, admin-ui 15]
6. **Every Search & SEO setting is unreachable while the SEO agent is not installed**, yet the web worker runs all
   those jobs from them then; and its Schedules section is mostly ignored whenever it can be opened (only
   `gscDaily.hourUtc` still times two jobs). [admin-ui 13, 14]
7. **Backups leave out the `setting` rows**: a restore loses the SEO, news, Ask, promotion, invoice, practice, backup
   and runtime settings. [admin-ui 23]
8. **Admin values cannot switch off an env value**: a runtime boolean can only be forced on, and text fields cannot
   clear an env value (e.g. `CF_STREAM_ENABLED`, GA4, ads.txt, verification tokens from `jithendar-com-public`).
   [environment 3]
9. **Zero means "default" for image and video limits** (`Number(v) || default`): 0 becomes 10/50/3/10 though the
   fields accept 0; there is no "no limit". [environment 8]
10. **Saving a runtime group on Integrations or Media & storage lands on the wrong section** (redirect uses `#group`,
    the pages use `?section=`); the guide's links do the same. Read in code, not run. [admin-ui 18]
11. **Timeouts don't compose**: the admin allows a model request limit up to 900 s, a crew waits at most 300 s per
    call, the SDK retries twice, and nothing checks crew against flow timeouts. [seo-agent F8]
12. **Site health shows Razorpay from the env only**, so keys saved in Admin → Payments show "not configured".
    [environment 9]
13. **`SEO_AGENT_SETTINGS_KEY` is not created by `create-seo-agent-secrets.sh`**, so secret agent settings and provider
    keys cannot be saved unless it was added by hand (live Secret not checked). [seo-agent F14]

### P2. One knob in several places

- **API keys**: Gemini/LLM keys in 4 admin places plus the env (Integrations → Image generation, the agent's
  providers, `seo.llmKey`, `practice.ai.apiKey`); the last two fall back to env vars, not to the saved key.
  [admin-ui A2]
- **Spend limits**: the one LLM budget plus at least 7 others (Ask daily budget, capped again by
  `ASK_BLOG_DAILY_BUDGET_USD`; Practice daily budget and prices; news image USD caps; DataForSEO monthly budget;
  `seo.llm.dailyRequestLimit`; Gemini image/video counts), and the CMS's own SEO-enrichment and tutor calls are
  probably outside the one budget (*unverified*). [admin-ui A3, seo-agent F6]
- **Models**: chosen in at least 9 places (drafts, news writer/fast/vision, each content flow, each crew agent,
  `seo.llm.model`, AI visibility, practice, Gemini image/video, the providers' enabled models). The news "Writer model"
  is recorded on drafts it did not write. [admin-ui A6, seo-agent F7]
- **Cover image provider**: 4 places. **Ask the Blog**: split between Assistants and ML & retrieval, plus two env
  master switches. **IndexNow** and **URL Inspection**: two switches each; the first SEO submission silently turns the
  Integrations one on. **Weekly article caps** and draft concurrency: one value per mode (agent or web worker).
  **SEO agent endpoint**: drawn twice. **Scoring weights**: two writers. **Cloudflare credentials**: 3 pages.
  **Report recipients**: 2 lists. [admin-ui A4–A12]
- **Names that differ between the two apps for one thing**: `RAG_COLLECTION` (web) vs `RAG_CMS_COLLECTION` (agent);
  `SEO_AGENT_CALLBACK_PORT` and `SEO_AGENT_CALLBACK_URL` must change together; tokens and `ANTHROPIC_API_KEY` are in both
  `jithendar-com-env` and `seo-agent-env`, and since D-105 both containers run in the same pod. [environment 10]
- **The RAG token**: the web lets an admin save `RAG_API_URL`/`RAG_BEARER_TOKEN`; the agent refuses exactly that on
  purpose ("a saved URL would send the shared token wherever it points"). [admin-ui 21]

### P3. Dead, legacy or misleading

- Read by nothing: `SEO_LLM_MONTHLY_BUDGET_USD "15"` in `seo-agent-config` (with a stale "keep equal" comment),
  `METRICS_TOKEN` (generated into `jithendar-com-env`), the news `llm_daily_usd`/`llm_monthly_usd` fields (stored, not
  enforced, no form), `blog.article.showCover`, `header.preset`. [environment 5, 7; seo-agent F5; admin-ui 16]
- A stale `DATABASE_URL` in `jithendar-com-env`, always overridden; Admin → Database still tells admins to change it
  there. [environment 6]
- Legacy names still read: `SEO_ORCHESTRATOR` with its `langgraph` alias, `VERCEL_ENV`, `REDIS_URL`. [environment 5]
- 62 variables the web reads are missing from `.env.example`. [environment 1]
- After D-105: the agent's secret scripts still say "restart `deploy/seo-agent`" (now 0 replicas; restart
  `deploy/jithendar-com`). [seo-agent F14]
- Out-of-date text: Appearance → SEO & integrations says integrations live in Kubernetes Secrets; Hire me says no
  booking script is loaded right above the Cal.com pop-up toggle. [admin-ui 26]

### P4. Rules applied differently

- The env/admin precedence table in section 1.
- **Settings → General** is the Appearance draft (needs Publish) while every other Settings page saves at once, and it
  mixes comment moderation, sign-up and maintenance mode with the site identity. [admin-ui 20]
- **Preset limits that cannot be emptied**, against "empty = no limit": Ask daily budget (min 0.05, default 1), news
  `max_drafts_per_day` 10 / image caps 1 and 10 / concurrency 2, DataForSEO 5, `seo.llm.dailyRequestLimit` 100,
  Practice quotas, Gemini limits. The LLM budget is the only one that follows the rule. [admin-ui 22]
- **Units**: durations in ms, s, min, h and days; times of day as a UTC hour + weekday or a cron + time zone; sizes in
  bytes or MB; shares as 0–1, percent or a 0–100 score; currency lists differ (invoices 8, Hire me 6, paid calls 2).
  Booleans are parsed four different ways from env. [admin-ui 29, environment 8, seo-agent F11]
- **Labels**: 96 of the 152 Search & SEO fields have no help line and show labels built from keys ("Gsc Property",
  "Hour Utc"); menu names differ from page titles ("Customise" / "Appearance & site settings", "Site health" /
  "System status"…); pages hold things their names don't suggest (Cloudflare credentials under Cache, members-only
  under Users, paid-call prices under Pages → Hire me). [admin-ui 24, 25, 28]
- **Site-specific text in the product**: "Proves ownership of jithendar.com", the AdSense id as a default, webhook URLs
  on jithendar.com, `SITE_URL` defaults to jithendar.com in `posts.ts` and `seo-intel/urls.ts`. [admin-ui 27,
  environment 10]

### P5. Several agents at once (D-105: one agent per site pod, KEDA 2–8)

Per pod, not per site: the public MCP rate and daily limits (so up to 8× the set value), budget holds and in-flight
reservations, the Ask cap and answer cache. A save applies at once only in the pod that served it, the others within
30–60 s; "restart pending" reflects the pod that answered, so after a scale-up pods can run mixed values. Gauges read
from the database are reported by every pod (dashboards use `max()`). [seo-agent F9, DECISIONS D-105]

### P6. Guide and search

About 150 fields are missing from the User manual's Settings reference (so from its search): all `news` fields, all 35
agent registry fields, the LLM budget and providers, Ask, Promotion, Practice, Backups, the SEO agent endpoint, the
CrewAI repository, flow schedules and ML overrides. The admin menu filter searches page names only. [admin-ui 31]

## 4. Decisions for the owner

Each is a choice for you; the proposal is marked. Values are never chosen here.

| # | Question | Proposal |
|---|---|---|
| D1 | When the env and the admin both set a value, which wins? | The admin, everywhere, except deployment facts and named kill switches; the field then shows "set by the deployment" and is read-only |
| D2 | One home per knob, under Settings by category (section 2)? | Yes, starting with categories 8 (AI), 10 (Assistants) and 13 (Integrations), where most duplicates are |
| D3 | Empty = no limit everywhere (section 2, rule 4)? Today's preset numbers stay as saved values until you change them | Yes |
| D4 | One provider/key list (the agent's LLM providers) for Gemini images, SEO enrichment and the practice tutor, and the agent using its saved providers, models and prices at call time | Yes |
| D5 | Which spend caps stay next to the one LLM budget: Ask daily, Practice daily, news image USD, DataForSEO monthly, LLM requests per day, Gemini image/video counts? | Keep each as its own row on one "Spend & limits" page, empty = no limit |
| D6 | MCP: one switch per server, kept by the agent and read by the web | Yes |
| D7 | Search & SEO reachable without the SEO agent, and the web-worker Schedules section removed (flow schedules are the only schedules) | Yes |
| D8 | Backups include the `setting` rows (secrets excluded or encrypted with the backup key) | Yes, with the backup's existing encryption |
| D9 | Split Settings → General: identity stays in Appearance (Publish); comment moderation, sign-up and maintenance mode move to Access and Publishing (save at once) | Yes |
| D10 | One Secret for what both containers share now that they are one pod (`ANTHROPIC_API_KEY`, agent and callback tokens) | Yes, in jithendar.com |
| D11 | Public MCP limits counted per pod, or shared through Postgres | Shared (per pod multiplies them by the pod count) |
| D12 | Remove the dead and legacy names in P3 (stored values stay readable for one release) | Yes |
| D13 | Units: seconds, USD (2 decimals), MB, percent | Yes |

## 5. After the decisions

One pull request per category (or per decision where it spans categories), each: move the fields to their home,
redirect the old addresses, keep stored values, add the fields to the User manual's Settings reference and its
search, and a test that every registry field has a guide row. No value changes unless decided.
