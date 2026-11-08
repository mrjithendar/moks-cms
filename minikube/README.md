# jithendar.com manifests for the mk4 minikube cluster

Everything jithendar.com runs on the mk4 cluster, in one flat folder. Exported from the live cluster on 2026-10-29
with cluster-generated fields removed, not deployed by Argo CD. The file name says which of three groups a manifest
belongs to; each group is applied on its own, and `scripts/manifests.sh <group>` prints it for `kubectl … -f -`.

| Group | Files | Applied by |
|---|---|---|
| `site` | `00-…` to `85-…`, listed in `kustomization.yaml` | `./deploy.sh` (all of it); CI applies the application objects |
| `practice-executor` | `practice-executor-*.yaml` | a person, once, after gVisor is verified; then CI (application objects) |
| `db-access` | `db-access-*.yaml` | CI, once its Role allows TCP routes (`DB_ACCESS.md`) |

## Site (`kustomization.yaml`)

| File | Resources |
|---|---|
| `00-namespace.yaml` | Namespace `jithendar` |
| `10-postgres.yaml` | StatefulSet, Service, NetworkPolicy `jithendar-postgres` (10 Gi volume, pinned to node `mk4-m03`) |
| `20-redis.yaml` | Deployment, Service, NetworkPolicy `jithendar-redis` |
| `30-jithendar-com.yaml` | Deployment (2 replicas), Service, PodDisruptionBudget, NetworkPolicy `jithendar-com` |
| `45-jithendar-letsencrypt.yaml` | ClusterIssuers `letsencrypt-prod` and `letsencrypt-staging` (cluster-wide; formerly the `roboshop-letsencrypt` Argo CD app) |
| `50-certificate.yaml` | Certificate `jithendar-com` (apex + www) → Secret `jithendar-com-tls` |
| `55-tlsstore.yaml` | Traefik `TLSStore default`: `jithendar-com-tls`, Traefik's certificate while it still runs. Removed with Traefik ("Leaving Traefik"); the Istio gateway has its own wildcard certificate |
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
| `practice-executor-30-redis.yaml` | The executor's own Redis queue |
| `practice-executor-40-executor.yaml` | ConfigMap, API and dispatcher Deployments, Service `practice-executor` |
| `practice-executor-50-networkpolicies.yaml` | Allowed traffic |

Images are always `:latest`. CI (`ci-practice-executor.yml`, job `deploy`) pushes `:latest` and restarts both
Deployments on every release once repository variable `PRACTICE_EXECUTOR_DEPLOY` is `true`.

## Database access (`db-access-*.yaml`)

Adminer at `https://jithendar.com/db/` and PostgreSQL at `db.jithendar.com:443`, both limited to two client IPs.
Read [`DB_ACCESS.md`](DB_ACCESS.md) first: the order matters.

| File | Resources |
|---|---|
| `db-access-10-allowlist.yaml` | The allowed client addresses: AuthorizationPolicies `istio-ingress/db-allowlist` (/db) and `istio-ingress/db-tcp-allowlist` (db.jithendar.com); edit both lists together |
| `db-access-20-adminer.yaml` | Adminer (`jithendar-db-ui`): Deployment, Service, NetworkPolicy, delegate VirtualService for /db |
| `db-access-30-postgres-tls.yaml` | VirtualService `jithendar-db` (TCP) for `db.jithendar.com` on Gateway `istio-ingress/public`, NetworkPolicy `jithendar-postgres-remote` |

## Leaving Traefik

The whole order, all repositories, is miniKube's `deploy/minikube/istio/README.md`. This repository's part:

- Before the miniKube Terraform step: `$K apply -k minikube` and `scripts/manifests.sh db-access | $K apply -f -`
  (`K="kubectl --context mk4"`). They add the delegate `jithendar-com-site`, the TCP route `jithendar-db` and both
  allowlists, and change nothing that serves traffic yet. NetworkPolicies still admit Traefik and every
  PeerAuthentication is PERMISSIVE, so the order of applies cannot cut the site off.
- After the host forwards to the gateway and Traefik is uninstalled, delete what Traefik used (CI never deletes):
  `$K -n jithendar delete virtualservice jithendar-com` (the old root, replaced by miniKube's),
  `$K -n jithendar delete ingressroutetcp jithendar-db`, `delete tlsoption db-postgres`,
  `delete middlewaretcp db-allowlist`, `delete certificate db-jithendar-com jithendar-com`, `delete tlsstore default`,
  `delete peerauthentication jithendar-postgres-remote`, and `$K delete clusterissuer letsencrypt-prod letsencrypt-staging`
  once no Certificate names them (`$K get certificate -A`).
- Then the cleanup change: drop `45-`, `50-` and `55-` from the kustomization, the `traefik` entries from the
  NetworkPolicies `jithendar-com`, `jithendar-db-ui` and `jithendar-postgres-remote`, and set `default` in `75-mesh.yaml`
  to `STRICT` (`$K apply -f minikube/75-mesh.yaml`). `:9464` keeps its PERMISSIVE exception for Prometheus.

## Before the first deploy

These Secrets must exist in `jithendar`; they are never committed. `scripts/create-secrets.sh mk4`
creates the first three.

- `jithendar-postgres` (key `password`), `jithendar-redis` (key `password`)
- `jithendar-com-env` (site configuration; its `DATABASE_URL`/`REDIS_URL` passwords match the two above)
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
