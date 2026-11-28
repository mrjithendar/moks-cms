# moks-cms web app: environment variables, and how jithendar.com sets them

Read-only inventory. Code: moks-cms at `5645bd6` (`seo-agent/` excluded except where a name is
compared). Deployment: jithendar.com at `4b4b411` . Paths below are relative to those two roots
(`src/…`, `cache-handler.mjs`, `Dockerfile` = moks-cms; `kubernetes/…`, `scripts/…` = jithendar.com). Secret VALUES were
never read; only key names.

How the names were found: every `process.env.X`, `env.X` / `env?.X` / `e.X` on an env object, `(x ?? process.env).X`,
`process.env[name]` (runtime-settings.ts field table, integrations.ts `${PREFIX}_CLIENT_ID`), `get("X")` in
video-destinations.ts, and every `env: "X"` field in `src/lib/runtime-settings.ts`, in `src/`, `cache-handler.mjs`,
`next.config.ts` (none), `src/instrumentation.ts`, plus `scripts/use-site.mjs` (runs before dev/build) and the Dockerfile.
Tests (`*.test.ts[x]`) excluded. 153 names are read by the web app's code, plus 4 named in `.env.example` that only a
library or a build script reads (AWS_*, SITE, SITE_DIR) = 157 rows.

## Legend

**Admin override** (who wins):

- **RS** = a field of `src/lib/runtime-settings.ts` GROUPS. Code reads it through `effectiveEnv()`
  (runtime-settings.ts:250-263): a non-empty value saved in the admin wins; an empty field falls back to the env.
  Secrets are sealed with SETTINGS_ENCRYPTION_KEY. Boolean fields can only be saved as "true" or removed
  (runtime-settings.ts:313-318), so the admin can force a boolean ON but cannot override an env `true` to off; likewise a
  text field cannot clear a value the env sets (unless the field has an explicit "off" value). Changes broadcast
  `integrations` over the cache bus: live on every replica.
- **INT** = the `integrations` setting document (`src/lib/integrations.ts`): once a provider / Gemini is saved in the
  admin, that entry wins entirely, including "disabled" (integrations.ts:18-19, 74-85, 144-158); "Reset" returns to env.
- **Store** = another admin document that wins over env when filled (named per row).
- **Env wins** = the env value beats the admin's.
- **None** = env only.

**Live/restart**: every env value is read from the pod's environment, so changing it needs a pod restart
(`kubectl rollout restart` or a deploy). Where an admin value exists it applies live; that is noted as
"restart (admin: live)". "startup" = read once when the process starts or a module loads.

**Set in jithendar.com**: `yaml:N` = literal `env` entry in `kubernetes/30-jithendar-com.yaml` (container `web`);
`Secret env (script:N)` = key written into Secret `jithendar-com-env` by that script; `CM public (script:N)` = ConfigMap
`jithendar-com-public` (both reach the container through `envFrom`, yaml:160-165; the ConfigMap is `optional: true`);
`image` = `ENV` in moks-cms `Dockerfile:117`. Explicit `env` entries win over `envFrom` for the same name.
"unverified" = could only exist in the live cluster (no manifest or script writes it).

---

## Site & URLs (3)

| Name | What | Default | Admin override | Read by | Set in jithendar.com | Live/restart |
|---|---|---|---|---|---|---|
| SITE_URL | Canonical origin (canonical URLs, sitemaps, feeds, JSON-LD, Better Auth baseURL) | `https://<site.json host>` in siteUrl(); but `https://jithendar.com` hard-coded in posts.ts:193 and seo-intel/urls.ts:20 | None (deliberately, runtime-settings.ts:19-20) | src/config/site.ts:28 | yaml:67 `https://jithendar.com` | restart |
| SITE_CONFIG_DIR | Folder holding site.json and config/ | `<cwd>/site` (= /app/site, the mounted ConfigMap jithendar-com-site) | None | src/config/site-files.ts:47 | not set (default path used; yaml mounts /app/site) | startup |
| MOKS_TENANT_ID | Tenant part of report storage keys `reports/<tenant>/<site>/…` | the site's host | None | src/lib/reports/service.ts:58 | not set | restart |

## Runtime & security (9)

