#!/usr/bin/env bash
# Build the moks-cms-builder image, then one site's app image on it, the way a site's repository does
# (services/www/Dockerfile.builder, services/www/Dockerfile.site). CI (ci-moks-cms.yml) builds the test fixture site to
# prove a builder before pushing it. Run from anywhere; needs Docker with BuildKit (the default docker driver, so the
# second build finds the first image locally).
#
#   scripts/build-site-image.sh <builder image> <site image> [<git sha>] [<site folder>]
#   scripts/build-site-image.sh moks-cms-builder:dev site:dev "$(git rev-parse HEAD)" ../jithendar.com
#
# <site folder> defaults to services/www/tests/fixtures/site. Images are linux/arm64 (PLATFORM to change it).
set -euo pipefail
BUILDER="${1:?usage: $0 <builder image> <site image> [<git sha>] [<site folder>]}"
SITE_IMAGE="${2:?usage: $0 <builder image> <site image> [<git sha>] [<site folder>]}"
SHA="${3:-dev}"
root="$(cd "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
SITE_DIR="${4:-$root/services/www/tests/fixtures/site}"
PLATFORM="${PLATFORM:-linux/arm64}"

[[ -f "$SITE_DIR/site.json" ]] || { echo "$SITE_DIR/site.json not found: not a site folder" >&2; exit 1; }
docker build --platform "$PLATFORM" --provenance=false -f "$root/services/www/Dockerfile.builder" \
  --build-arg "GIT_SHA=$SHA" -t "$BUILDER" "$root"
docker build --platform "$PLATFORM" --provenance=false -f "$root/services/www/Dockerfile.site" \
  --build-arg "MOKS_CMS_BUILDER=$BUILDER" --build-arg "GIT_SHA=$SHA" --build-arg "MOKS_CMS_REVISION=$SHA" \
  -t "$SITE_IMAGE" "$SITE_DIR"
