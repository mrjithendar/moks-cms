# Cache bus on the shared Valkey (tenant `site-cachebus`)

Cross-replica cache invalidation for the site (`src/lib/cache-bus.ts`) over the shared Valkey in namespace `redis`,
**PUBLISH/SUBSCRIBE only**. This page is the handoff to the miniKube repository: the Terraform to add there, the
Secret it writes, the checks after the apply, and how to read the result.

| | |
|---|---|
| What it does | An edit (post, category, setting, integration, practice) clears the caches on **every** site pod within about a second, instead of up to the cache TTL on the other pod |
| What it stores in Valkey | Nothing. One channel, `jithendar:invalidate`; messages are `{"kind":"content","origin":"<random uuid per process>"}` |
| Site variable | `CACHE_BUS_REDIS_URL`, read only by `src/lib/cache-bus.ts` (enforced by `tests/cache-bus-env.test.ts`) |
| Not affected | `REDIS_URL` stays unset: sessions, rate limits and API keys stay in Postgres |
| Valkey down or Secret absent | The site behaves as before: each pod clears its own caches at once, the others after their TTL. No request waits on Valkey |

## 1. Terraform in the miniKube repository

Two names differ from the original request, because the repository's tenant schema derives both from one map key:

- **ACL user `site-cachebus`, not `jithendar_cachebus`.** Tenant keys must match `^[a-z][a-z0-9-]{0,40}$` (no
  underscore), and the Secret is always `redis-<key>-credentials`. Key `site-cachebus` gives exactly
  `redis-site-cachebus-credentials`, and the ACL user has the same name as for every other tenant.
- **The ACL is narrower than every existing tenant's.** `redis.tf` gives each tenant
  `~* &* +@all -@admin -flushall -swapdb db=…` and requires a database. The cache bus needs neither, so the snippet adds an
  optional `acl` override and makes `databases` optional.

### `minikube-infrastructure/_variables.tf`, variable `redis_tenants`

```hcl
variable "redis_tenants" {
  description = "Applications on the shared Valkey (redis.tf): ACL user named by the key, limited to its database numbers (or to its own acl), connection Secret redis-<key>-credentials written into namespace."
  type = map(object({
    namespace = string
    # Database numbers (0-31) this application may SELECT; the first is the uri's default. No two tenants share one.
    # Empty for a tenant that uses no keys (pub/sub only); the uri then has no database number.
    databases = optional(list(number), [])
    # Replaces the default rule ("~* &* +@all -@admin -flushall -swapdb db=<databases>"). For tenants that need less.
    acl = optional(string)
  }))
  default = {}
  validation {
    condition     = alltrue([for name in keys(var.redis_tenants) : can(regex("^[a-z][a-z0-9-]{0,40}$", name)) && !contains(["default", "console", "argocd"], name)])
    error_message = "Tenant names: lower case letters, digits and -, starting with a letter, at most 41 characters; \"default\" (admin), \"console\" (RedisInsight) and \"argocd\" (argocd.tf) are reserved."
  }
  validation {
    condition     = alltrue([for t in values(var.redis_tenants) : (length(t.databases) > 0 || t.acl != null) && alltrue([for d in t.databases : d >= 0 && d <= 31 && floor(d) == d])])
    error_message = "Each tenant needs at least one database number (or its own acl), each an integer from 0 to 31 (databases 32 in deploy/minikube/redis/values.yaml)."
  }
  validation {
    # An own acl may only narrow: no admin commands, no flush, no "everything".
    condition     = alltrue([for t in values(var.redis_tenants) : t.acl == null || !can(regex("(^|\\s)(\\+@all|\\+@admin|allcommands|\\+flushall|\\+swapdb|\\+acl\\|setuser|\\+config)(\\s|$)", t.acl))])
    error_message = "A tenant acl may not grant +@all, +@admin, allcommands, FLUSHALL, SWAPDB, ACL SETUSER or CONFIG."
  }
  # (the two existing validations, "A database number belongs to one tenant only" and "Database 7 is Argo CD's",
  #  stay as they are; they work unchanged with empty lists)
}
```

### `minikube-infrastructure/redis.tf`

