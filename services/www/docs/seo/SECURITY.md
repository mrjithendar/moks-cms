# SEO intelligence platform: security

## Access control
- Search, analytics, review, calendar and automation pages (`app/admin/(growth)/*`, e.g. `/admin/review`, `/admin/automation`; D-86): `requireRole("admin")` in the group layout (authors and readers are redirected). Old `/admin/seo/*` URLs only redirect.
- `/api/admin/seo/*`: one guard (`src/lib/seo-intel/http.ts#seoRoute`): 401 without a session, 403 for any role but
  admin, on every request. `tests/seo-intel-api.test.ts` discovers **every** route file and asserts 401/403 for each
  method, so a new route without the guard fails CI.
- CSRF: mutations require a same-origin `Origin` header (plus SameSite session cookies) and a JSON body.
- Rate limits per admin and route (Postgres-backed, shared by replicas); stricter on sync, backfill, scans and tests.
- `/api/` is disallowed in robots.txt and responses are `noindex`, `no-store`. Admin pages are `noindex`.

## Secrets
- The Google service-account key exists only in the Kubernetes Secret (`GOOGLE_SEO_SERVICE_ACCOUNT_JSON`). It is never
  written to the database, logs, API responses, audit entries or LLM prompts. The UI shows only the account email.
- Access tokens live in process memory only. Google error messages are trimmed and token-like strings redacted before
  they are stored on a run or integration.
- The optional LLM key is sealed with `SETTINGS_ENCRYPTION_KEY` and is write-only in the API (`llmKeySet` flag).
- PageSpeed key: environment only; the request URL containing it is never logged.
- Property ids are visible to admins only (they are not secrets, but are not exposed publicly).

## Least privilege
- OAuth scopes: `webmasters.readonly`, `analytics.readonly`. GSC user permission **Restricted** is enough for Search
  Analytics; URL Inspection (optional, off) needs **Full**. GA4 role **Viewer**.

## Crawler (SSRF)
- Host allowlist (site host and `www.` variant), ports 80/443 only, http(s) only.
- The IP check runs inside the socket's own DNS lookup, so the validated address is the one connected to (no rebinding
  window). Refused: loopback, RFC 1918, CGNAT, link-local (incl. 169.254.169.254), multicast, reserved, documentation
  ranges, IPv6 ULA/link-local, IPv4-mapped forms of those.
- Redirects followed manually (max 5, configurable), each hop re-checked. Timeout and response-size cap. Private paths
  (`/admin`, `/api`, `/account`, `/login`, `/setup`, `/preview`) and robots-disallowed paths are never fetched.
- Rate ≤ 1 request/second by default; identifies itself as `JithendarSEOAudit/1.0`.

## LLM (optional, off by default)
- Untrusted text (article bodies, search queries, crawled content) goes inside `<data>` blocks; the system prompt says
  data is never instructions; closing tags inside data are neutralised.
- The model has no tools; outputs are zod-validated and only stored as proposals or explanations for human review.
- Minimum data: titles, headings, metadata and aggregated metrics; queries that look like emails/phone numbers/secrets
  are dropped; secrets and emails in text are redacted.
- Daily request cap; cache by input hash + prompt version.

## Content integrity
- No SEO code imports `publishPost`, `updatePost`, `publishDuePosts` or any delete/trash function, and none writes the
  `post` table (static test). The only post-creating call is `createPost` with a hard-coded `status: "draft"`.
- Accepting a proposal writes the admin's own autosave; publishing always uses the editor's buttons.

## Data
- CSV exports prefix cells starting with `= + - @` (formula injection).
- Report emails go only to configured recipients through the existing mail service, off by default.
- No personal data is collected; GA4 data is aggregated by Google; query text is stored as Google reports it.

## Review findings (this branch)
| Finding | Status |
|---|---|
| Markdown images were parsed as internal links (false "broken link" findings) | fixed, tested |
| Session advisory locks unreliable through a connection pool | replaced with leases (D-02) |
| `correlationId` would be dropped by the log collector | trace id stored on the run (D-19) |
| LLM base URL may point at plain-http localhost/in-cluster services (for Ollama) | allowed by design; admin-only setting; egress NetworkPolicy blocks private ranges in production |
| `npm audit` | see PROGRESS.md (no dependencies added) |
