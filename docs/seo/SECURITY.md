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

## Database role of the agent (optional, a person switches it on)

The seo-agent service connects to the site's database. By default it uses the site's own role (`DATABASE_URL` from
Secret `postgres-db-credentials`), which owns every table: sessions, password hashes, posts, settings. The agent
runs LLM-driven flows and serves MCP, so a prompt injection that reached SQL, or a leaked agent credential, would
have all of that.

`seo-agent/scripts/db-role.sql` creates a role `seo_agent` with only what the agent's SQL needs:

| It can | It cannot |
|---|---|
| read posts, SEO measurements, settings, its drafts' status | read sessions, accounts, verification tokens, API keys, OAuth clients and codes |
| read three columns of `user` (`id`, `role`, `banned`) to check an MCP token's owner | read email addresses or names |
| insert into `audit_log` | read, change or delete audit entries |
| update `last_used_at` of an MCP grant | create, widen or un-revoke a grant |
| write its own working tables (`news_*` runs and items, flow runs, LLM usage, ML outputs, ask log) | write posts, pages, users, settings, media or comments |
| create and own its search index (`seo_article_chunks`) | touch any other table's structure |

Nothing changes until all three steps are done. The Deployment reads `SEO_AGENT_DATABASE_URL` from an **optional**
Secret and falls back to `DATABASE_URL` while that Secret does not exist.

```bash
# 1. Role and privileges, as a superuser in the site's database (safe to run again at any time).
psql "$SUPERUSER_URL" -v ON_ERROR_STOP=1 -f seo-agent/scripts/db-role.sql
# 2. Let it log in. Use a generated password; it goes into the Secret only.
psql "$SUPERUSER_URL" -c "ALTER ROLE seo_agent LOGIN PASSWORD '<password>'"
# 3. The same host, port and database as the site's URI, with the new user and password.
kubectl -n jithendar get secret postgres-db-credentials -o jsonpath='{.data.uri}' | base64 -d   # to copy host/db from
kubectl -n jithendar create secret generic seo-agent-db-credentials \
  --from-literal=uri='postgresql://seo_agent:<password>@<host>:<port>/<database>'
kubectl -n jithendar rollout restart deploy/jithendar-com
```

Check: `kubectl -n jithendar logs deploy/jithendar-com -c seo-agent | grep -i "permission denied"` stays empty, Admin → Automation
shows the next scheduled flows succeeding, and an MCP call still works. PgBouncer authenticates the new role like
any other; if the login is refused there, the pooler's user list in the miniKube repository needs the role.

Roll back: `kubectl -n jithendar delete secret seo-agent-db-credentials` and restart the Deployment. The agent is
back on the site's role; the tables it created in the meantime stay readable and writable by the site's role.

Keep it current: `tests/test_db_role.py` fails when the agent's code needs a privilege the script does not grant
(and when the script grants one nothing uses). After merging such a change, run step 1 again **before** the new
agent image is rolled out.

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