```hcl
  # Every ACL user: var.redis_tenants plus Argo CD (argocd.tf). Same attributes on both sides, so the merge stays a map.
  redis_tenants = merge(var.redis_tenants, { argocd = merge(local.argocd_redis, { acl = null }) })

  redis_tenant_acl = { for name, t in local.redis_tenants : name =>
    t.acl != null ? t.acl : "~* &* +@all -@admin -flushall -swapdb db=${join(",", t.databases)}"
  }
```

and in `resource "kubernetes_secret_v1" "redis_app"`, `data`:

```hcl
    db        = length(each.value.databases) > 0 ? tostring(each.value.databases[0]) : ""
    databases = join(",", each.value.databases)
    uri       = "redis://${each.key}:${random_password.redis[each.key].result}@${local.redis_host}:6379${length(each.value.databases) > 0 ? "/${each.value.databases[0]}" : ""}"
```

### `minikube-infrastructure/vars/mk4.tfvars`, `redis_tenants`

```hcl
  # jithendar.com cache bus: PUBLISH/SUBSCRIBE on jithendar:* only, no keys, no database (CACHE_BUS_REDIS_URL).
  site-cachebus = {
    namespace = "jithendar"
    acl       = "resetkeys resetchannels &jithendar:* -@all +publish +subscribe +unsubscribe +psubscribe +punsubscribe +ping +client|setname +acl|whoami"
  }
```

Why each part of the rule:

| Part | Why |
|---|---|
| `resetkeys` (and no `~pattern`) | No key access at all: GET, SET, KEYS, SCAN are refused |
| `resetchannels &jithendar:*` | Only channels starting with `jithendar:`; PUBLISH or SUBSCRIBE elsewhere is refused |
| `-@all` first, then `+…` | Rules apply left to right; `-@all` after the `+` rules (as first drafted) would remove them again |
| `+publish +subscribe +unsubscribe` | The bus itself. `+psubscribe +punsubscribe` are allowed but unused |
| `+ping` | The bus PINGs both connections every 5 minutes (see section 3) |
| `+client\|setname` | ioredis names each connection `jithendar-com:cachebus:<role>:<pod>`, visible in `CLIENT LIST` |
| `+acl\|whoami` | Only for the check in section 2 |
| no `+info`, no `+client\|setinfo`, no `+select` | The site turns off ioredis's INFO ready check and client-info, and the uri has no database number |
| no `db=` | The user runs no keyed command; PUBLISH/SUBSCRIBE are not per database |

The password is the same `random_password` (32 characters, letters and digits) as every tenant's; the server only
holds its SHA-256 (`user site-cachebus on #<sha256> …` in `valkey.conf`).

Nothing else in the miniKube repo changes: namespace `jithendar` is already a Valkey client namespace (tenant
`practice`), so the `redis` AuthorizationPolicy and ingress NetworkPolicy already admit it. Adding the user rolls the
StatefulSet (the `checksum/acl` annotation), with the usual roughly one-second write pause per primary handover.

Run the repository's own checks there before applying: `terraform fmt`, `terraform validate`, `terraform test`
(`tests/releases.tftest.hcl`), then `terraform plan` and look for: one new `random_password.redis["site-cachebus"]`,
one new `kubernetes_secret_v1.redis_app["site-cachebus"]` in namespace `jithendar`, `helm_release.redis` updated
(new ACL line and checksum), no other change.

### The Secret it writes

`jithendar/redis-site-cachebus-credentials`, keys `host`, `port`, `username` (`site-cachebus`), `password`, `db` (empty),
`databases` (empty) and **`uri`**:

```
redis://site-cachebus:<password>@valkey-master.redis.svc.cluster.local:6379
```

The site reads only `uri`, through an explicit `env` entry (`minikube/30-jithendar-com.yaml`), never `envFrom`, so no
other variable of the pod sees it. It is not in `jithendar-com-env`.

## 2. Checks after the apply

From a Valkey pod (the admin password is in `redis/valkey-users`, key `default`; the tenant password in the new
Secret). Expected answers on the right.

