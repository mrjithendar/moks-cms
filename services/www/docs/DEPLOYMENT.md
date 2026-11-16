# Deployment — jithendar.com on mk4

> **Moved, 2026-11-16.** jithendar.com is deployed from its own repository, `mrjithendar/jithendar.com`, which now
> holds the site, `kubernetes/`, the deploy, Secret and config scripts, and the workflows (`content.yml`,
> `deploy-kubernetes.yml`). moks-cms only tests and pushes images: `moks-cms` (`ci-moks-cms.yml`) and `seo-agent`. The
> practice executor, its sandboxes, problems and manifests are in `mrjithendar/practice-programming`, which deploys them. The site runs `moks-cms:<tag>` as named in its manifests, and its content image
> `jithendar-com-content` brings the articles, images, `site.json` and `config/`, which the CMS reads at run time.
> Paths below such as `kubernetes/`, `scripts/` and `.github/workflows/deploy-kubernetes.yml` are in that repository.
> The rest of this page is the setup as it was, kept for the cluster details (data services, Secrets, routing), which
> have not changed.

**When a pull request is merged into `master`, CI builds, pushes `moks-cms:pr-<number>` and `:latest` (one image) and rolls the site out on `:pr-<number>`** (a plain push to `master` builds nothing: the workflows have no `push` trigger); `.github/workflows/deploy-kubernetes.yml` applies manifest changes on the same merge (there is no `deploy.sh` any more, removed 2026-11-14). Argo CD is not used for this site. The site runs the tag of its last release, `:pr-<number>`, with `imagePullPolicy: Always`, never a digest (owner decision 2026-11-14; until then it always ran `:latest`). CI points the Deployment at the new tag after each image build and, from `deploy-kubernetes.yml`, applies `kubernetes/` without changing the image a workload runs (see Release).

| Piece | Where |
|---|---|
| Image | `registry.jithendar.com/jithendar/moks-cms` in Harbor (arm64; every release is `:pr-<number>`, `:latest` names the newest; last 10 builds kept; CI pushes as robot `robot$jithendar+jithendar-com`, secrets `HARBOR_USERNAME`/`HARBOR_PASSWORD`) |
| Pipeline | `.github/workflows/ci-jithendar-com.yml`: `check` on pull requests; when a pull request that changes the image is merged into `master`, `release` pushes `moks-cms:pr-<number>` and `:latest` and runs `scripts/ci-rollout.py`, which sets every Deployment that uses the image to `:pr-<number>` and waits |
| Deploy | Automatic when a pull request is merged into `master` (never on a direct push): the image workflows roll the Deployments out on the new tag, `deploy-kubernetes.yml` applies `kubernetes/`. Run that workflow by hand to re-apply everything and restart the site |
| Manifests | `kubernetes/` at the repository root, one file per component (see `kubernetes/README.md`); they name `moks-cms:latest`, which only a first apply uses: a workload that exists keeps the image it runs (`scripts/keep-live-images.py`) |
| Image pulls | Secret `jithendar/harbor-pull` (read-only robot `robot$k8s-pull`, never expires), written by the tools repository's `deploy/minikube/harbor/registry.py pull-secrets` |
| TLS | The Istio gateway's wildcard certificate (`jithendar.com`, `*.jithendar.com`, DNS-01), in the miniKube repo (`deploy/minikube/istio/edge`). `kubernetes/45-`, `50-` and `55-` are Traefik's certificate and TLSStore, kept only until Traefik is uninstalled (`kubernetes/README.md`, "Leaving Traefik"). |

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
Gemini limits (`GEMINI_IMAGE_*`) are plain env values in `kubernetes/30-jithendar-com.yaml`.
Public identifiers for search engines, GA4, AdSense, ads.txt and IndexNow live in the optional ConfigMap
`jithendar-com-public` (`scripts/set-public-config.sh`; see `docs/SEO_ANALYTICS_ADS.md`). The site runs without it.
Scheduled publishing and IndexNow retries run inside the site pods (no extra workload; `docs/EDITOR.md`). Media architecture,
R2 bucket setup (CORS, lifecycle) and the S3 → R2 migration: see `docs/MEDIA.md`.

## First-time setup

1. Create a Turnstile widget for `jithendar.com` in the Cloudflare dashboard (site key + secret key).
2. `scripts/create-secrets.sh mk4` and keep the printed setup token.
3. First time only, with the `mk4` kubeconfig: `kubectl apply -k kubernetes` (creates the namespace and the site; database migrations run on start), then `scripts/setup-ci-deployer.sh` and `scripts/setup-ci-applier.sh` so CI can deploy from then on.
4. Open `https://jithendar.com/setup`, enter the token, and create the admin account. This also imports the existing articles and pages. `/setup` disappears once an admin exists.
5. Create the R2 bucket, CORS and lifecycle rules (`docs/MEDIA.md` → Setup), then `scripts/set-media-config.sh mk4` and restart the deployment. (Alternatively configure R2 under Admin → Storage.)