| Name | What | Default | Admin override | Read by | Set in jithendar.com | Live/restart |
|---|---|---|---|---|---|---|
| APP_ENV | Production switch: indexing, GA4/AdSense, required secrets, submission default | unset = development (image sets `production`) | None | src/config/site.ts:39 (isProductionEnv); also db/index.ts:27, seo-intel/settings.ts:471, instrumentation.ts:20, health.ts:99 | yaml:65 `production`; image `production` | restart |
| NODE_ENV | Node/Next mode; JSON console in production; with APP_ENV, PGlite refusal | set by Next / image `production` | None | src/instrumentation.ts:8; db/index.ts:27; proxy.ts:63; content/index.ts:30 | image `production` | startup |
| VERCEL_ENV | Alternative production flag (Vercel leftover) | unset | None | src/config/site.ts:39 | not set | restart |
| NEXT_RUNTIME | Skip instrumentation outside the Node runtime | set by Next | None | src/instrumentation.ts:5 | (Next internal) | startup |
| HOSTNAME | Bind address of Next's standalone server.js; also used as the pod label in cache-bus connection names and Admin → Cache | image `0.0.0.0`; code fallback `local` | None | src/lib/cache-bus.ts:73; src/lib/cache-admin.ts:104 (+ Next server.js, implicit) | image `0.0.0.0` (whether the runtime's pod-name HOSTNAME or the image ENV wins in the pod: unverified) | startup |
| PORT | Port the page warm-up calls itself on (Next's server.js also reads it) | 3000 | None | src/lib/warm.ts:30 | not set (Dockerfile:111-113 deliberately leaves it unset; the agent container uses PORT=8080) | startup |
| TRUSTED_EDGE | Whose client-IP headers to trust: `cloudflare` (CF-Connecting-IP only from CF ranges) or `gateway` | `cloudflare` | None | src/lib/client-ip.ts:150 | yaml:72 `cloudflare` | restart |
| CLOUDFLARE_IP_RANGES | Replaces the built-in Cloudflare CIDR list (comma/space separated) | built-in CLOUDFLARE_RANGES | None | src/lib/client-ip.ts:134 | not set | restart |
| SETTINGS_ENCRYPTION_KEY | Seals admin secrets and backups (sha256 of the value); also fallback for PRACTICE_USER_HASH_KEY | dev-only constant outside production; production throws if < 32 chars | None (deliberately) | src/lib/secrets.ts:10 | Secret env (create-secrets.sh:33) | restart (rotating it orphans every sealed value) |

## Database & cache (10)

| Name | What | Default | Admin override | Read by | Set in jithendar.com | Live/restart |
|---|---|---|---|---|---|---|
| DATABASE_URL | Postgres connection (postgres.js); also gates migrations/worker at start | unset = embedded PGlite (refused when NODE_ENV and APP_ENV are production) | None | src/db/index.ts:13; instrumentation.ts:42-43; db-admin.ts:43 | yaml:155 secretKeyRef `postgres-db-credentials/uri`; a stale copy is still in Secret env (yaml:153-154 comment), shadowed by the explicit entry | startup |
| DATABASE_POOL_MAX | postgres.js pool size per pod | 5 | None | src/db/index.ts:19 | not set (KEDA max 8 pods is sized on 5: kubernetes/35-autoscaling.yaml:31) | startup |
| DATABASE_CONNECT_TIMEOUT_SECONDS | Connect timeout (seconds) | 10 | None | src/db/index.ts:23 | not set | startup |
| PGLITE_DIR | PGlite data folder (local dev) | `.data/pglite` | None | src/db/index.ts:32 | not set | startup |
| MIGRATIONS_DIR | Migrations folder | `<cwd>/src/db/migrations` | None | src/db/migrate.ts:11 | not set | startup |
| REDIS_URL | Moves Better Auth sessions, rate limits, API keys to Redis; cache-bus fallback | unset = Postgres, no Redis | None | src/lib/redis.ts:14; cache-bus.ts:61; health.ts:43 | not set (removed 2026-11-09, yaml:105-106) | startup |
| CACHE_BUS_REDIS_URL | Pub/sub-only Valkey for cross-replica cache invalidation | falls back to REDIS_URL, else local-only (TTL convergence) | None | src/lib/cache-bus.ts:59 | yaml:111 secretKeyRef `redis-site-cachebus-credentials/uri` (optional) | startup |
| PAGE_CACHE_MAX_MB | Memory cap of the ISR page cache (MB) | 64 | None | cache-handler.mjs:20 (display copy: src/lib/cache-admin.ts:107) | not set | startup |
| PAGE_WARMUP | `false` turns off rendering every public page after start | on | None | src/lib/warm.ts:118, 129 | not set | startup |
| AUDIT_LOG_RETENTION_DAYS | Delete audit entries older than N days (values < 30 ignored) | keep forever | None | src/lib/retention.ts:22 | not set | restart (read at each daily prune) |

## Storage & media (23)

| Name | What | Default | Admin override | Read by | Set in jithendar.com | Live/restart |
|---|---|---|---|---|---|---|
| R2_ACCOUNT_ID | R2 account (S3 endpoint host) | unset = use Admin → Storage | **Env wins**: any R2_* (or S3_*) set → admin storage ignored (storage.ts:161-163) | src/lib/storage.ts:117, 135-145 | Secret env (set-media-config.sh:25) | restart |
| R2_BUCKET | Bucket | — | Env wins | src/lib/storage.ts:146 | Secret env (set-media-config.sh:26) | restart |
| R2_ACCESS_KEY_ID | Access key | — | Env wins | src/lib/storage.ts:147 | Secret env (set-media-config.sh:27) | restart |
| R2_SECRET_ACCESS_KEY | Secret key | — | Env wins | src/lib/storage.ts:138 | Secret env (set-media-config.sh:28) | restart |
| R2_PUBLIC_BASE_URL | Public delivery domain for large media redirects | "" (served through /media) | Env wins | src/lib/storage.ts:149 | Secret env (set-media-config.sh:29, optional) | restart |
| R2_ENDPOINT | S3 API endpoint override (EU jurisdiction, emulator) | `https://<account>.r2.cloudflarestorage.com` | Env wins | src/lib/storage.ts:143-145 | not set | restart |
| S3_REGION | Amazon S3 alternative (only when no R2_*) | — | Env wins | src/lib/storage.ts:118-127 | not set | restart |
| S3_BUCKET | S3 bucket | — | Env wins | src/lib/storage.ts:128 | not set | restart |
| S3_ACCESS_KEY_ID | S3 key | — | Env wins | src/lib/storage.ts:129 | not set | restart |
| S3_SECRET_ACCESS_KEY | S3 secret | — | Env wins | src/lib/storage.ts:120 | not set | restart |
| S3_ENDPOINT | S3-compatible endpoint override | `https://s3.<region>.amazonaws.com` | Env wins | src/lib/storage.ts:125-127 | not set | restart |
| S3_PUBLIC_BASE_URL | S3 public base | "" | Env wins | src/lib/storage.ts:131 | not set | restart |
| VIDEO_DEST_R2_DISABLED | Negative switch: removes the site's media library as a video destination | false (R2 on) | RS (Admin → Storage → Video destinations); boolean, can only force true | src/lib/video-destinations.ts:44 | not set | restart (admin: live) |
| CF_STREAM_ENABLED | Cloudflare Stream destination on | false | RS boolean (cannot turn an env `true` off) | src/lib/video-destinations.ts:45 | not set | restart (admin: live) |
| CF_STREAM_ACCOUNT_ID | Stream account | — | RS | src/lib/video-destinations.ts:111 | not set | restart (admin: live) |
| CF_STREAM_API_TOKEN | Stream token (secret) | — | RS (sealed) | src/lib/video-destinations.ts:111, 166 | not set | restart (admin: live) |
| CF_STREAM_CUSTOMER_CODE | `customer-<code>` playback host | — | RS | src/lib/video-destinations.ts:107 | not set | restart (admin: live) |
| MUX_ENABLED | Mux destination on | false | RS boolean | src/lib/video-destinations.ts:46 | not set | restart (admin: live) |
| MUX_TOKEN_ID | Mux token id | — | RS | src/lib/video-destinations.ts:120 | not set | restart (admin: live) |
| MUX_TOKEN_SECRET | Mux token secret | — | RS (sealed) | src/lib/video-destinations.ts:120 | not set | restart (admin: live) |
| BUNNY_STREAM_ENABLED | Bunny Stream destination on | false | RS boolean | src/lib/video-destinations.ts:47 | not set | restart (admin: live) |
| BUNNY_STREAM_LIBRARY_ID | Bunny library | — | RS | src/lib/video-destinations.ts:133 | not set | restart (admin: live) |
| BUNNY_STREAM_API_KEY | Bunny library key | — | RS (sealed) | src/lib/video-destinations.ts:135 | not set | restart (admin: live) |

## Email (4)

| Name | What | Default | Admin override | Read by | Set in jithendar.com | Live/restart |
|---|---|---|---|---|---|---|
| SMTP_URL | SMTP fallback (`smtp://`/`smtps://` only), used with MAIL_FROM | none (mail off; sign-up then skips email verification) | Store (Admin → Email): once an admin saves a choice it wins (mail.ts:23, 108, 321) | src/lib/mail.ts:181 | Secret env (create-secrets.sh:39, only if entered) | restart (admin: live) |
| MAIL_FROM | From header for the SMTP fallback (both required) | none | Store (Admin → Email) | src/lib/mail.ts:182 | Secret env (create-secrets.sh:39, only with SMTP_URL) | restart (admin: live) |
| AWS_ACCESS_KEY_ID | AWS SDK default chain (SES "server's AWS credentials", Bedrock providers) | none | Store (Admin → Email picks SES mode) | implicit, AWS SDK (no direct read in src/) | not set | restart |
| AWS_SECRET_ACCESS_KEY | as above | none | as above | implicit, AWS SDK | not set | restart |

## Auth & users (12)

| Name | What | Default | Admin override | Read by | Set in jithendar.com | Live/restart |
|---|---|---|---|---|---|---|
| BETTER_AUTH_SECRET | Better Auth signing secret; also key of Ask-the-Blog IP hashes | dev-only constant; production throws if unset | None (deliberately) | src/lib/auth.ts:49; seo-agent/ask.ts:9 | Secret env (create-secrets.sh:32) | restart |
| ADMIN_BOOTSTRAP_TOKEN | One-time /setup token (≥ 32 chars, else setup disabled) | none = setup disabled | None | src/app/setup/actions.ts:29; setup/page.tsx:14 | Secret env (create-secrets.sh:34) | restart |
| GOOGLE_CLIENT_ID | Google sign-in client id | none = no button | INT (Admin → Integrations; saved entry wins incl. disabled) | src/lib/auth-providers.ts:12 (via integrations.ts:74-85) | Secret env (set-oauth-config.sh:25) | restart (admin: live, Better Auth rebuilt auth.ts:211) |
| GOOGLE_CLIENT_SECRET | Google client secret | none | INT | src/lib/auth-providers.ts:13 | Secret env (set-oauth-config.sh:26) | restart (admin: live) |
| GITHUB_CLIENT_ID | GitHub sign-in client id | none | INT | src/lib/auth-providers.ts:12 | Secret env (set-oauth-config.sh:29) | restart (admin: live) |
| GITHUB_CLIENT_SECRET | GitHub client secret | none | INT | src/lib/auth-providers.ts:13 | Secret env (set-oauth-config.sh:30) | restart (admin: live) |
| TURNSTILE_SITE_KEY | Cloudflare Turnstile site key (sign-in, sign-up, comments, contact) | Cloudflare test key outside production; none in production | RS (Admin → Integrations → Turnstile) | src/lib/turnstile.ts:10, 21 (via effectiveEnv :20) | Secret env (create-secrets.sh:36, required) | restart (admin: live) |
| TURNSTILE_SECRET_KEY | Turnstile secret | test secret outside production | RS (sealed) | src/lib/turnstile.ts:14 | Secret env (create-secrets.sh:37, required) | restart (admin: live) |
| MEMBERS_PREVIEW_PERCENT | Share of a members-only article shown signed out (5–95) | 30 | RS (Admin → Users) | src/lib/members.ts:26 | not set | restart (admin: live) |
| AVATAR_MAX_BYTES | Avatar upload limit (bytes, 64 KB–10 MB) | 2097152 | RS (Admin → Users) | src/lib/avatar.ts:22 | not set | restart (admin: live) |
| AVATAR_MAX_DIMENSION | Largest accepted side (px) | 4096 | RS | src/lib/avatar.ts:23 | not set | restart (admin: live) |
| AVATAR_MIN_DIMENSION | Smallest accepted side (px) | 64 | RS | src/lib/avatar.ts:24 | not set | restart (admin: live) |

## Payments & bookings (4)

| Name | What | Default | Admin override | Read by | Set in jithendar.com | Live/restart |
|---|---|---|---|---|---|---|
| RAZORPAY_KEY_ID | Razorpay key id (public, sent to Checkout) | none = paid calls/invoice links off | RS (Admin → Payments) | src/lib/razorpay.ts:40 | not set | restart (admin: live) |
| RAZORPAY_KEY_SECRET | Razorpay key secret | none | RS (sealed) | src/lib/razorpay.ts:40 | not set | restart (admin: live) |
| RAZORPAY_WEBHOOK_SECRET | Webhook signature secret | none | RS (sealed) | src/app/api/razorpay/webhook/route.ts:15; razorpay.ts:40 | not set | restart (admin: live) |
| CAL_WEBHOOK_SECRET | Cal.com webhook signature secret | none = webhooks refused | RS (Admin → Bookings) | src/app/api/cal/webhook/route.ts:15 | not set | restart (admin: live) |

## Content & editor (4)

| Name | What | Default | Admin override | Read by | Set in jithendar.com | Live/restart |
|---|---|---|---|---|---|---|
| CONTENT_DIR | File-based content mode (MDX root; tests); also disables DB categories/redirects | unset = Postgres | None | src/lib/content/load.ts:37; content/index.ts:27; categories.ts:15; redirects.ts:18 | not set | restart |
| CONTENT_SEED_DIR | Folder /setup imports from | `<cwd>/content` | None | src/app/setup/actions.ts:50 | not set | restart |
| CONTENT_PREVIEW | `true` shows unpublished work locally (ignored in production) | off | None | src/config/site.ts:47 | not set | restart |
| PUBLIC_DIR | Folder of shipped /images | `<cwd>/public` | None | src/lib/images.ts:12 | not set | restart |

## Search & SEO (15)

| Name | What | Default | Admin override | Read by | Set in jithendar.com | Live/restart |
|---|---|---|---|---|---|---|
| GOOGLE_SITE_VERIFICATION | Search Console meta token(s), comma list | none | RS (Admin → Integrations) | src/config/integrations.ts:53 | CM public (set-public-config.sh:18) | restart (admin: live) |
| BING_SITE_VERIFICATION | Bing meta token(s) | none | RS | src/config/integrations.ts:54 | CM public (set-public-config.sh:19) | restart (admin: live) |
| INDEXNOW_KEY | IndexNow key, served at /<key>.txt | none; admin can generate one | **Env wins** over the admin key (indexnow-key.ts:17-18; integrations.ts:265-266; UI says "Remove that variable to manage IndexNow here", admin/integrations/page.tsx:231) | src/lib/indexnow-key.ts:17; config/integrations.ts:62 | CM public (set-public-config.sh:26, only if "generate" chosen) | restart (admin key: live within 30 s) |
| INDEXNOW_ENDPOINT | IndexNow API URL override | `https://api.indexnow.org/indexnow` | None | src/lib/indexnow.ts:16; seo-intel/submission.ts:127 | not set | restart |
| SEO_SUBMISSION_ENABLED | Kill switch for IndexNow + sitemap resubmit + URL Inspection | on only when APP_ENV=production | None (admin Settings → submission toggles apply under it, settings.ts:170-176) | src/lib/seo-intel/settings.ts:468 | not set (so on in production) | restart |
| SEO_SUBMIT_DEBOUNCE_MS | Batching window for submissions (ms, clamped 1 s–10 min) | 60000 | None | src/lib/seo-intel/submission.ts:32 (module load) | not set | startup |
| GOOGLE_SEO_SERVICE_ACCOUNT_JSON | Service-account key (raw or base64) for GSC/GA4 | none = "Disconnected" | None (env only by design, google/auth.ts:7) | src/lib/seo-intel/google/auth.ts:28 | Secret env (set-seo-config.sh:26) | restart |
| SEO_GSC_PROPERTY | Search Console property | "" | Store: Admin → SEO Settings value wins (settings.ts:348-355) | src/lib/seo-intel/settings.ts:354 | CM public (set-seo-config.sh:32/34) | restart (admin: live) |
| SEO_GA4_PROPERTY_ID | Numeric GA4 property id | "" | Store: Admin → SEO Settings wins | src/lib/seo-intel/settings.ts:355 | CM public (set-seo-config.sh:32/34) | restart (admin: live) |
| PAGESPEED_API_KEY | PageSpeed Insights / CrUX key | none (low quota) | None (the on/off is in Settings) | src/lib/seo-intel/technical.ts:344 | Secret env (set-seo-config.sh:26, optional) | restart |
| DATAFORSEO_LOGIN | DataForSEO API login | none = off | None (env only by design, dataforseo.ts:21) | src/lib/seo-intel/dataforseo.ts:43 | Secret env (set-dataforseo-config.sh:20) | restart |
| DATAFORSEO_PASSWORD | DataForSEO API password | none | None | src/lib/seo-intel/dataforseo.ts:44 | Secret env (set-dataforseo-config.sh:20) | restart |
| REDDIT_CLIENT_ID | Reddit app id (Promotion, read-only) | none = "Requires manual configuration" | None | src/lib/seo-intel/promotion/reddit.ts:26 | Secret env (set-reddit-config.sh:26) | restart |
| REDDIT_CLIENT_SECRET | Reddit app secret | none | None | src/lib/seo-intel/promotion/reddit.ts:27 | Secret env (set-reddit-config.sh:26) | restart |
| REDDIT_USER_AGENT | User-Agent Reddit requires | `web:com.jithendar.promotion:v1.0 (+https://jithendar.com)` | None | src/lib/seo-intel/promotion/reddit.ts:30 | Secret env (set-reddit-config.sh:26, optional) | restart |

## AI & LLM (32)

| Name | What | Default | Admin override | Read by | Set in jithendar.com | Live/restart |
|---|---|---|---|---|---|---|
| ANTHROPIC_API_KEY | Claude key: legacy drafting/classify, SEO LLM provider "anthropic", AI-visibility Claude | none = rules only | None (env only by design: "never stored in the database", settings.ts:436) | src/lib/seo-intel/settings.ts:437, 460 | Secret env; no script writes it there (create-seo-agent-secrets.sh:21 only reads it from there): set by hand, unverified | restart |
| LITELLM_BASE_URL | LiteLLM's OpenAI-compatible API (…/v1): with LITELLM_API_KEY, every text call goes through LiteLLM (D-109, docs/LLM_GATEWAY.md) | none = providers directly | None | src/lib/llm-gateway.ts; seo-agent/app/config.py | Deployment env (jithendar.com manifests), both containers | restart |
| LITELLM_API_KEY | The LiteLLM virtual key of the web app (jithendar-com-env) or of the SEO agent (seo-agent-env) | none = gateway off | None | src/lib/llm-gateway.ts; seo-agent/app/llm_gateway.py | Secret env, written by moks-rag scripts/issue-litellm-keys.sh | restart |
| LITELLM_ASK_API_KEY | Ask the Blog's own LiteLLM key (its own budget), agent only | the agent's key | None | seo-agent/app/llm_gateway.py | Secret seo-agent-env (issue-litellm-keys.sh) | restart |
| LITELLM_PRACTICE_API_KEY | The Practice tutor's own LiteLLM key (its own budget) | the web key | None | src/lib/llm-gateway.ts | Secret jithendar-com-env (issue-litellm-keys.sh) | restart |
| LITELLM_MODEL_DEFAULT / LITELLM_MODEL_FAST / LITELLM_MODEL_PRACTICE | The aliases asked for (drafting and crews / classifying, Ask, enrichment / the tutor) | cms-claude-sonnet-latest / ops-claude-haiku-latest / the fast alias | None | src/lib/llm-gateway.ts; seo-agent/app/config.py | Deployment env | restart |
| LITELLM_UI_URL | Link to LiteLLM's Admin UI on the LLM settings page | none = no link | None | src/app/admin/(growth)/automation/sections/llm.tsx | Deployment env | restart |
| OPENAI_API_KEY | OpenAI key: SEO LLM (openai), AI visibility ChatGPT, practice tutor | none | Store: SEO LLM sealed key wins (settings.ts:438-440); practice AI key wins (practice/settings.ts:95-96); AI visibility env only (ai-visibility.ts:97) | src/lib/seo-intel/settings.ts:439; ai-visibility.ts:150; practice/settings.ts:96 | Secret env (set-ai-visibility-config.sh:20, optional) | restart (admin keys: live) |
| GEMINI_API_KEY | Gemini key: editor images/video, SEO LLM (gemini), AI visibility Gemini, practice tutor | none | INT for images/video (integrations.ts:148-153); Store for SEO LLM and practice (as above); AI visibility env only | src/lib/gemini.ts:59; seo-intel/settings.ts:439; ai-visibility.ts:101; practice/settings.ts:96 | Secret env (set-media-config.sh:32 and set-ai-visibility-config.sh:20: two scripts write the same key) | restart (admin: live) |
| PERPLEXITY_API_KEY | AI visibility: Perplexity Sonar | none | None | src/lib/seo-intel/ai-visibility.ts:99, 166 | Secret env (set-ai-visibility-config.sh:20, optional) | restart |
| SEO_DRAFT_MODEL | Claude drafting model (legacy/v2 path) | `claude-sonnet-5-5` | Store: Admin → Settings → Drafts wins (settings.ts:461) | src/lib/seo-intel/settings.ts:461 | not set for web (only in seo-agent-config:27) | restart (admin: live) |
| SEO_CLASSIFY_MODEL | Cheap classification (search intent) model | `claude-haiku-5-5` | Store: Drafts settings win (settings.ts:462) | src/lib/seo-intel/settings.ts:462 | not set for web (only in seo-agent-config:28) | restart (admin: live) |
| SEO_LLM_PRICES_JSON | Price override, USD per million tokens, JSON | built-in list prices (claude.ts:21-26) | None | src/lib/seo-intel/claude.ts:31 | not set | restart |
| GEMINI_API_ENDPOINT | Gemini image API URL override | `https://generativelanguage.googleapis.com/v1beta/interactions` | None (passes through INT) | src/lib/gemini.ts:71 | not set | restart |
| GEMINI_IMAGE_MODEL | "Fast" image model | none = image generation off | INT (saved Gemini entry's model wins) | src/lib/gemini.ts:60 | Secret env (set-media-config.sh:33) | restart (admin: live) |
| GEMINI_IMAGE_PRO_MODEL | Optional "Pro" image model | none = Fast only | INT | src/lib/gemini.ts:62 | not set | restart (admin: live) |
| GEMINI_IMAGE_SIZE | Default image size (512/1K/2K/4K) | `1K` | INT | src/lib/gemini.ts:68 | yaml:95 `1K` (equals the code default) | restart (admin: live) |
| GEMINI_IMAGE_MAX_SIZE | Largest size authors may pick | larger of size and 2K | INT | src/lib/gemini.ts:63 | not set | restart (admin: live) |
| GEMINI_IMAGE_TIMEOUT_MS | Image request timeout (ms, 5 000–300 000) | 90000 | RS (Image generation limits) | src/lib/gemini.ts:70 | yaml:97 `90000` (equals default) | restart (admin: live) |
| GEMINI_IMAGE_USER_HOURLY_LIMIT | Images per author per hour | 10 (0 also means 10) | RS | src/lib/image-generation.ts:35 | yaml:99 `10` (equals default) | restart (admin: live) |
| GEMINI_IMAGE_USER_CONCURRENCY | Parallel generations per author (1–5) | 1 | RS | src/lib/image-generation.ts:37 | yaml:101 `1` (equals default) | restart (admin: live) |
| GEMINI_IMAGE_DAILY_LIMIT | Images per rolling 24 h, whole site | 50 (0 also means 50) | RS | src/lib/image-generation.ts:36 | yaml:103 `50` (equals default) | restart (admin: live) |
| GEMINI_VIDEO_MODEL | Veo model; empty = video generation off | none | RS (Admin → Integrations → Video generation) | src/lib/video-generation.ts:61 | not set | restart (admin: live) |
| GEMINI_VIDEO_RESOLUTION | Optional resolution, sent only when set | none | RS | src/lib/video-generation.ts:63 | not set | restart (admin: live) |
| GEMINI_VIDEO_SECONDS | Optional clip length (seconds, 1–60) | model default | RS | src/lib/video-generation.ts:64 | not set | restart (admin: live) |
| GEMINI_VIDEO_USER_HOURLY_LIMIT | Videos per author per hour | 3 (0 also means 3) | RS | src/lib/video-generation.ts:77 | not set | restart (admin: live) |
| GEMINI_VIDEO_DAILY_LIMIT | Videos per rolling 24 h | 10 (0 also means 10) | RS | src/lib/video-generation.ts:77 | not set | restart (admin: live) |
| GEMINI_VIDEO_TIMEOUT_MS | Give up after (ms, 60 000–1 800 000) | 600000 | RS | src/lib/video-generation.ts:71 | not set | restart (admin: live) |
| GEMINI_VIDEO_ENDPOINT | Video API base override | `https://generativelanguage.googleapis.com/v1beta` | None | src/lib/video-generation.ts:68 | not set | restart |
| RAG_API_URL | moks-rag rag-api address | `http://rag-api.rag.svc.cluster.local:8000` | RS (Admin → Integrations → Hybrid RAG) | src/lib/rag/sync.ts:42 | yaml:139 (equals default) | restart (admin: live) |
| RAG_BEARER_TOKEN | rag-api token; unset = sync off | none | RS (sealed) | src/lib/rag/sync.ts:39 | yaml:145 secretKeyRef `jithendar-com-rag/token` (optional) | restart (admin: live) |
| RAG_COLLECTION | Collection posts sync into | `cms_content` | RS | src/lib/rag/sync.ts:44 | yaml:141 (equals default) | restart (admin: live) |
| RAG_SERVICE_NAME | X-Service-Name header | `moks-cms` | RS | src/lib/rag/sync.ts:45 | yaml:143 (equals default) | restart (admin: live) |
| CREWAI_CONFIG_REPO | GitHub repo holding crewconfig/ | none = repo editor off | Store: Admin → AI & SEO → Configuration → Repository; a saved entry wins wholesale (repo.ts:71) | src/lib/crewai/bundle/repo.ts:72 | yaml:122 `mrjithendar/jithendar.com` | restart (admin: live) |
| CREWAI_CONFIG_BRANCH | Branch | `master` | Store (as above) | src/lib/crewai/bundle/repo.ts:72 | yaml:124 `master` | restart (admin: live) |
| CREWAI_CONFIG_PATH | Folder | `crewconfig` | Store | src/lib/crewai/bundle/repo.ts:72 | yaml:126 `crewconfig` | restart (admin: live) |
| CREWAI_CONFIG_MODE | `commit` or pull request | `pull_request` | Store | src/lib/crewai/bundle/repo.ts:72 | not set | restart (admin: live) |
| CREWAI_CONFIG_GITHUB_TOKEN | Fine-grained token for that repo | none | Store: admin-saved token wins, else env (repo.ts:70-71) | src/lib/crewai/bundle/repo.ts:70 | yaml:128 secretKeyRef `jithendar-com-crewconfig/token` (optional) | restart (admin: live) |

## SEO agent link (10)

| Name | What | Default | Admin override | Read by | Set in jithendar.com | Live/restart |
|---|---|---|---|---|---|---|
| SEO_AGENT_URL | Where the seo-agent is | unset = admin endpoint, then discovery `http://seo-agent:8080` | **Env wins** over the admin endpoint (endpoint.ts:13-14, 163; UI: SeoAgentCard.tsx:97) | src/lib/seo-agent/endpoint.ts:83 | yaml:91 `http://127.0.0.1:8080` (own pod's container, D-105) | restart |
| SEO_AGENT_TOKEN | Web → agent bearer token; unset = agent disabled | none | None | src/lib/seo-agent/config.ts:22 | Secret env (create-seo-agent-secrets.sh:31-33; same value in seo-agent-env) | restart |
| SEO_AGENT_CALLBACK_TOKEN | Agent → web callback token (≥ 32 chars or the listener stays off) | none = no callback listener | None | src/lib/seo-agent/config.ts:24; internal-server.ts:147-149 | Secret env (create-seo-agent-secrets.sh:31-33) | startup |
| SEO_AGENT_CALLBACK_PORT | Port of the callback listener (0/invalid = off) | 9465 | None | src/lib/seo-agent/config.ts:32 | yaml:93 `9465` (equals default; must match seo-agent-config SEO_AGENT_CALLBACK_URL) | startup |
| SEO_ORCHESTRATOR | Override: `legacy` forces agent off, `crewai` (or v3 alias `langgraph`) forces on without probing | auto (probe) | **Env wins** over discovery and the admin endpoint | src/lib/seo-agent/config.ts:17 | yaml:86 comment says "set in jithendar-com-env/-public"; no script writes it: unverified | restart |
| POD_NAMESPACE | Namespace for the second discovery URL | SA namespace file (not mounted: automountServiceAccountToken false) | None | src/lib/seo-agent/endpoint.ts:93 | not set (irrelevant while SEO_AGENT_URL is set) | restart |
| ASK_BLOG_ENABLED | Deployment master switch for Ask the Blog (widget, /api/ask) | off | Both must be on: env AND the admin's Ask-the-Blog switch AND agent on (ask-settings.ts:15-19, 145-148) | src/lib/seo-agent/config.ts:40 | yaml:81 `"true"` (also seo-agent-config:35) | restart (admin switch: live) |
| PUBLIC_MCP_ENABLED | Web-side mirror of the agent's public MCP switch (/ai-assistants page) | off | None in the web (the agent has it as an admin setting: seo-agent/app/admin_settings/groups/mcp.py:25) | src/lib/seo-agent/config.ts:92; endpoint.ts:274 | **not set for web** (only seo-agent-config:80 `"false"`) | restart |
| ADMIN_MCP_ENABLED | Web-side mirror of the agent's admin MCP switch (OAuth authorize/token endpoints) | off | None in the web (agent admin setting mcp.py:28) | src/lib/seo-agent/config.ts:94; mcp-oauth/http.ts:35 | **not set for web** (only seo-agent-config:81) | restart |
| SEO_AGENT_DOCS_ALLOWLIST | Documentation hosts the docs fetcher (run in the web, for agent callbacks) may read | 45 built-in hosts (config.ts:43-89) | None in the web (the agent has it as an admin setting: agent_limits.py:110) | src/lib/seo-agent/config.ts:103 (used by seo-agent/callbacks.ts:340, news/callbacks.ts:76) | not set | restart |

## News desk (2)

| Name | What | Default | Admin override | Read by | Set in jithendar.com | Live/restart |
|---|---|---|---|---|---|---|
| NEWS_DESK_ENABLED | `false` = forced off (emergency); `true` = legacy "on" until the admin switch is saved | unset = admin switch decides (off until switched on) | `false` **env wins**; otherwise the admin switch wins once saved (news/schema.ts:198-213) | src/lib/news/schema.ts:206 | not set (seo-agent-config:87 says so too) | restart (admin: live) |
| NEWS_IMAGE_PROVIDER | Web only DISPLAYS "deployment overrides this" next to the image-provider setting; the override itself happens in the agent | unset = no hint | Env wins in the agent (seo-agent/app/news/config.py:255-257) | src/app/admin/(growth)/automation/sections/seo-ai.tsx:11; api/admin/news/settings/route.ts:12 | **not set for web** (seo-agent-config:91 `template`) | restart |

## Practice (4)

| Name | What | Default | Admin override | Read by | Set in jithendar.com | Live/restart |
|---|---|---|---|---|---|---|
| PRACTICE_EXECUTOR_URL | Code execution service; also the only host that gets trace context | none = Run/Submit unavailable | None (admin only switches execution on, practice/settings.ts:14) | src/lib/practice/settings.ts:83; tracing-config.ts:66 | not set by any manifest/script (NetworkPolicy comment yaml:490 names `http://practice-executor.jithendar`): unverified | restart |
| PRACTICE_EXECUTOR_TOKEN | Executor bearer token | none | None | src/lib/practice/settings.ts:84 | not set by any manifest/script: unverified | restart |
| PRACTICE_USER_HASH_KEY | Key for pseudonymous user ids sent to the executor | SETTINGS_ENCRYPTION_KEY, then a dev constant | None | src/lib/practice/executor-client.ts:43 | not set (falls back to SETTINGS_ENCRYPTION_KEY) | restart |
| PRACTICE_CATALOG_PATH | Problem catalog seeded at start | `<cwd>/content/python-practice/catalog.generated.json` | None | src/lib/practice/seed.ts:56 | yaml:63 `/app/practice/python/catalog.generated.json` (init container) | startup |

## Integrations (analytics, Cloudflare, Google, social) (11)

| Name | What | Default | Admin override | Read by | Set in jithendar.com | Live/restart |
|---|---|---|---|---|---|---|
| GA4_MEASUREMENT_ID | GA4 tag (production, public pages only) | none | RS (Admin → Integrations → Analytics, ads and consent) | src/config/integrations.ts:56 | CM public (set-public-config.sh:20) | restart (admin: live) |
| ADSENSE_CLIENT_ID | AdSense publisher id; `off` disables | site.json `adsenseClientId` | RS (has an explicit `off`) | src/config/integrations.ts:48 | CM public (set-public-config.sh:21) | restart (admin: live) |
| ADSENSE_SLOT_ARTICLE_END | Ad slot at end of article | none | RS | src/config/integrations.ts:59 | CM public (set-public-config.sh:22) | restart (admin: live) |
| ADSENSE_SLOT_LISTING | Ad slot on listings | none | RS | src/config/integrations.ts:59 | not set (set-public-config.sh does not ask for it) | restart (admin: live) |
| ADSENSE_TEST_MODE | `true` shows Google test ads outside production | off | RS boolean | src/config/integrations.ts:58 | not set | restart (admin: live) |
| ADS_TXT | Exact ads.txt line(s), `\n` separated; unset = /ads.txt 404 | none | RS (textarea) | src/config/integrations.ts:78 | CM public (set-public-config.sh:23) | restart (admin: live) |
| CONSENT_DEFAULT | Consent Mode default `regional` / `strict` | `regional` | RS (select) | src/config/integrations.ts:61 | CM public (set-public-config.sh:24) | restart (admin: live) |
| READER_REVENUE_PRODUCT_ID | Google Reader Revenue Manager product; `off` disables | site.json `readerRevenue.productId` | RS (has `off`) | src/config/integrations.ts:69 | not set (site.json carries it) | restart (admin: live) |
| CLOUDFLARE_ZONE_ID | Zone for cache purges | none = never purged | RS (Admin → Cache) | src/lib/cloudflare.ts:36 | not set | restart (admin: live) |
| CLOUDFLARE_API_TOKEN | Cache Purge token | none | RS (sealed) | src/lib/cloudflare.ts:37 | not set | restart (admin: live) |
| CLOUDFLARE_PURGE_ON_PUBLISH | `related` / `everything` / `off` | `related` | RS (select) | src/lib/cdn-purge.ts:26 | not set | restart (admin: live) |

## Observability (8)

| Name | What | Default | Admin override | Read by | Set in jithendar.com | Live/restart |
|---|---|---|---|---|---|---|
| LOG_LEVEL | Log threshold: `debug`/`info`/`warn`/`error` (lowercase only; anything else = info) | `info` | None | src/lib/log.ts:13 (module load) | yaml:83 `info` | startup |
| LOG_FORMAT | `text` keeps the plain console instead of JSON lines | JSON in production | None | src/lib/log.ts:93 | not set | startup |
| ACCESS_LOG | `false` turns off the proxy's access log | on | None | src/proxy.ts:63 | not set | restart |
| REQUEST_LOG | `false` turns off request-log lines | on | None | src/lib/request-log.ts:63 | not set | restart |
| OTEL_EXPORTER_OTLP_ENDPOINT | OTLP/HTTP collector; unset = spans recorded, not exported (also read implicitly by @vercel/otel, as may other standard OTEL_* names: unverified) | none | None | src/instrumentation.ts:26; health.ts:154 | yaml:74 `http://otel-collector.observability:4318` | startup |
| OTEL_SERVICE_NAME | Trace service name | `jithendar-com` (site-specific default in a generic CMS) | None | src/instrumentation.ts:19 | yaml:76 `jithendar-com` | startup |
| METRICS_PORT | Prometheus listener port; 0 = off | 9464 | None | src/lib/metrics.ts:383 | not set (container port 9464, yaml:186-188) | startup |
| GIT_SHA | Build version in /api/health, logs, metrics, backups, crewconfig exports | `dev` | None | src/app/api/health/route.ts:7; log.ts:72; metrics.ts:360 | image (Dockerfile:109, 117, build arg) | build |

## CI/build only (6)

| Name | What | Default | Admin override | Read by | Set in jithendar.com | Live/restart |
|---|---|---|---|---|---|---|
| NEXT_PHASE | Detects `next build` (skip DB/agent probes) | set by Next | None | src/lib/content/index.ts:34; site-images.ts:244; site-config/store.ts:71; seo-agent/endpoint.ts:153 | (Next internal) | build |
| VITEST | No purge timers under tests | set by Vitest | None | src/lib/cdn-purge.ts:82 | — | test |
| E2E_WORKER | `1` runs the job worker on PGlite for local E2E (ignored in production) | off | None | src/instrumentation.ts:42 | not set | startup |
| SEO_VERIFY_FETCH_ORIGIN | Local E2E: verify published pages via this loopback origin (ignored in production) | none | None | src/lib/seo-intel/publish.ts:250 | not set | restart |
| SITE | Which `sites/<domain>` folder use-site.mjs copies before dev/build/test | none = tests/fixtures/site | None | scripts/use-site.mjs:73 | not used (the site repo mounts its own files) | build |
| SITE_DIR | Any site folder for use-site.mjs (wins over SITE) | none | None | scripts/use-site.mjs:74 | not used | build |

## Named in jithendar.com or .env.example but not read by the web app

| Name | Where it is set or named | Status |
|---|---|---|
| METRICS_TOKEN | Secret env (create-secrets.sh:35); moks-cms docs/DEPLOYMENT.md:38 | Never read (docs/PROGRESS.md:1426: "in the Secret and DEPLOYMENT.md but unused") |
| SEO_LLM_MONTHLY_BUDGET_USD | seo-agent-config `"15"` (seo-agent-40-seo-agent.yaml:30, comment :29 "keep equal to the site's…") | Not read by the web (.env.example:204 "no longer read"), and seo-agent/app/llm.py:6 says "There is no SEO_LLM_MONTHLY_BUDGET_USD any more" |
| DATABASE_URL (copy in jithendar-com-env) | Secret env (yaml:153-154 comment: "stale DATABASE_URL still in jithendar-com-env") | Read name, but this copy is always shadowed by yaml:155 |

## Where jithendar.com puts each key (names only)

- **`web` container literal env** (kubernetes/30-jithendar-com.yaml:62-159): PRACTICE_CATALOG_PATH, APP_ENV, SITE_URL,
  TRUSTED_EDGE, OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_SERVICE_NAME, ASK_BLOG_ENABLED, LOG_LEVEL, SEO_AGENT_URL,
  SEO_AGENT_CALLBACK_PORT, GEMINI_IMAGE_SIZE, GEMINI_IMAGE_TIMEOUT_MS, GEMINI_IMAGE_USER_HOURLY_LIMIT,
  GEMINI_IMAGE_USER_CONCURRENCY, GEMINI_IMAGE_DAILY_LIMIT, CREWAI_CONFIG_REPO, CREWAI_CONFIG_BRANCH, CREWAI_CONFIG_PATH,
  RAG_API_URL, RAG_COLLECTION, RAG_SERVICE_NAME.
- **secretKeyRef entries**: CACHE_BUS_REDIS_URL (redis-site-cachebus-credentials/uri, optional), CREWAI_CONFIG_GITHUB_TOKEN
  (jithendar-com-crewconfig/token, optional), RAG_BEARER_TOKEN (jithendar-com-rag/token, optional), DATABASE_URL
  (postgres-db-credentials/uri).
- **Secret `jithendar-com-env`** (envFrom, required): create-secrets.sh → BETTER_AUTH_SECRET, SETTINGS_ENCRYPTION_KEY,
  ADMIN_BOOTSTRAP_TOKEN, METRICS_TOKEN, TURNSTILE_SITE_KEY, TURNSTILE_SECRET_KEY, [SMTP_URL, MAIL_FROM];
  set-media-config.sh → R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_PUBLIC_BASE_URL,
  GEMINI_API_KEY, GEMINI_IMAGE_MODEL; set-oauth-config.sh → GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GITHUB_CLIENT_ID,
  GITHUB_CLIENT_SECRET; set-seo-config.sh → GOOGLE_SEO_SERVICE_ACCOUNT_JSON, [PAGESPEED_API_KEY];
  set-dataforseo-config.sh → DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD; set-reddit-config.sh → REDDIT_CLIENT_ID,
  REDDIT_CLIENT_SECRET, [REDDIT_USER_AGENT]; set-ai-visibility-config.sh → [OPENAI_API_KEY], [PERPLEXITY_API_KEY],
  [GEMINI_API_KEY]; create-seo-agent-secrets.sh → SEO_AGENT_TOKEN, SEO_AGENT_CALLBACK_TOKEN. By hand (no script,
  unverified): ANTHROPIC_API_KEY (read from there by create-seo-agent-secrets.sh:21), the stale DATABASE_URL, possibly
  SEO_ORCHESTRATOR and PRACTICE_EXECUTOR_*.
- **ConfigMap `jithendar-com-public`** (envFrom, optional): set-public-config.sh → GOOGLE_SITE_VERIFICATION,
  BING_SITE_VERIFICATION, GA4_MEASUREMENT_ID, ADSENSE_CLIENT_ID, ADSENSE_SLOT_ARTICLE_END, ADS_TXT, CONSENT_DEFAULT,
  [INDEXNOW_KEY]; set-seo-config.sh → SEO_GSC_PROPERTY, SEO_GA4_PROPERTY_ID.
- **Image ENV** (moks-cms Dockerfile:117): NODE_ENV, APP_ENV, HOSTNAME, GIT_SHA (+ agent-only names).
- The `web` container does NOT get `seo-agent-config` / `seo-agent-env` (those are envFrom of the `seo-agent` container
  only, yaml:268-272).

---

## Flags

### 1. Read by the code but not in `.env.example` (62 not mentioned at all, 4 more only inside a comment)

Not mentioned at all (62): ACCESS_LOG, ADMIN_BOOTSTRAP_TOKEN, ADMIN_MCP_ENABLED, ADSENSE_SLOT_LISTING, ASK_BLOG_ENABLED,
CAL_WEBHOOK_SECRET, CONTENT_PREVIEW, CONTENT_SEED_DIR, CREWAI_CONFIG_BRANCH, CREWAI_CONFIG_GITHUB_TOKEN,
CREWAI_CONFIG_MODE, CREWAI_CONFIG_PATH, CREWAI_CONFIG_REPO, DATABASE_POOL_MAX, E2E_WORKER, GEMINI_API_ENDPOINT,
GEMINI_IMAGE_MAX_SIZE, GEMINI_IMAGE_PRO_MODEL, GEMINI_VIDEO_ENDPOINT, GIT_SHA, HOSTNAME, INDEXNOW_ENDPOINT, LOG_FORMAT,
LOG_LEVEL, METRICS_PORT, MIGRATIONS_DIR, NEWS_DESK_ENABLED, NEWS_IMAGE_PROVIDER, NEXT_PHASE, NEXT_RUNTIME, NODE_ENV,
OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_SERVICE_NAME, PAGE_CACHE_MAX_MB, PAGE_WARMUP, POD_NAMESPACE, PORT,
PRACTICE_CATALOG_PATH, PUBLIC_DIR, PUBLIC_MCP_ENABLED, READER_REVENUE_PRODUCT_ID, REQUEST_LOG, S3_ACCESS_KEY_ID,
S3_BUCKET, S3_ENDPOINT, S3_PUBLIC_BASE_URL, S3_REGION, S3_SECRET_ACCESS_KEY, SEO_AGENT_CALLBACK_PORT,
SEO_AGENT_CALLBACK_TOKEN, SEO_AGENT_DOCS_ALLOWLIST, SEO_AGENT_TOKEN, SEO_AGENT_URL, SEO_ORCHESTRATOR,
SEO_SUBMIT_DEBOUNCE_MS, SEO_VERIFY_FETCH_ORIGIN, SITE_CONFIG_DIR, SITE_DIR, TURNSTILE_SECRET_KEY, TURNSTILE_SITE_KEY,
VERCEL_ENV, VITEST (NEXT_PHASE/NEXT_RUNTIME/NODE_ENV/VITEST are framework-set and fine to leave out).
Only in a comment, no example line: DATABASE_URL (.env.example:94), BETTER_AUTH_SECRET (:133), REDIS_URL (:35),
SETTINGS_ENCRYPTION_KEY (:164). The header (:1-6) promises "the bootstrap token and start-up options (logging, OTel,
metrics) must be set here", yet none of ADMIN_BOOTSTRAP_TOKEN, LOG_LEVEL, OTEL_*, METRICS_PORT has a line. The whole
SEO-agent link (SEO_AGENT_URL / _TOKEN / _CALLBACK_*), Turnstile, Cal.com and crewconfig blocks are missing.

### 2. In `.env.example` but never read by the web app

- AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY (.env.example:156-157): no direct read; only the AWS SDK default chain uses
  them (implicit). OK, but say so.
- SITE (.env.example:26-27): read only by scripts/use-site.mjs:73 (build/dev), and the comment "default jithendar.com" is
  wrong: with neither SITE nor SITE_DIR the script uses tests/fixtures/site (use-site.mjs:16-17).

### 3. Set by jithendar.com but never read by the code

- METRICS_TOKEN: create-secrets.sh:35 generates it into jithendar-com-env; no code reads it (moks-cms
  docs/PROGRESS.md:1426, and moks-cms docs/DEPLOYMENT.md:38 still lists it). /metrics relies on the NetworkPolicy only.
- The stale DATABASE_URL copy inside jithendar-com-env (30-jithendar-com.yaml:153-154) is never effective (yaml:155
  wins). Admin → Database tells admins the opposite: "The connection string comes from the DATABASE_URL key of Secret
  jithendar-com-env. Change it there and redeploy" (src/app/admin/database/page.tsx:61) — changing it there does nothing.
- SEO_LLM_MONTHLY_BUDGET_USD `"15"` and its comment "keep equal to the site's SEO_LLM_MONTHLY_BUDGET_USD"
  (seo-agent-40-seo-agent.yaml:29-30): neither the site (.env.example:204) nor the agent (seo-agent/app/llm.py:6) reads
  it. A preset budget left in Git, against the "no preset values" rule.

### 4. The same knob under two names / in two places

- RAG collection: web `RAG_COLLECTION` (rag/sync.ts:44; yaml:141) vs agent `RAG_CMS_COLLECTION`
  (seo-agent-40-seo-agent.yaml:74). Same value `cms_content`, two names, and the web one is also an admin setting.
- Callback address: web `SEO_AGENT_CALLBACK_PORT=9465` (yaml:93; config.ts:32) vs agent `SEO_AGENT_CALLBACK_URL=
  http://127.0.0.1:9465` (seo-agent-40:26) — must be changed together. Likewise SEO_AGENT_URL `:8080` (yaml:91) vs the
  agent's PORT default.
- Tokens duplicated across Secrets: SEO_AGENT_TOKEN and SEO_AGENT_CALLBACK_TOKEN in jithendar-com-env and seo-agent-env
  (create-seo-agent-secrets.sh:28, 31-33); ANTHROPIC_API_KEY copied from jithendar-com-env into seo-agent-env
  (create-seo-agent-secrets.sh:20-28) — a rotation in one place leaves the other stale.
- Storage under two families: R2_* and S3_* (storage.ts:113-153); R2_* wins when both are present.
- Cache bus: CACHE_BUS_REDIS_URL with REDIS_URL fallback (cache-bus.ts:58-62); REDIS_URL also changes sessions/rate
  limits, so the fallback silently does more than the bus.
- Production flag: APP_ENV or VERCEL_ENV (site.ts:39); NODE_ENV also consulted for PGlite (db/index.ts:27).
- PRACTICE_USER_HASH_KEY falls back to SETTINGS_ENCRYPTION_KEY (executor-client.ts:43): rotating the encryption key
  silently changes every practice user's pseudonymous id.
- One GEMINI_API_KEY, four consumers, three precedence rules: images/video take the Admin → Integrations Gemini entry
  (integrations.ts:148-153); SEO LLM and practice tutor take their own sealed keys (seo-intel/settings.ts:438-440,
  practice/settings.ts:95-96); AI visibility uses env only (ai-visibility.ts:101). OPENAI_API_KEY the same minus images.
  Two scripts write GEMINI_API_KEY into the same Secret (set-media-config.sh:32, set-ai-visibility-config.sh:20).
- Web/agent pairs where only the agent side is set (the web reads its own env, which never gets seo-agent-config):
  PUBLIC_MCP_ENABLED / ADMIN_MCP_ENABLED (web config.ts:92-94 vs seo-agent-40:80-81), NEWS_IMAGE_PROVIDER (web
  seo-ai.tsx:11 vs seo-agent-40:91), SEO_DRAFT_MODEL / SEO_CLASSIFY_MODEL (web settings.ts:461-462 vs seo-agent-40:27-28;
  web falls back to identical defaults today), SEO_AGENT_DOCS_ALLOWLIST (web config.ts:103; agent admin setting
  agent_limits.py:110).
- Set on both sides, must agree: ASK_BLOG_ENABLED (yaml:81 and seo-agent-40:35; both must be true, ask-settings.ts:15),
  SITE_URL (yaml:67, seo-agent-40:78), APP_ENV (yaml:65, seo-agent-40:24), OTEL_EXPORTER_OTLP_ENDPOINT (yaml:74,
  seo-agent-40:93). LOG_LEVEL `info` (web, lowercase required by log.ts:13) vs `INFO` (agent, seo-agent-40:95).
- AdSense client and Reader Revenue product are also in site.json (config/integrations.ts:37, 69): env, admin and
  site.json — three sources.

### 5. Deprecated / legacy names still read

- SEO_ORCHESTRATOR (config.ts:13-19): `legacy` (v2 path) and the v3 alias `langgraph` ("the LangGraph runtime no longer
  exists") still honoured; `crewai` force-on skips the probe. The manifest comment around it is stale: "The callback
  listener starts only when SEO_ORCHESTRATOR=crewai … off by default: legacy v2 path" (30-jithendar-com.yaml:86-87),
  while the code starts it whenever SEO_AGENT_CALLBACK_TOKEN is set unless `legacy` (config.ts:27-33,
  internal-server.ts:143-150). Whether it is set live: unverified.
- VERCEL_ENV (site.ts:39): Vercel leftover.
- REDIS_URL: removed from the deployment on 2026-11-09 (yaml:105) but still read for sessions, rate limits, API keys
  (redis.ts:14), the bus fallback (cache-bus.ts:61) and health (health.ts:43).
- NEWS_DESK_ENABLED=`true` "deployment_legacy" mode (news/schema.ts:202, 210).
- v2 naming on live knobs: SEO_DRAFT_MODEL / SEO_CLASSIFY_MODEL ("SEO platform v2", .env.example:196),
  SEO_SUBMISSION_ENABLED ("v2 Phase 3", settings.ts:170).
- GEMINI_IMAGE_MODEL / _PRO_MODEL / _SIZE / _MAX_SIZE and GOOGLE_/GITHUB_CLIENT_*: env is only a pre-admin fallback
  once INT entries exist (integrations.ts:18-19).
- CONTENT_DIR file mode (content/index.ts:22-27): tests / pre-setup only.

### 6. Precedence that is inconsistent or surprising

- Admin booleans can only force ON: saving an unticked box deletes the value and the env applies again
  (runtime-settings.ts:253, 313-318). CF_STREAM_ENABLED / MUX_ENABLED / BUNNY_STREAM_ENABLED / ADSENSE_TEST_MODE /
  VIDEO_DEST_R2_DISABLED = `true` in the env cannot be switched off from the admin. The same holds for every text field
  without an `off` value (e.g. GA4_MEASUREMENT_ID, ADS_TXT, GOOGLE_SITE_VERIFICATION set in jithendar-com-public cannot be
  cleared from the admin).
- Env wins (opposite of the RS rule) for: R2_*/S3_* (storage.ts:161-163), INDEXNOW_KEY (indexnow-key.ts:17-18;
  integrations.ts:265-266), SEO_AGENT_URL over the admin endpoint (endpoint.ts:13, 163), SEO_ORCHESTRATOR,
  NEWS_DESK_ENABLED=false, and in the agent NEWS_IMAGE_PROVIDER. jithendar.com sets R2_* and SEO_AGENT_URL, and may
  set INDEXNOW_KEY, so those admin pages are inert there.
- INT documents win entirely once saved, including "disabled" (integrations.ts:18-19): a saved-but-disabled Gemini
  entry turns image generation off even with GEMINI_* in the env.
- Admin → System status → Payments reads `razorpayKeys(process.env)` (health.ts:316), not effectiveEnv(): keys saved
  only in Admin → Payments show as "not configured".
- NEWS_IMAGE_PROVIDER: the agent's `template` (seo-agent-40:91) overrides the admin's image provider
  (seo-agent/app/news/config.py:255-257), but the web shows the "deployment overrides this" hint only when the WEB
  container has the variable (seo-ai.tsx:11-15), which it never does: the admin edits a setting that silently has no
  effect.
- PUBLIC_MCP_ENABLED / ADMIN_MCP_ENABLED: the agent makes them live admin settings (mcp.py:25, 28), but the web's gates
  (`mcpEnabled`, endpoint.ts:272-276 → /ai-assistants page, /mcp-oauth/authorize, mcp-oauth/http.ts:35) read the web's
  env, where they are unset: turning MCP on in the agent never opens the web side.

### 7. Env-only values that look like they belong in the admin

- ANTHROPIC_API_KEY, PERPLEXITY_API_KEY, PAGESPEED_API_KEY, DATAFORSEO_*, REDDIT_*, GOOGLE_SEO_SERVICE_ACCOUNT_JSON: env
  only "by design", while Gemini/OpenAI keys, Turnstile, Razorpay, Cloudflare, Mux, Bunny and RAG tokens can be saved
  sealed in the admin. Inconsistent policy for third-party keys.
- REDDIT_USER_AGENT, SEO_LLM_PRICES_JSON, AUDIT_LOG_RETENTION_DAYS, SEO_SUBMISSION_ENABLED, CLOUDFLARE_PURGE_ON_PUBLISH
  (already RS), MOKS_TENANT_ID: ordinary policy values with no secret in them.
- SEO_AGENT_DOCS_ALLOWLIST and PUBLIC/ADMIN_MCP_ENABLED: already admin settings in the agent but env-only in the web
  (see 6).
- Deliberately env-only and fine to keep so (start-up or lock-out risk, runtime-settings.ts:19-21): DATABASE_*,
  REDIS_URL, CACHE_BUS_REDIS_URL, BETTER_AUTH_SECRET, SETTINGS_ENCRYPTION_KEY, SITE_URL, ADMIN_BOOTSTRAP_TOKEN, APP_ENV,
  TRUSTED_EDGE, CLOUDFLARE_IP_RANGES, LOG_*, OTEL_*, METRICS_PORT, PAGE_CACHE_MAX_MB, the kill switches ASK_BLOG_ENABLED
  and NEWS_DESK_ENABLED, PRACTICE_EXECUTOR_*.

### 8. Units, zero and boolean parsing

- Time units mixed in the web: GEMINI_IMAGE_TIMEOUT_MS, GEMINI_VIDEO_TIMEOUT_MS, SEO_SUBMIT_DEBOUNCE_MS (ms) vs
  DATABASE_CONNECT_TIMEOUT_SECONDS, GEMINI_VIDEO_SECONDS (s) vs AUDIT_LOG_RETENTION_DAYS (days); and across web/agent the
  agent uses seconds (CREW_TIMEOUT_SECONDS, SEO_LLM_TIMEOUT_SECONDS, SEO_FLOW_TIMEOUT_SECONDS, seo-agent-40). Size units
  mixed: AVATAR_MAX_BYTES (bytes) vs PAGE_CACHE_MAX_MB (MB).
- Zero means "default", not zero: image/video limits use `Number(v) || default` (image-generation.ts:33,
  video-generation.ts:57), so 0 for GEMINI_IMAGE_USER_HOURLY_LIMIT, GEMINI_IMAGE_DAILY_LIMIT,
  GEMINI_VIDEO_USER_HOURLY_LIMIT, GEMINI_VIDEO_DAILY_LIMIT becomes 10/50/3/10, although the admin fields accept min 0
  (runtime-settings.ts:141-142, 157-158). There is also no way to say "no limit".
- Port semantics: METRICS_PORT 0 = off (metrics.ts:384); SEO_AGENT_CALLBACK_PORT 0 or invalid = off (config.ts:33).
- Booleans parsed four ways: `=== "true"` exact (ADSENSE_TEST_MODE, CONTENT_PREVIEW, video `on()` after trim),
  case-insensitive `true` (ASK_BLOG_ENABLED, *_MCP_ENABLED, SEO_SUBMISSION_ENABLED), `!== "false"` (ACCESS_LOG,
  REQUEST_LOG, PAGE_WARMUP), and 1/true/yes/on (NEWS_DESK_ENABLED, schema.ts:195-196); E2E_WORKER wants `1`. One
  negative name: VIDEO_DEST_R2_DISABLED.
- LOG_LEVEL accepts lowercase only; `INFO`/`DEBUG` silently fall back to info (log.ts:13).

### 9. Presets in the jithendar.com manifest that just repeat code defaults

GEMINI_IMAGE_SIZE `1K`, GEMINI_IMAGE_TIMEOUT_MS `90000`, GEMINI_IMAGE_USER_HOURLY_LIMIT `10`,
GEMINI_IMAGE_USER_CONCURRENCY `1`, GEMINI_IMAGE_DAILY_LIMIT `50` (yaml:95-104), RAG_API_URL / RAG_COLLECTION /
RAG_SERVICE_NAME (yaml:139-144), SEO_AGENT_CALLBACK_PORT `9465` (yaml:93), CREWAI_CONFIG_BRANCH/PATH (yaml:124-127). They
are harmless while equal, but they are limits picked in Git (the image limits are also admin settings, where the admin
value wins). The agent ConfigMap presets budgets too (SEO_LLM_MONTHLY_BUDGET_USD "15", ASK_BLOG_DAILY_BUDGET_USD "1",
seo-agent-40:30-31).

### 10. Smaller things

- SITE_URL default differs by file: site.json host (site.ts:28) vs hard-coded `https://jithendar.com` (posts.ts:193,
  seo-intel/urls.ts:20) — wrong for any other site (e.g. sites/moksit.com) that leaves SITE_URL unset.
- HOSTNAME is both Next's bind address (image `0.0.0.0`, Dockerfile:117) and the "pod" label in cache-bus connection
  names and Admin → Cache (cache-bus.ts:73, cache-admin.ts:104). If the image ENV wins in the pod (unverified; depends on
  the container runtime), every pod reports `0.0.0.0`. Message de-duplication uses a random UUID (cache-bus.ts:94), so
  only labels are affected.
- POD_NAMESPACE / service-account file: the Deployment has `automountServiceAccountToken: false` (yaml:36), so discovery
  never learns the namespace; harmless while SEO_AGENT_URL is set.
- ADSENSE_SLOT_LISTING and READER_REVENUE_PRODUCT_ID are not offered by set-public-config.sh (only admin/site.json).
- set-public-config.sh rebuilds the ConfigMap with `create --dry-run | apply` (:28) and says "Leave a prompt empty to
  leave that setting unset" (:7): re-running it and skipping a prompt removes a key it set before (kubectl apply
  three-way merge; keys added by set-seo-config.sh's patch survive). set-media-config.sh / set-oauth-config.sh instead
  say "Leave a prompt empty to keep the current value". Inconsistent operator semantics (apply behaviour: unverified on
  the live object).
- ANTHROPIC_API_KEY, SEO_ORCHESTRATOR, PRACTICE_EXECUTOR_URL / _TOKEN: expected in jithendar-com-env by docs or comments,
  but no jithendar.com script writes them; their presence is unverified.
