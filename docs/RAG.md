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

Admin → Settings → Integrations → Hybrid RAG → **Reindex all posts** queues one job for every post in the database: published
posts are indexed, every other post is removed (this also clears drafts and unpublished posts left in the collection
while the sync was off). rag-api has no way to list documents, so a post deleted while the sync was off, or the old
address of a post renamed then, stays in the collection; remove it with `DELETE /documents/{doc_id}`.

## Search

`searchPublished(query, { limit, filters })` in `lib/rag/sync.ts` calls `POST /query` with `include_answer: false` (no
LLM, no cost) and the filter `status: "published"` (any other filters are added; `status` cannot be overridden). It
returns the best chunk of each post, best first, and throws `RagError` when the sync is off or rag-api fails, so a
caller can fall back to the keyword search. Admin → Settings → Integrations → Hybrid RAG → Test search uses it. The public
`/search` page still uses its keyword index (`/search-index.json`); putting semantic search there needs a public
route with rate limits (like `/api/ask`) and is not part of this change.
