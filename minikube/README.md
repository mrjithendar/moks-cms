# jithendar.com manifests for the mk4 minikube cluster

Everything jithendar.com runs on the mk4 cluster, in one flat folder. Exported from the live cluster on 2026-10-29
with cluster-generated fields removed, not deployed by Argo CD. The file name says which of two groups a manifest
belongs to; each group is applied on its own, and `scripts/manifests.sh <group>` prints it for `kubectl … -f -`.

| Group | Files | Applied by |
|---|---|---|
| `site` | `00-…` to `85-…`, listed in `kustomization.yaml` | `./deploy.sh` (all of it); CI applies the application objects |
| `practice-executor` | `practice-executor-*.yaml` | a person, once, after gVisor is verified; then CI (application objects) |

## Site (`kustomization.yaml`)

| File | Resources |
|---|---|
| `00-namespace.yaml` | Namespace `jithendar` |
| `30-jithendar-com.yaml` | Deployment (2 replicas), Service, PodDisruptionBudget, NetworkPolicy `jithendar-com` |
| `60-istio-routing.yaml` | Delegate VirtualService `jithendar-com-site`: the default route of the jithendar.com routing table in the miniKube repo (`deploy/minikube/istio/edge`, which also does www → apex, HTTP → HTTPS and compression). Strips client trace headers |
| `70-observability.yaml` | Headless Service `jithendar-com-metrics` (Prometheus, port 9464) and Role/RoleBinding `alloy-logs`; see `www/docs/OBSERVABILITY.md` |
| `80-ci-deployer.yaml` | ServiceAccount `github-ci-deployer`: CI may only restart the site and the executor (`scripts/setup-ci-deployer.sh`) |
| `85-ci-applier.yaml` | ServiceAccount `github-ci-applier`: `.github/workflows/deploy-minikube.yml` applies the application objects (not RBAC, Secrets or anything cluster-wide; `scripts/setup-ci-applier.sh`) |

The Grafana dashboards are not cluster manifests here: they live in [`../grafana/`](../grafana/README.md) and
reach Grafana through Argo CD.

## Python practice executor (`practice-executor-*.yaml`)

Code runner in namespace `jithendar`, next to the site (`www/docs/PYTHON_PRACTICE_EXECUTOR.md`). Not in
`kustomization.yaml` on purpose, so `./deploy.sh` never applies it. Apply it by hand, only after gVisor is
installed (`scripts/install-gvisor-mk4.sh`), then prove isolation with `scripts/verify-practice-sandbox.sh`:

```sh
scripts/manifests.sh practice-executor | kubectl --context mk4 apply -f -
```

| File | Resources |
|---|---|
| `practice-executor-05-runtimeclass.yaml` | RuntimeClass `gvisor-nonet` (runsc, no network) |
| `practice-executor-10-rbac.yaml` | ServiceAccounts `practice-dispatcher`, `practice-api`, `practice-sandbox`; Role/RoleBinding for the dispatcher |
| `practice-executor-15-admission.yaml` | ValidatingAdmissionPolicies that pin down sandbox pods |
| `practice-executor-20-quota.yaml` | ResourceQuota for all sandboxes together |
| `practice-executor-40-executor.yaml` | ConfigMap, API and dispatcher Deployments, Service `practice-executor` |
| `practice-executor-50-networkpolicies.yaml` | Allowed traffic |

Images are always `:latest`. CI (`ci-practice-executor.yml`, job `deploy`) pushes `:latest` and restarts both
Deployments on every release once repository variable `PRACTICE_EXECUTOR_DEPLOY` is `true`.

## Database (shared CloudNativePG cluster)

The site's database is `jithendar` on the shared cluster `postgres-db/postgres-cluster` (miniKube repo,
`minikube-infrastructure/postgres.tf`, `postgres_databases.jithendar`). Terraform writes Secret
`jithendar/postgres-db-credentials`; the site reads its `uri` (PgBouncer pooler, session mode) as `DATABASE_URL`.
It was copied there from the old `jithendar-postgres` StatefulSet on 2026-11-09 (`dbMigration.sh` in the workspace,
row counts verified). The site's own Adminer (`/db`) and `db.jithendar.com` are gone with it: use the cluster's
`/postgres` UI and `postgres.jithendar.com` (miniKube repo, `deploy/minikube/postgres/access`).

## Traefik (gone)

Traefik was uninstalled on 2026-11-09; the Istio gateway in the miniKube repo (`deploy/minikube/istio`) is the only
edge, with its own wildcard certificate (DNS-01). The old HTTP-01 ClusterIssuers `letsencrypt-prod`/`-staging`, the
Certificates `jithendar-com` and `db-jithendar-com`, Traefik's TLSStore, IngressRouteTCP, TLSOption and MiddlewareTCP
were deleted from mk4 the same day, and nothing here admits the `traefik` namespace any more. The namespace is STRICT
mTLS with no plain-text port: Prometheus scrapes `:9464` over mTLS through its own sidecar.

## Before the first deploy

These Secrets must exist in `jithendar`; they are never committed. `scripts/create-secrets.sh mk4`
creates `jithendar-com-env`; Terraform in the miniKube repository writes the database and Redis ones.

- `jithendar-com-env` (site configuration)
- `postgres-db-credentials` (key `uri`, read as `DATABASE_URL`): the shared CloudNativePG cluster in namespace
  `postgres-db`, written by Terraform in the miniKube repository (`minikube-infrastructure/postgres.tf`)
- `redis-practice-credentials` (key `uri`, read as `EXECUTOR_REDIS_URL` by the practice executor): the shared Valkey
  in namespace `redis`, written by Terraform in the miniKube repository (`minikube-infrastructure/redis.tf`,
  `redis_tenants.practice`). The site itself uses no Redis (removed 2026-11-09)
- `harbor-pull` (pull secret for `registry.jithendar.com`, used by the site, the practice executor and sandbox pods;
  written by the tools repository's `deploy/minikube/harbor/registry.py pull-secrets`)

## Deploy

The site always runs `registry.jithendar.com/jithendar/jithendar-com:latest` (Harbor) with `imagePullPolicy: Always`. CI pushes `:latest` and restarts
the Deployment on every push to `master`, so new code needs nothing here.

```sh
./deploy.sh
```

Server dry-runs, applies the `site` group, restarts the site so it pulls `:latest`, waits for the rollouts and runs
`scripts/smoke.sh`.

To apply manifest changes without a new image, review and apply one group directly:

```sh
scripts/manifests.sh site | kubectl --context mk4 diff -f -
scripts/manifests.sh site | kubectl --context mk4 apply -f -
```

(`kubectl apply -k minikube` is the same as the `site` group.) Never `kubectl apply -f minikube/`: it would apply
every group at once and try to apply `kustomization.yaml` itself.

A push to `master` that changes `minikube/` also runs `.github/workflows/deploy-minikube.yml`, which applies the
application objects of all three groups as `github-ci-applier` (`www/docs/DEPLOYMENT.md`).
