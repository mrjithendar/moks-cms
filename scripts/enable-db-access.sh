#!/usr/bin/env bash
# One-time, from the owner's Mac: the privileged steps behind database access through the ingress
# (Adminer at https://jithendar.com/db/, PostgreSQL at db.jithendar.com:443; see minikube/DB_ACCESS.md).
# Everything else (the minikube/db-access-*.yaml objects, the DNS record) is deployed by .github/workflows/deploy-minikube.yml.
#
#   HOST_SSH=root@jithendar.com scripts/enable-db-access.sh    # also runs the HAProxy step on the host over SSH
#   scripts/enable-db-access.sh                                 # prints the host command instead and waits
#
# Steps, each skipped when already done, each checked before the next:
#   1. Check: the Istio gateway reads the PROXY protocol (miniKube's Terraform, istio.tf: release istio-edge).
#   2. The host's HAProxy sends it to the gateway (miniKube deploy/minikube/expose-ingress.sh, on the host).
#   3. Check: the site now logs this Mac's real IP, not a node's.
#   4. The PostgreSQL login jithendar_remote (scripts/create-db-remote-user.sh, prints the password once).
#   5. CI's applier Role gets the db-access kinds (minikube/85-ci-applier.yaml; CI cannot change its own Role).
#   6. Run the deploy workflow (gh), unless NO_DEPLOY=1.
#
# Needs: kubectl with admin on context mk4, a miniKube checkout (MINIKUBE_DIR, default ../miniKube), gh signed in.
# Undo: minikube/DB_ACCESS.md → Rollback.
set -euo pipefail

CONTEXT="${KUBE_CONTEXT:-mk4}"
REPO="${GITHUB_REPO:-mrjithendar/jithendar.com}"
cd "$(dirname -- "${BASH_SOURCE[0]}")/.."
# The mk4 cluster files moved from mrjithendar/tools to mrjithendar/miniKube (same paths) on 2026-11-08.
MINIKUBE_DIR="${MINIKUBE_DIR:-../miniKube}"
HOST_MINIKUBE_DIR="${HOST_MINIKUBE_DIR:-miniKube}"
VALUES="$MINIKUBE_DIR/deploy/minikube/istio/edge/values.yaml"
k() { kubectl --context "$CONTEXT" "$@"; }
fail() { echo "ERROR: $*" >&2; exit 1; }
site_ok() { [[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://jithendar.com/api/health)" == 200 ]]; }

[[ -f "$VALUES" ]] || fail "$VALUES not found; set MINIKUBE_DIR to your miniKube checkout."
grep -q 'proxyProtocol' "$VALUES" || fail "$VALUES has no proxyProtocol settings; pull the miniKube repo."
# Addresses the site sees when the real one is lost: a minikube node (no PROXY header) or a pod (Traefik's hand-off).
internal_ip() { [[ -z "$1" || "$1" == 192.168.49.* || "$1" == 10.* ]]; }

echo "→ 1. The Istio gateway reads the PROXY protocol"
# The gateway's edge is a Terraform release (miniKube minikube-infrastructure/istio.tf), so this step only checks.
if k -n istio-ingress get envoyfilter proxy-protocol -o name >/dev/null 2>&1 && k -n istio-ingress get gateway public -o name >/dev/null 2>&1; then
  echo "   already enabled"
else
  fail "The Istio gateway's edge (Gateway public, EnvoyFilter proxy-protocol) is missing. Apply it with Terraform, then rerun:
  terraform -chdir=$MINIKUBE_DIR/minikube-infrastructure apply -var-file=vars/mk4.tfvars"
fi
site_ok || fail "https://jithendar.com/api/health is not 200 after the gateway step."

echo "→ 2 + 3. HAProxy on the host sends client IPs"
probe="db-access-probe-$RANDOM$RANDOM"
seen_ip() {
  curl -s -o /dev/null --max-time 10 -A "$probe" https://jithendar.com/robots.txt || true
  sleep 3
  k -n jithendar logs -l app=jithendar-com --since=2m --max-log-requests=4 2>/dev/null \
    | grep -F "\"userAgent\":\"$probe\"" | grep -o '"ip":"[^"]*"' | tail -1 | cut -d'"' -f4
}
ip="$(seen_ip)"
if internal_ip "$ip"; then
  # The host pulls miniKube from GitHub, so the HAProxy change must be pushed, not only committed here.
  git -C "$MINIKUBE_DIR" fetch -q origin master
  git -C "$MINIKUBE_DIR" show origin/master:deploy/minikube/expose-ingress.sh | grep -q ':31443 send-proxy-v2' \
    || fail "miniKube on GitHub (origin/master) does not forward to the gateway (:31443 send-proxy-v2) in deploy/minikube/expose-ingress.sh: commit and push miniKube first."
  host_cmd="cd $HOST_MINIKUBE_DIR && git pull --ff-only && grep -q ':31443 send-proxy-v2' deploy/minikube/expose-ingress.sh && bash deploy/minikube/expose-ingress.sh"
  if [[ -n "${HOST_SSH:-}" ]]; then
    # shellcheck disable=SC2029  # expanded here on purpose: the command is built from local settings
    ssh "$HOST_SSH" "$host_cmd"
  else
    echo "   On the Hetzner host, run:  $host_cmd"
    read -r -p "   Press Enter when it has finished… " _
  fi
  site_ok || fail "The site is not answering after the HAProxy step. On the host: docker logs roboshop-ingress-edge-\$(id -u); miniKube deploy/minikube/istio/README.md has the way back."
  ip="$(seen_ip)"
fi
! internal_ip "$ip" || fail "The site still sees '${ip:-nothing}' instead of a public IP; check HAProxy on the host."
echo "   the site sees this Mac as $ip"
grep -q -- "- $ip/32" minikube/db-access-10-allowlist.yaml \
  || echo "   NOTE: $ip is not in minikube/db-access-10-allowlist.yaml. Add it to both lists and re-apply the db-access group, or /db stays closed to this Mac."

echo "→ 4. PostgreSQL login"
if k -n jithendar get secret jithendar-db-remote >/dev/null 2>&1; then
  echo "   jithendar_remote exists (rotate with scripts/create-db-remote-user.sh)"
else
  bash scripts/create-db-remote-user.sh
fi

echo "→ 5. CI applier permissions"
k apply -f minikube/85-ci-applier.yaml >/dev/null
echo "   minikube/85-ci-applier.yaml applied"

if [[ "${NO_DEPLOY:-0}" != 1 ]]; then
  echo "→ 6. Deploy workflow"
  gh workflow run deploy-minikube.yml --repo "$REPO" --ref master
  echo "   started; follow it with: gh run watch --repo $REPO"
fi
cat <<OUT

Then, from an allowed IP:
  https://jithendar.com/db/   System PostgreSQL, Server jithendar-postgres, user jithendar_remote, database jithendar
  psql "host=db.jithendar.com port=443 dbname=jithendar user=jithendar_remote sslmode=verify-full sslrootcert=system sslnegotiation=direct"
OUT