```bash
PW=$(kubectl -n jithendar get secret redis-site-cachebus-credentials -o jsonpath='{.data.password}' | base64 -d)
v() { kubectl -n redis exec -i valkey-0 -c valkey -- valkey-cli --no-auth-warning --user site-cachebus --pass "$PW" -h valkey-master -p 6379 "$@"; }

v ACL WHOAMI                          # site-cachebus
v PUBLISH jithendar:invalidate x      # (integer) 0..n   (n = site pods subscribed)
v PUBLISH other:channel x             # NOPERM No permissions to access a channel
v SET foo 1                           # NOPERM ... no permissions to run the 'set' command
v GET foo                             # NOPERM ... 'get'
v SELECT 1                            # NOPERM ... 'select'
v INFO                                # NOPERM ... 'info'
v FLUSHALL                            # NOPERM ... 'flushall'
```

`PUBLISH jithendar:invalidate x` is harmless: the site ignores a message that is not JSON with a known `kind`.

Checked locally on 2026-11-10 against **Redis 8.10.2** (`redis-server` with the same ACL line, not Valkey 9.1):
every row above gave the expected answer. Valkey 9 is protocol-compatible and its ACL grammar is a superset, but run
the check on `mk4` before relying on it.

HAProxy idle timeout: confirmed on 2026-11-10 that pod `valkey-0`'s HAProxy config has `timeout tunnel 1h` (the
post-renderer in `deploy/minikube/redis/postrender-haproxy.sh`), so idle subscribers are not cut every 30 s.

After the site is deployed (section 4):

```bash
kubectl -n redis exec valkey-0 -c valkey -- sh -c 'valkey-cli --no-auth-warning -a "$VALKEY_PASSWORD" CLIENT LIST' \
  | grep user=site-cachebus     # 2 per site pod: jithendar-com:cachebus:publisher:<pod> and :subscriber:<pod>
kubectl -n redis exec valkey-0 -c valkey -- sh -c 'valkey-cli --no-auth-warning -a "$VALKEY_PASSWORD" PUBSUB NUMSUB jithendar:invalidate'
```

(Use the admin password from `redis/valkey-users` if `$VALKEY_PASSWORD` is not set in the container.) Admin → System
status shows **Cache bus (Valkey pub/sub): cache bus: connected**.

## 3. How the site uses it

`src/lib/cache-bus.ts`:

- Two connections per pod, made in the background at start (never while serving a request): a **publisher** and a
  **subscriber** (a subscribing connection cannot publish). ioredis options: `connectionName`,
  `enableOfflineQueue: false`, `maxRetriesPerRequest: 1`, `connectTimeout`/`commandTimeout` 2 s, no INFO ready check,
  reconnect with exponential backoff and jitter (250 ms → 30 s), forever.
- The subscriber subscribes again on every reconnect (on each `ready`), so a Valkey failover or an HAProxy cut only
  loses the messages sent while it was down. Those caches converge within their TTL, as without the bus.
- `broadcastInvalidate(kind)` clears the local caches synchronously, then publishes in the background. A publish
  waits for the connection only right after start (at most 1.5 s, shared by all publishes in that window); a
  connection that dropped later fails the publish at once.
- Messages from the pod's own origin, unknown kinds and malformed messages are ignored.
- Every 5 minutes it PINGs both connections. HAProxy (`timeout tunnel 1h`) and Envoy (1 h TCP idle timeout) would
  otherwise close a connection that saw no traffic for an hour, which is a quiet night.
- Warnings are logged at most once a minute per role (`event` `cache_bus_publisher` / `cache_bus_subscriber`).

If `CACHE_BUS_REDIS_URL` is unset but `REDIS_URL` is set (not the production setup), the bus uses `REDIS_URL`, as it
did before.

## 4. Deploy order

1. miniKube repo: the Terraform above, `terraform apply`. The Secret `jithendar/redis-site-cachebus-credentials` appears.
2. This repo: `KUBE_CONTEXT=mk4 ./deploy.sh` (env entry and NetworkPolicy `jithendar-com-cache-bus`).
3. Section 2's checks, then Admin → System status.

The other order works too: the env entry is `optional: true`, so pods start without the Secret and run TTL-only. A
Secret created later is read only at pod start: `kubectl -n jithendar rollout restart deployment/jithendar-com`.

