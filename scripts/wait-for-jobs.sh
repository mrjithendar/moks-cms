#!/usr/bin/env bash
# Wait for other jobs of this workflow run to finish, and succeed only if every one of them passed. A release job calls
# it right before it pushes, so the image is built while the checks run instead of after them.
#
#   GH_TOKEN=… scripts/wait-for-jobs.sh <count> <name pattern>...
#
# <count>: how many jobs the patterns must match (e.g. 1 check + 4 test shards = 5), so a job the API does not list yet
# is waited for. Patterns are shell globs on the job name ('check', 'test (*'). Needs `actions: read`.
# Fails at once when a matched job ends in anything but success (failure, cancelled, skipped), and after
# WAIT_TIMEOUT_SECONDS (default 1500) without an answer.
set -uo pipefail
COUNT="${1:?usage: $0 <count> <name pattern>...}"
shift
(($#)) || { echo "usage: $0 <count> <name pattern>..." >&2; exit 2; }
RUN="${GITHUB_RUN_ID:?GITHUB_RUN_ID is not set}"
deadline=$((SECONDS + ${WAIT_TIMEOUT_SECONDS:-1500}))
last=""

while :; do
  if listing="$(gh api --paginate "repos/$GITHUB_REPOSITORY/actions/runs/$RUN/jobs?filter=latest&per_page=100" --jq '.jobs[] | [.name, .status, (.conclusion // "")] | @tsv')"; then
    matched=0 finished=0 failed=""
    while IFS=$'\t' read -r name status conclusion; do
      [[ -n "$name" ]] || continue
      hit=false
      for pattern in "$@"; do
        # shellcheck disable=SC2053 # the pattern is a glob on purpose
        if [[ "$name" == $pattern ]]; then hit=true; break; fi
      done
      $hit || continue
      matched=$((matched + 1))
      [[ "$status" == completed ]] || continue
      finished=$((finished + 1))
      [[ "$conclusion" == success ]] || failed="${failed:+$failed, }$name: $conclusion"
    done <<<"$listing"
    if [[ -n "$failed" ]]; then
      echo "::error::Not pushing: $failed."
      exit 1
    fi
    if ((matched >= COUNT && finished == matched)); then
      echo "All $matched jobs passed."
      exit 0
    fi
    now="$finished of $COUNT finished"
    [[ "$now" == "$last" ]] || echo "Waiting: $now."
    last="$now"
  else
    echo "::warning::Could not list this run's jobs; trying again."
  fi
  if ((SECONDS >= deadline)); then
    echo "::error::Gave up after ${WAIT_TIMEOUT_SECONDS:-1500} s waiting for: $*."
    exit 1
  fi
  sleep 10
done
