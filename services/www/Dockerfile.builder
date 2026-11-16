# syntax=docker/dockerfile:1
# moks-cms-builder: everything a site needs to build its own moks-cms app image, without this repository's source.
# Pushed by .github/workflows/ci-moks-cms.yml as registry.jithendar.com/jithendar/moks-cms-builder:pr-<number> (and
# :latest) after the tests pass; nothing in this repository deploys it.
#
# It holds services/www with its dependencies installed (npm ci, linux/arm64 like the cluster nodes, glibc for sharp),
# the tests that check a site's content (content.test.ts, links.test.ts), the Python practice catalog builder, and no
# site. A site's repository (site.json, config/, content/, public/images/, e.g. mrjithendar/jithendar.com) builds on it
# with Dockerfile.site: SITE_DIR points scripts/use-site.mjs at the site, and `npm run build` compiles it in.
#
#   docker build --platform linux/arm64 -f services/www/Dockerfile.builder -t moks-cms-builder .   (from the repository root)
#
# What a site can run in it (the site mounted or copied at /site):
#   npm run site -- --copy && npm run build                            build the app for the site (Dockerfile.site)
#   npm run site -- --copy && npx vitest run tests/content.test.ts tests/links.test.ts    check the site's content
#   python3 /moks-cms/services/executor/tools/build_problems.py --check                   check its practice catalog
#   npm run --silent push-post -- /site/content/blog/<slug>.mdx --create-only            send a draft to Admin → Posts
FROM node:26-bookworm-slim
# python3 + PyYAML: services/executor/tools/build_problems.py (the practice catalog). Not in any runtime image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-yaml ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /moks-cms/services/www
COPY services/www/package.json services/www/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund --prefer-offline
COPY services/www/ ./
COPY services/executor/tools/ /moks-cms/services/executor/tools/
COPY services/executor/sandbox/runner.py /moks-cms/services/executor/sandbox/runner.py
# The commit of moks-cms this builder was made from; Dockerfile.site passes it on to the app image.
ARG GIT_SHA=dev
ENV NEXT_TELEMETRY_DISABLED=1 MOKS_CMS_REVISION=$GIT_SHA SITE_DIR=/site
LABEL org.opencontainers.image.revision=$GIT_SHA org.opencontainers.image.title=moks-cms-builder