**Network:** egress from the site pods to namespace `redis`, Valkey pods, **pod port 6380** (HAProxy). The Service
`valkey-master` listens on 6379 but a NetworkPolicy sees the pod port after Service translation.

## 5. Cost on Valkey

- **Connections:** 2 per site pod, 4 with 2 replicas (6 during a rolling update with `maxSurge: 1`). Valkey had 21
  clients on the primary on 2026-11-10 (`redis_connected_clients`), `maxclients` default 10 000.
- **Memory:** no keys. Measured locally (Redis 8.10.2, two bus instances, 50 invalidations): `CLIENT LIST` shows
  `tot-mem` 2,304 bytes per publisher and 2,360 per subscriber, and `used_memory` grew by 13,440 bytes for the four
  connections. Against 512 MB `maxmemory` (19 MB used on `mk4` on 2026-11-10) that is negligible; Valkey 9 should be
  in the same range but was not measured.
- **Traffic:** one PUBLISH of about 70 bytes per invalidation (an editor saving a post), fanned out to each
  subscriber; plus 4 PINGs every 5 minutes.

## 6. Monitoring

Site metrics (`/metrics` on 9464, job `jithendar-com`): `cache_bus_published_total{kind}`,
`cache_bus_received_total{kind}`, `cache_bus_errors_total{role}`, `cache_bus_connected{role}` (only present when the
bus is configured). Alert `CacheBusDisconnected` (warning): no pod has a connected subscriber for 15 minutes
(`docs/cache-bus/prometheus-alerts.yml`, handed off through `docs/seo/alerts-for-minikube-repo.yaml`). Grafana:
*Jithendar.com · Overview*, row **Cache bus & shared Valkey**. Full list and how to read them:
`docs/OBSERVABILITY.md`, "Cache bus and shared Valkey".

### Per-ACL-user connections (optional exporter change, miniKube repo; not applied)

`redis_exporter` 1.95.0 on the Valkey pods exports totals only (`redis_connected_clients`). Per-user counts need its
client list export, which adds one series per connection (about 30 today):

1. Check whether the chart can pass exporter environment variables:
   `helm show values oci://registry-1.docker.io/cloudpirates/valkey --version 0.25.16 | sed -n '/^metrics:/,/^[a-z]/p'`.
2. If it can (for example `metrics.extraEnv`), add to `deploy/minikube/redis/values.yaml`:

   ```yaml
   metrics:
     extraEnv:
       - name: REDIS_EXPORTER_EXPORT_CLIENT_LIST
         value: "true"
   ```

   If it cannot, add the same variable to the `metrics` container in `postrender-haproxy.sh`, the way that script
   already patches HAProxy.
3. After the apply, confirm the label set before building panels on it:
   `count by (user) (redis_connected_client_info{job="redis"})`. If `user` is not among the labels in this exporter
   version, keep using `CLIENT LIST` (section 2).

## Troubleshooting

| Symptom | Look at |
|---|---|
| System status: "not configured" | `kubectl -n jithendar get secret redis-site-cachebus-credentials`; if it exists, restart the Deployment (env is read at start) |
| "disconnected", logs `cache bus subscriber error … ECONNRESET` / timeouts | NetworkPolicy `jithendar-com-cache-bus` (port **6380**); `kubectl -n redis get pods`; the `istio-proxy` log of a Valkey pod for an RBAC denial |
| `NOPERM` in the logs | The ACL line (section 1): a command the client sends is not allowed |
| `WRONGPASS` | The Secret is older than the current password: re-apply Terraform, restart the Deployment |
| Connections reconnect every hour | The 5-minute PING is not getting through; check `cache_bus_errors_total` |

## Rollback

Either is enough, and both leave the site on TTL-only caches, exactly as before this change:

- Remove the env entry `CACHE_BUS_REDIS_URL` from `minikube/30-jithendar-com.yaml` and deploy, or
- delete the Secret (`kubectl -n jithendar delete secret redis-site-cachebus-credentials`, or remove the tenant from
  `redis_tenants` and apply) and `kubectl -n jithendar rollout restart deployment/jithendar-com`.

The NetworkPolicy `jithendar-com-cache-bus` can stay or go; it only allows egress.
