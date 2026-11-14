# Deployment — jithendar.com on mk4

**When a pull request is merged into `master`, CI builds, pushes `jithendar-com:pr-<number>` and `:latest` (one image) and rolls the site out on `:pr-<number>`** (a plain push to `master` builds nothing: the workflows have no `push` trigger); `.github/workflows/deploy-minikube.yml` applies manifest changes on the same merge (there is no `deploy.sh` any more, removed 2026-11-14). Argo CD is not used for this site. The site runs the tag of its last release, `:pr-<number>`, with `imagePullPolicy: Always`, never a digest (owner decision 2026-11-14; until then it always ran `:latest`). CI points the Deployment at the new tag after each image build and, from `deploy-minikube.yml`, applies `minikube/` without changing the image a workload runs (see Release).

| Piece | Where |
|---|---|
| Image | `registry.jithendar.com/jithendar/jithendar-com` in Harbor (arm64; every release is `:pr-<number>`, `:latest` names the newest; last 10 builds kept; CI pushes as robot `robot$jithendar+jithendar-com`, secrets `HARBOR_USERNAME`/`HARBOR_PASSWORD`) |
| Pipeline | `.github/workflows/ci-jithendar-com.yml`: `check` on pull requests; when a pull request that changes the image is merged into `master`, `release` pushes `jithendar-com:pr-<number>` and `:latest` and runs `scripts/ci-rollout.py`, which sets every Deployment that uses the image to `:pr-<number>` and waits |
| Deploy | Automatic when a pull request is merged into `master` (never on a direct push): the image workflows roll the Deployments out on the new tag, `deploy-minikube.yml` applies `minikube/`. Run that workflow by hand to re-apply everything and restart the site |
| Manifests | `minikube/` at the repository root, one file per component (see `minikube/README.md`); they name `jithendar-com:latest`, which only a first apply uses: a workload that exists keeps the image it runs (`scripts/keep-live-images.py`) |
| Image pulls | Secret `jithendar/harbor-pull` (read-only robot `robot$k8s-pull`, never expires), written by the tools repository's `deploy/minikube/harbor/registry.py pull-secrets` |
| TLS | The Istio gateway's wildcard certificate (`jithendar.com`, `*.jithendar.com`, DNS-01), in the miniKube repo (`deploy/minikube/istio/edge`). `minikube/45-`, `50-` and `55-` are Traefik's certificate and TLSStore, kept only until Traefik is uninstalled (`minikube/README.md`, "Leaving Traefik"). |

## Data services (shared, in the miniKube repo)

| Service | Manifest | Notes |
|---|---|---|
| PostgreSQL 18 (shared CloudNativePG) | miniKube repo, `minikube-infrastructure/postgres.tf` | Database and role `jithendar` on `postgres-db/postgres-cluster` (3 instances, PgBouncer pooler in session mode). `DATABASE_URL` comes from Secret `postgres-db-credentials` (key `uri`), written by Terraform. Moved from the old `jithendar-postgres` StatefulSet on 2026-11-09. |
| Redis | shared Valkey (namespace `redis`), **pub/sub only** | No `REDIS_URL` since 2026-11-09: Better Auth sessions, rate limits and API keys stay in Postgres. Caches are per process; the **cache bus** (`src/lib/cache-bus.ts`) tells the other replica to clear them over Valkey pub/sub, so an edit shows on both within about a second. It reads only `CACHE_BUS_REDIS_URL`, from Secret `redis-site-cachebus-credentials` (key `uri`, ACL user `site-cachebus`: PUBLISH/SUBSCRIBE on `jithendar:*`, no keys), written by Terraform in the miniKube repo (`docs/redis-site-cachebus.md`). The env entry is optional: without the Secret, or with Valkey down, a change shows on the other replica after the cache TTL, as before. The practice executor uses its own tenant (`redis-practice-credentials`). |

Secrets (never in Git), created once by `scripts/create-secrets.sh`:

| Secret | Keys |
|---|---|
| `redis-site-cachebus-credentials` | `uri` (and `host`, `port`, `username`, `password`): written by Terraform in the miniKube repo (`docs/redis-site-cachebus.md`), not by this script; optional |
| `postgres-db-credentials` | `uri` (and `host`, `port`, `dbname`, `username`, `password`, `direct-host`, `direct-uri`): written by Terraform in the miniKube repo, not by this script |
| `jithendar-com-env` | `BETTER_AUTH_SECRET`, `SETTINGS_ENCRYPTION_KEY`, `ADMIN_BOOTSTRAP_TOKEN`, `METRICS_TOKEN`, `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`, optional `SMTP_URL`, `MAIL_FROM` (fallback until email is configured in the admin, see `docs/EMAIL.md`); media: `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, optional `R2_PUBLIC_BASE_URL`; optional `GEMINI_API_KEY`, `GEMINI_IMAGE_MODEL` (added with `scripts/set-media-config.sh`) |

Back up `SETTINGS_ENCRYPTION_KEY` with your database backups: it decrypts the stored storage, email, social sign-in and Gemini credentials.
Gemini limits (`GEMINI_IMAGE_*`) are plain env values in `minikube/30-jithendar-com.yaml`.
Public identifiers for search engines, GA4, AdSense, ads.txt and IndexNow live in the optional ConfigMap
`jithendar-com-public` (`scripts/set-public-config.sh`; see `docs/SEO_ANALYTICS_ADS.md`). The site runs without it.
Scheduled publishing and IndexNow retries run inside the site pods (no extra workload; `docs/EDITOR.md`). Media architecture,
R2 bucket setup (CORS, lifecycle) and the S3 → R2 migration: see `docs/MEDIA.md`.

## First-time setup

1. Create a Turnstile widget for `jithendar.com` in the Cloudflare dashboard (site key + secret key).
2. `scripts/create-secrets.sh mk4` and keep the printed setup token.
3. First time only, with the `mk4` kubeconfig: `kubectl apply -k minikube` (creates the namespace and the site; database migrations run on start), then `scripts/setup-ci-deployer.sh` and `scripts/setup-ci-applier.sh` so CI can deploy from then on.
4. Open `https://jithendar.com/setup`, enter the token, and create the admin account. This also imports the existing articles and pages. `/setup` disappears once an admin exists.
5. Create the R2 bucket, CORS and lifecycle rules (`docs/MEDIA.md` → Setup), then `scripts/set-media-config.sh mk4` and restart the deployment. (Alternatively configure R2 under Admin → Storage.)

## Routing

The Istio ingress gateway is the edge. The jithendar.com routing table (root VirtualService, Gateway, certificate,
compression, logins) is in the miniKube repo, `deploy/minikube/istio/edge`; the site is its default route, the
delegate `jithendar-com-site` in `minikube/60-istio-routing.yaml`.

- `https://jithendar.com/` → site. The other applications' prefixes (`/argocd`, `/db`, `/grafana`, `/moks`, `/prometheus`, `/roboshop`, ...) are delegated before it.
- `http://…/*` → 301 to https (the Gateway's `httpsRedirect`).
- `https://www.jithendar.com/*` → 308 to `https://jithendar.com/*`, path and query kept.
- X-Forwarded-For is exactly the visitor's address (from the host's PROXY protocol); a client cannot set its own.
- Text responses are compressed by the gateway (zstd/br/gzip; EnvoyFilter `istio-ingress/response-compression`).

## Release

Merge a pull request into `master`. CI's `release` job lints, tests, builds `linux/arm64` with `GIT_SHA` baked in, pushes `jithendar-com:pr-<number>` and `:latest`, sets `deploy/jithendar-com` (and any other Deployment that runs this image) to `:pr-<number>` and waits for the rollout. Nothing else to do. `kubectl -n jithendar get deploy -o wide` shows which release is live. A pod that restarts later gets the same image again, whatever has been pushed since.

### Manifest changes (`.github/workflows/deploy-minikube.yml`)

A pull request that changes `minikube/` is applied to mk4 from GitHub Actions when it is merged into `master`. The
workflow dry-runs every object on the server, prints the diff, applies, restarts what needs it, waits for every
Deployment and StatefulSet and runs the smoke test (the smoke test runs even when another workload failed to roll
out). It never deletes anything. `scripts/ci-app-manifests.py` decides what is applied:

