# Deployment — jithendar.com on mk4

**CI builds, pushes `jithendar-com:latest` and restarts the site**; `./deploy.sh` (repository root) applies manifest changes with `kubectl apply -k`. Argo CD is not used for this site. The site always runs `:latest` with `imagePullPolicy: Always`, never a pinned digest (owner decision, 2026-11-03). CI restarts the Deployment after each image build and, from `deploy-minikube.yml`, applies the application manifests (see Release).

| Piece | Where |
|---|---|
| Image | `registry.jithendar.com/jithendar/jithendar-com:latest` in Harbor (arm64, `latest` is the only tag, last 10 builds kept; CI pushes as robot `robot$jithendar+jithendar-com`, secrets `HARBOR_USERNAME`/`HARBOR_PASSWORD`) |
| Pipeline | `.github/workflows/ci-jithendar-com.yml`: `check` on pull requests; on `master`, `release` pushes `jithendar-com:latest` (the only tag) and runs `kubectl rollout restart` |
| Deploy | Automatic on push to `master`. `./deploy.sh` for manifest changes, run by a person with the `mk4` kubeconfig |
| Manifests | `minikube/` at the repository root, one file per component (see `minikube/README.md`); the image is `jithendar-com:latest` |
| Image pulls | Secret `jithendar/harbor-pull` (read-only robot `robot$k8s-pull`, never expires), written by the tools repository's `deploy/minikube/harbor/registry.py pull-secrets` |
| TLS | The Istio gateway's wildcard certificate (`jithendar.com`, `*.jithendar.com`, DNS-01), in the miniKube repo (`deploy/minikube/istio/edge`). `minikube/45-`, `50-` and `55-` are Traefik's certificate and TLSStore, kept only until Traefik is uninstalled (`minikube/README.md`, "Leaving Traefik"). |

## Data services (shared, in the miniKube repo)

| Service | Manifest | Notes |
|---|---|---|
| PostgreSQL 18 (shared CloudNativePG) | miniKube repo, `minikube-infrastructure/postgres.tf` | Database and role `jithendar` on `postgres-db/postgres-cluster` (3 instances, PgBouncer pooler in session mode). `DATABASE_URL` comes from Secret `postgres-db-credentials` (key `uri`), written by Terraform. Moved from the old `jithendar-postgres` StatefulSet on 2026-11-09. |
| Redis | none | The site runs without Redis since 2026-11-09 (no `REDIS_URL`): Better Auth sessions and rate limits are in Postgres, caches are per process, so a change can take up to the cache TTL to show on the other replica. The practice executor still uses the shared Valkey (`redis-practice-credentials`). |

Secrets (never in Git), created once by `scripts/create-secrets.sh`:

| Secret | Keys |
|---|---|
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
3. `./deploy.sh` (creates Postgres, runs database migrations on start, deploys the site).
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

Push to `master`. CI's `release` job lints, tests, builds `linux/arm64` with `GIT_SHA` baked in, pushes `jithendar-com:latest` and restarts `deploy/jithendar-com`, which pulls the new `:latest`. Nothing else to do.

After changing `minikube/`, from an up-to-date checkout at the repository root:
```bash
./deploy.sh
```
It server dry-runs, applies `minikube/`, restarts the site on `:latest`, waits for the rollout and runs the smoke test.

### Manifest changes from CI (`.github/workflows/deploy-minikube.yml`)

A push to `master` that changes `minikube/` (including `minikube/practice-executor-*.yaml`) also applies the **application
objects** to mk4 from GitHub Actions: Deployments, StatefulSets, Services, ConfigMaps, Ingresses, NetworkPolicies,
PodDisruptionBudgets, cert-manager Certificates and Istio VirtualServices in namespace `jithendar`
(`scripts/ci-app-manifests.py` decides). It dry-runs on the server, prints the diff, applies, waits for every
Deployment and StatefulSet and runs the smoke test. It never deletes anything.

Not applied by CI, still `./deploy.sh` (or `scripts/manifests.sh practice-executor | kubectl apply -f -`): the Namespace,
ClusterIssuers, TLSStore, RBAC, ServiceAccounts, Secrets, quotas, the RuntimeClass and admission policies. CI signs in as `jithendar/github-ci-applier` (`minikube/85-ci-applier.yaml`), which can only create and
update those application kinds, so a commit cannot widen its access. Pull requests get the same selection as a
plan, without cluster access.

One-time setup: `scripts/setup-ci-applier.sh` (applies the ServiceAccount, stores secret `MK4_CI_APPLY_TOKEN` and
sets variable `MINIKUBE_DEPLOY=true`; until then the deploy job is skipped). Turn it off with
`gh variable set MINIKUBE_DEPLOY --body false`; revoke with `kubectl -n jithendar delete secret github-ci-applier-token`.

## Smoke test

```bash
scripts/smoke.sh https://jithendar.com [expected-commit-sha]
kubectl -n jithendar get certificate jithendar-com   # READY True
```

The script checks health (and version), homepage, about, RSS, both sitemaps, robots.txt, 404, the 410 hijack URLs, http→https, www→apex, and that `/argocd/` is unaffected.

## Rollback

`git revert` the bad commit and push: CI builds it, moves `:latest` and restarts the site. (`kubectl rollout undo` does not help: the previous pod template is also `:latest`.) A failed rollout leaves the old pods serving, so a broken image never takes the site down by itself.

## Limits

Single host: if the server goes down, the site is down. Two replicas cover pod restarts and rollouts only.
