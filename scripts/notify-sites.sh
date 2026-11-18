#!/usr/bin/env bash
# Tell the site repositories that a new seo-agent image was pushed: a repository_dispatch "moks-cms-released" with
# client_payload {component: seo-agent, tag, revision}. The event keeps the name moks-cms uses for its own image, so a
# site handles both with one workflow (moks-tech/jithendar.com: apply its manifests, restart that component).
#
#   REPOS="owner/site-a owner/site-b" GH_TOKEN=… scripts/notify-sites.sh <component> <tag> <revision>
#
# REPOS comes from repository variable RELEASE_NOTIFY_REPOS and GH_TOKEN from secret RELEASE_NOTIFY_TOKEN (a
# fine-grained token with Contents: read and write on those repositories, which repository_dispatch needs). Nothing
# set: nothing is sent. A failed dispatch is a warning, never a failed release: the image is pushed, and a site can
# always restart the agent by hand.
set -uo pipefail
COMPONENT="${1:?usage: $0 <component> <tag> <revision>}"
TAG="${2:?usage: $0 <component> <tag> <revision>}"
REVISION="${3:?usage: $0 <component> <tag> <revision>}"
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/stdout}"

if [[ -z "${REPOS:-}" ]]; then
  echo "No site repositories to tell (repository variable RELEASE_NOTIFY_REPOS is empty)."
  exit 0
fi
if [[ -z "${GH_TOKEN:-}" ]]; then
  echo "::warning::RELEASE_NOTIFY_REPOS is set but secret RELEASE_NOTIFY_TOKEN is not: no site was told about $COMPONENT $TAG."
  exit 0
fi
for repo in $REPOS; do
  if gh api --method POST "repos/$repo/dispatches" -f event_type=moks-cms-released \
      -f "client_payload[component]=$COMPONENT" -f "client_payload[tag]=$TAG" -f "client_payload[revision]=$REVISION" >/dev/null; then
    echo "- told $repo: $COMPONENT $TAG" | tee -a "$SUMMARY"
  else
    echo "::warning::Could not send moks-cms-released to $repo ($COMPONENT $TAG); restart it by hand."
  fi
done
exit 0