| Group | Applied by CI | Never applied by CI |
|---|---|---|
| `site` (`kustomization.yaml`) | everything else: the Namespace `jithendar`, Deployment, Services, PodDisruptionBudget, NetworkPolicies, VirtualService, ServiceAccounts, Roles and RoleBindings (including CI's own), PeerAuthentication, AuthorizationPolicy | the two ServiceAccount token Secrets; the ClusterRole and ClusterRoleBinding in `85-ci-applier.yaml` |
| `practice-executor` | application objects: ConfigMap, Deployments, Service, NetworkPolicies | RuntimeClass, ServiceAccounts, RBAC, admission policies, quota |
| `seo-agent` | application objects: ConfigMap, Deployment, Services, NetworkPolicies | CronJobs |

Restarts: pods read a ConfigMap only when they start, so when a group's ConfigMap changed the workflow restarts that
group's Deployments. A Deployment whose own spec changed rolls by itself.

**Manual run** (Actions → deploy to minikube → Run workflow, on `master`; or `gh workflow run deploy-minikube.yml --ref master`):
applies everything as above and restarts the site (input `restart_site`, on by default); it comes back on the image it was running.
This is what `./deploy.sh` did.

**What moved from a person to CI on 2026-11-14 (owner decision).** Until then CI applied only application objects,
and RBAC, ServiceAccounts, the Namespace and the mesh policies needed `./deploy.sh`, "so a commit cannot widen CI's
own access". The owner chose to remove the script and have the workflow apply the whole site group on merge. The
consequences, accepted with that decision:

- `jithendar/github-ci-applier` holds `escalate` and `bind` on Roles in namespace `jithendar`. A merged pull request
  that edits a Role in `minikube/` can give CI, or any ServiceAccount in the namespace, any permission in that
  namespace, including reading its Secrets. As committed it cannot read Secrets.
- A merged pull request can also relax the namespace's mTLS (`PeerAuthentication`) and who may call it
  (`AuthorizationPolicy`).
- So review pull requests that touch `minikube/70-`, `75-`, `80-`, `85-` as changes to cluster access, and keep
  branch protection on `master`. Anyone who can merge, or who holds `MK4_CI_APPLY_TOKEN`, has that reach.
- Unchanged limits: namespace `jithendar` only; nothing is deleted; no Secrets; no pods created directly; nothing
  cluster-wide except patching the Namespace object `jithendar` itself.

What `./deploy.sh` did that the workflow does not: check first that the Secrets `jithendar-com-env`,
`postgres-db-credentials` and `harbor-pull` exist (CI cannot read Secrets). A missing one now shows as a rollout
that does not become ready, and the job fails with the pod list.

One-time setup, **and again after this change**: `scripts/setup-ci-applier.sh` (applies `minikube/85-ci-applier.yaml`
including its ClusterRole, which CI cannot apply itself, checks what the token may and may not do, stores secret
`MK4_CI_APPLY_TOKEN` and sets variable `MINIKUBE_DEPLOY=true`; until then the deploy job is skipped). Until it has
been run once with the widened Role, the workflow's server dry run fails with "forbidden" and changes nothing. Turn it off with
`gh variable set MINIKUBE_DEPLOY --body false`; revoke with `kubectl -n jithendar delete secret github-ci-applier-token`.

## Smoke test

```bash
scripts/smoke.sh https://jithendar.com [expected-commit-sha]
kubectl -n jithendar get certificate jithendar-com   # READY True
```

The script checks health (and version), homepage, about, RSS, both sitemaps, robots.txt, 404, the 410 hijack URLs, http→https, www→apex, and that `/argocd/` is unaffected.

## Rollback

Fastest: `kubectl -n jithendar set image deploy/jithendar-com web=registry.jithendar.com/jithendar/jithendar-com:pr-<last good number>` (the container is called `web`; `python3 scripts/ci-rollout.py registry.jithendar.com/jithendar/jithendar-com pr-<last good number>` does the same for every Deployment that runs the image and waits) (every release keeps its `pr-<number>` tag). It stays there until the next release: applying `minikube/`, by a merge or a manual run of the deploy workflow, does not change the image. `kubectl -n jithendar rollout undo deploy/jithendar-com` also works now that each release has its own tag. Or revert the bad change in a pull request and merge it: CI builds it and rolls it out as a new `pr-<number>`. A failed rollout leaves the old pods serving, so a broken image never takes the site down by itself.

## Limits

Single host: if the server goes down, the site is down. Two replicas cover pod restarts and rollouts only.
