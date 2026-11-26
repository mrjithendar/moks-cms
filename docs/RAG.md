# Hybrid RAG sync (moks-rag)

Published posts are kept in the shared Hybrid RAG service, **moks-rag** (repository `mrjithendar/moks-rag`, namespace
`rag`): rag-api chunks each post, embeds it with bge-m3 (dense) and BM25 (sparse) and stores it in Qdrant, collection
`cms_content`. Open WebUI's `moks-cms` model and any caller of `POST /query` can then search the site's content by
meaning. Decision: D-104 in `docs/seo/DECISIONS.md`. Code: `src/lib/rag/client.ts` (HTTP), `src/lib/rag/sync.ts`.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `RAG_API_URL` | `http://rag-api.rag.svc.cluster.local:8000` | rag-api inside the cluster. For local development: `kubectl -n rag port-forward svc/rag-api 8000:8000` and `http://127.0.0.1:8000`. |
| `RAG_BEARER_TOKEN` | (none: sync off) | rag-api's shared token. In Kubernetes from Secret `jithendar-com-rag`, key `token`. |
| `RAG_COLLECTION` | `cms_content` | One of rag-api's collections. |
| `RAG_SERVICE_NAME` | `moks-cms` | Sent as `X-Service-Name`; rag-api logs every call under it. |

All four are runtime settings too (Admin → Settings → Integrations → Hybrid RAG): a value saved there wins, an empty field uses
the deployment's. The token is sealed with `SETTINGS_ENCRYPTION_KEY` and never shown again. Every request carries
`Authorization: Bearer <token>` and `X-Service-Name`.

The Secret in namespace `jithendar` is a copy of the one in `rag` (a `secretKeyRef` cannot cross namespaces). A
person makes it:

```bash
kubectl -n jithendar create secret generic jithendar-com-rag \
  --from-literal=token="$(kubectl -n rag get secret rag-secrets -o jsonpath='{.data.RAG_BEARER_TOKEN}' | base64 -d)"
kubectl -n jithendar rollout restart deploy/jithendar-com
```

Rotating rag-api's token means updating this copy too (or saving the new one in the admin).

## What is synced, and when

The doc_id is `<collection>:<slug>` (e.g. `blog:istio-ambient-mesh`; no `/`, because rag-api's
`DELETE /documents/{doc_id}` takes one path segment).

| Change (lib/posts.ts, lib/taxonomy-admin.ts) | Job | rag-api call |
|---|---|---|
| Publish, update of a published post, scheduled post going live, restore from trash | `rag_sync` | `POST /ingest` (replaces every chunk of the doc_id) |
| Unpublish (draft, review, archived), trash, permanent delete, set to noindex | `rag_sync` | `DELETE /documents/{doc_id}?collection=cms_content` |
| Slug change | one job per address | delete the old doc_id, ingest the new one |
| Category rename, tag rename or delete | one job per published post it touched | `POST /ingest` |
| Draft saves | none | none |

A job does not carry the post: it reads the post when it runs and sends what readers can see at that address then.
An ingest sends `# Title`, the description and the body (HTML comments dropped, images reduced to their alt text) with
the metadata `slug`, `url`, `path`, `title`, `tags`, `status: "published"`, `updated_at` (ISO 8601 with offset,
`updatedAt` or else `publishedAt`), `published_at`, `collection`, `category`, `content_type`, `members_only`, `post_id`.

Like the SEO agent's article index, only what every reader can see is sent: a **members-only** post sends just its
free preview, and **noindex** posts are removed. Posts in `content/` files (a fresh install before `/setup`) are not
synced; after importing them, use Reindex.

## Failures never block saving

- Saving only inserts a job row in the site's own database (the Postgres job queue, `lib/jobs.ts`). rag-api is called
  by the background worker in every site pod (`lib/scheduler.ts`, every 30 s), never in a request.
- Each call has a 10-second timeout; a timeout, a network error or a 5xx is tried again after 0.5 s and 1 s. If that
  fails too, the job goes back to the queue with its backoff (1, 2, 4 … 60 minutes, 8 attempts: about two hours), and
  other sync jobs on that pod wait a minute instead of each waiting 30 seconds, so IndexNow and report jobs keep moving.
