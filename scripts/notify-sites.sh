#!/usr/bin/env bash
# Tell the site repositories that a moks-cms image was pushed: a repository_dispatch "moks-cms-released" with
# client_payload {component, tag, revision}. moks-cms knows nothing else about its sites; each site decides what to do
# (mrjithendar/jithendar.com moves its pin in moks-cms.json, builds and deploys).
#
#   REPOS="owner/site-a owner/site-b" GH_TOKEN=… scripts/notify-sites.sh <component> <tag> <revision>
#
# component: builder | seo-agent | practice-executor. REPOS comes from repository variable RELEASE_NOTIFY_REPOS and
# GH_TOKEN from secret RELEASE_NOTIFY_TOKEN (a fine-grained token with Contents: read and write on those repositories,
# which repository_dispatch needs). Nothing set: nothing is sent. A failed dispatch is a warning, never a failed release:
# the image is pushed, and a site can always move its pin by hand.
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
    echo "::warning::Could not send moks-cms-released to $repo ($COMPONENT $TAG); move its pin by hand."
  fi
done
exit 0