## Routing

The Istio ingress gateway is the edge. The jithendar.com routing table (root VirtualService, Gateway, certificate,
compression, logins) is in the miniKube repo, `deploy/minikube/istio/edge`; the site is its default route, the
delegate `jithendar-com-site` in `kubernetes/60-istio-routing.yaml`.

- `https://jithendar.com/` → site. The other applications' prefixes (`/argocd`, `/db`, `/grafana`, `/moks`, `/prometheus`, `/roboshop`, ...) are delegated before it.
- `http://…/*` → 301 to https (the Gateway's `httpsRedirect`).
- `https://www.jithendar.com/*` → 308 to `https://jithendar.com/*`, path and query kept.
- The gateway learns the connecting address from the host's PROXY protocol and reports it in `x-envoy-external-address`
  and as the last `X-Forwarded-For` entry. Behind Cloudflare's proxy that address is a Cloudflare edge server, not the
  visitor: see "Client addresses" below.
- Text responses are compressed by the gateway (zstd/br/gzip; EnvoyFilter `istio-ingress/response-compression`).

## Client addresses

Rate limits (sign-in, contact, paid calls, Ask the Blog, OAuth), the audit log and the paid-call currency all need the
visitor's address or country. `src/lib/client-ip.ts` is the only place that decides them:

1. The address the gateway saw: `x-envoy-external-address`, else the last `X-Forwarded-For` entry. Entries to the left
   of it were sent by the client and are never used.
2. `TRUSTED_EDGE=cloudflare` (the default, set in `kubernetes/30-jithendar-com.yaml`): when that address is one of
   [Cloudflare's](https://www.cloudflare.com/ips/), the visitor is `CF-Connecting-IP` and the country `CF-IPCountry`.
   A request that reaches the origin directly from any other public address is taken at its own address, whatever
   Cloudflare headers it sends, and gets no country (paid calls price in USD).
3. If the gateway reports a private address (the cluster's network hides the sender), Cloudflare's headers are used
   without that check. In that case the host firewall must only accept Cloudflare's ranges on 80/443, or anyone who
   knows the origin address can send their own `CF-Connecting-IP`.
4. `TRUSTED_EDGE=gateway`: no Cloudflare proxy in front (DNS only). Cloudflare's headers are ignored and step 1 is
   the answer.

Better Auth reads the result from `x-client-ip`, which the auth route sets (and overwrites) on every request. The
access log's `ip` field shows the decision: after a deploy, check that it is your own address and not `172.6x`/`162.158`
(Cloudflare) or a `10.`/`192.168.` one. `CLOUDFLARE_IP_RANGES` replaces the built-in list if Cloudflare changes it.

## Release

Merge a pull request into `master`. CI's `release` job builds `linux/arm64` with `GIT_SHA` baked in, pushes `moks-cms:pr-<number>` and `:latest`, sets `deploy/jithendar-com` (and any other Deployment that runs this image) to `:pr-<number>` and waits for the rollout. Nothing else to do. `kubectl -n jithendar get deploy -o wide` shows which release is live. A pod that restarts later gets the same image again, whatever has been pushed since.

**Lint and tests on a release.** They run on the pull request (`check`, and `test` in three shards). The release skips
them only when job `scope` finds, through the Actions API, that the pull request's head commit passed `check` and all
three `test` shards in an earlier run of the workflow. A pull request merged while they were failing, still running or
cancelled is linted and tested by the `release` job itself, as a manual run is, and a failure stops the release before
anything is pushed (the job summary and a warning say which case applied). The workflow checks this itself because
nothing else does: the repository is private on GitHub Free, where branch protection and required status checks are
not available (the API answers "Upgrade to GitHub Pro or make this repository public"), so GitHub lets a pull request
be merged at any time. Not covered: the tests ran on the pull request merged with `master` as it was then; commits that
reached `master` afterwards are not tested together with it until the next pull request.

### Manifest changes (`.github/workflows/deploy-kubernetes.yml`)

A pull request that changes `kubernetes/` is applied to mk4 from GitHub Actions when it is merged into `master`. The
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

**Manual run** (Actions → deploy to kubernetes → Run workflow, on `master`; or `gh workflow run deploy-kubernetes.yml --ref master`):
applies everything as above and restarts the site (input `restart_site`, on by default); it comes back on the image it was running.
This is what `./deploy.sh` did.

**What moved from a person to CI on 2026-11-14 (owner decision).** Until then CI applied only application objects,
and RBAC, ServiceAccounts, the Namespace and the mesh policies needed `./deploy.sh`, "so a commit cannot widen CI's
own access". The owner chose to remove the script and have the workflow apply the whole site group on merge. The
consequences, accepted with that decision:

- `jithendar/github-ci-applier` holds `escalate` and `bind` on Roles in namespace `jithendar`. A merged pull request
  that edits a Role in `kubernetes/` can give CI, or any ServiceAccount in the namespace, any permission in that
  namespace, including reading its Secrets. As committed it cannot read Secrets.
- A merged pull request can also relax the namespace's mTLS (`PeerAuthentication`) and who may call it
  (`AuthorizationPolicy`).
- So review pull requests that touch `kubernetes/70-`, `75-`, `80-`, `85-` as changes to cluster access, and keep
  branch protection on `master`. Anyone who can merge, or who holds `MK4_CI_APPLY_TOKEN`, has that reach.
- Unchanged limits: namespace `jithendar` only; nothing is deleted; no Secrets; no pods created directly; nothing
  cluster-wide except patching the Namespace object `jithendar` itself.

What `./deploy.sh` did that the workflow does not: check first that the Secrets `jithendar-com-env`,
`postgres-db-credentials` and `harbor-pull` exist (CI cannot read Secrets). A missing one now shows as a rollout
that does not become ready, and the job fails with the pod list.

One-time setup, **and again after this change**: `scripts/setup-ci-applier.sh` (applies `kubernetes/85-ci-applier.yaml`
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

Fastest: `kubectl -n jithendar set image deploy/jithendar-com web=registry.jithendar.com/jithendar/moks-cms:pr-<last good number>` (the container is called `web`; `python3 scripts/ci-rollout.py registry.jithendar.com/jithendar/moks-cms pr-<last good number>` does the same for every Deployment that runs the image and waits) (every release keeps its `pr-<number>` tag). It stays there until the next release: applying `kubernetes/`, by a merge or a manual run of the deploy workflow, does not change the image. `kubectl -n jithendar rollout undo deploy/jithendar-com` also works now that each release has its own tag. Or revert the bad change in a pull request and merge it: CI builds it and rolls it out as a new `pr-<number>`. A failed rollout leaves the old pods serving, so a broken image never takes the site down by itself.

## Limits

Single host: if the server goes down, the site is down. Two replicas cover pod restarts and rollouts only.

## What the release jobs' token may change

The image workflows sign in as ServiceAccount `github-ci-deployer` (`kubernetes/80-ci-deployer.yaml`). Its Role allows
`patch` on four Deployments, and a patch can change anything in a Deployment: with that token alone someone could
start another image, or the site's image with another command, next to the database credentials.

`kubernetes/81-ci-deployer-admission.yaml` is a ValidatingAdmissionPolicy (`ci-deployer-rollouts`) that describes what a
release actually changes: container images, from `registry.jithendar.com/jithendar/` only, and the `restartedAt`
annotation of `kubectl rollout restart`. Everything else in the pod template has to stay as it is.

- It is **not applied by CI** (admission policies never are). A cluster admin applies it once:
  `kubectl apply -f kubernetes/81-ci-deployer-admission.yaml`.
- It ships in **warn mode**: a release that breaks a rule still goes through, and kubectl prints
  `Warning: Validation failed for ValidatingAdmissionPolicy 'ci-deployer-rollouts' …` in the release job's log.
- After one release with no such warning, set `validationActions: ["Deny"]` in the binding and apply the file again.
- The same file holds a second policy, `ci-deployer-rollouts-extra` (added 2026-11-15), for the parts of the pod template
  the first one does not compare: probes (an `exec` probe runs a command inside the container, so adding one was as good
  as changing the command), an init container's hooks and restart policy, container ports and working directory, the
  RuntimeClass, process-namespace sharing, service-account token mounting, DNS settings and host aliases. It is separate,
  and also in warn mode, because its rules have not been tried on the cluster yet: apply the file, watch one release
  for `…'ci-deployer-rollouts-extra'` warnings, then switch its binding to `["Deny"]` on its own. Until both bindings
  say `Deny`, `MK4_CI_TOKEN` can still change anything in the four Deployments.
- `scripts/tests/test_admission_policy.py` (job `hygiene`) fails when a Deployment the deployer may patch uses a
  pod-template field that neither policy compares and that is not listed there as deliberately left alone.
- It does not cover `github-ci-applier`, which applies `kubernetes/` and may change Deployments by design.