- A refusal (401 wrong token, 422 bad payload) fails the job at once: retrying will not help.
- One pending job per address: a second save while one is waiting adds nothing; a save while one is running queues
  one more run after it. A job that finds the post changed while it was sending it sends it once more.
- Admin → Settings → Integrations → Hybrid RAG shows the last 7 days (synced, waiting, failed) and the last failure. Logs:
  `event` `rag_sync` / `rag_sync_queue_failed`, `job will retry`, `job failed` with `operation=rag_sync`.

## Backfill

Admin → Settings → Integrations → Hybrid RAG → **Reindex all posts** makes the collection hold exactly what readers see:
published posts are indexed, every other post is removed (this also clears drafts and unpublished posts left in the
collection while the sync was off). rag-api has no way to list documents, so a post deleted while the sync was off, or
the old address of a post renamed then, stays in the collection; remove it with `DELETE /documents/{doc_id}`.

With the SEO agent (D-107), the button starts the **Hybrid RAG reindex** flow (`rag_reindex_flow`,
`seo-agent/app/flows/rag_reindex.py`) and opens its run page (AI & SEO → Runs). A run that is already going is opened
instead of starting a second one. The flow only orchestrates; this site still builds and sends every document with
its own token, through the callback API (`src/lib/rag/callbacks.ts`):

| Step | What it does | What the run log says |
|---|---|---|
| plan | `GET /internal/seo-agent/rag/posts`: every post, what will happen to it and why (`ragReindexPlan`) | rag-api's URL, collection and service name (never the token); how many posts, how many to index by collection, members-only previews, how many to remove by reason (draft, in review, scheduled, archived, in the bin, noindex); the plan |
| index | `POST …/rag/posts/sync` for each post readers can see, one at a time, newest first (`ragSyncNow`: the sync job's own code, run in the request) | a line before each post (address, title, characters) and one after it: `indexed, 9 chunks embedded, 34.2 s`, or `unchanged, rag-api already holds this version`, or `sent twice` when it changed meanwhile |
| remove | the same call for every other post | one line per post (`a draft: removed from cms_content`, or `was not in cms_content`); its address and title only in the line's details |
| finish | the totals | indexed, unchanged, removed, refused, the chunks the collection holds, the slowest post, the run's duration |

- One post at a time, because an ingest is bge-m3 embedding the post on mk4's CPU. rag-api skips a post it already
  holds in the same version (same text, metadata, chunking and model), so a second run embeds only what changed.
- rag-api down, slow or overloaded (or the site not answering): the run stops and hands the posts it had not done,
  that one included, to the background sync jobs (`POST …/rag/posts/queue`), which retry with their backoff. The run
  fails and says how many it handed over; the Sync card above shows how they go.
- The token refused (401/403) or the sync switched off meanwhile: the run stops; nothing more is sent.
- A post rag-api refuses on its own (too large, say): logged, the run carries on, and the run fails at the end
  naming it.
- Titles and addresses of posts readers cannot see are only in the run's own log (the line's details), never in the
  agent's stderr → Loki.
- The flow can also be started from AI & SEO → Flows → Hybrid RAG reindex (Run) or given a schedule there (no built-in
  one).

Without the SEO agent, the button queues one sync job per post instead (`queueRagReindex`); they run in the background
over the next minutes and the Sync card shows how many went through.

## Search

`searchPublished(query, { limit, filters })` in `lib/rag/sync.ts` calls `POST /query` with `include_answer: false` (no
LLM, no cost) and the filter `status: "published"` (any other filters are added; `status` cannot be overridden). It
returns the best chunk of each post, best first, and throws `RagError` when the sync is off or rag-api fails, so a
caller can fall back to the keyword search. Admin → Settings → Integrations → Hybrid RAG → Test search uses it. The public
`/search` page still uses its keyword index (`/search-index.json`); putting semantic search there needs a public
route with rate limits (like `/api/ask`) and is not part of this change.
