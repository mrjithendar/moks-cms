# syntax=docker/dockerfile:1
# The moks-cms image, the only one this repository builds (D-105): the web app AND the SEO agent (seo-agent/), one
# Dockerfile for CI (ci-moks-cms.yml builds, smoke-tests and pushes it) and local builds alike. Built for linux/arm64
# (mk4 nodes) or the machine's own platform. Run from the repository root, after `npm run site -- --copy`.
#
# One image, one Deployment: each site pod runs it as two containers (jithendar.com kubernetes/30-jithendar-com.yaml):
#   container web        (default)  node server.js                    the site, port 3000
#   container seo-agent  /srv       python -m app.main                the SEO agent, ports 8080 (internal API), 8090 (MCP)
#   CronJob dispatcher   /srv       python -m app.trigger dispatch    starts the scheduled flows
# Two containers, not one process tree, so each keeps its own environment (OTEL_SERVICE_NAME, LOG_LEVEL… differ),
# memory limit (a crew run that runs out of memory restarts the agent, not the site) and probes. With KEDA there is one
# agent per site pod; app/runs.py makes several agents safe (D-105).
#
# Debian everywhere: the runtime is python:3.13-slim-trixie with Node's binary from node:26-trixie-slim (the same Debian
# release). The agent's wheels (ONNX Runtime, LightGBM, scikit-learn) need glibc, and so does sharp's native module, so
# the web stages are Debian too (not Alpine).
ARG PYTHON_VERSION=3.13

# --- The web app -------------------------------------------------------------------------------------------------------
FROM node:26-trixie-slim AS web-deps
WORKDIR /app
COPY package.json package-lock.json ./
# npm download cache persists between builds on the runner (BuildKit cache mount).
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund --prefer-offline

FROM node:26-trixie-slim AS web-build
WORKDIR /app
# APP_ENV is baked into the meta robots tag at build time; production is the only indexable value.
ARG APP_ENV=production
ENV APP_ENV=$APP_ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=web-deps /app/node_modules ./node_modules
COPY . .
# The site comes from the repository's sites/<domain>/, outside this build context: run `npm run site -- --copy`
# (SITE=<domain> for another site) before `docker build`, so site/, content/ and public/images/ are real copies.
RUN test -f site/site.json && test -d content && test ! -L content && test -d public/images && test ! -L public/images \
  || { echo 'Run `npm run site -- --copy` before docker build' >&2; exit 1; }
# Next.js build cache persists between builds (incremental compilation). `next build` itself, not `npm run build`: its
# prebuild script (scripts/use-site.mjs) would choose tests/fixtures/site, which is not in the build context
# (.dockerignore), and fail; the copies checked above are what the build uses.
RUN --mount=type=cache,target=/app/.next/cache ./node_modules/.bin/next build

# --- The SEO agent's virtualenv and models (docs/seo/FLOWS.md, MCP.md) ---------------------------------------------
# CPU-only: no torch, no CUDA; ONNX Runtime runs the embeddings; ReportLab (pure Python) renders the report PDFs. The
# embeddings model (BAAI/bge-small-en-v1.5, ONNX export, MIT) is baked in at a pinned revision and verified by sha256,
# so pods never download anything at start-up and the image is reproducible. So is the reranker's model
# (seo-agent/app/reranker.py, off until RAG_RERANKER_ENABLED). PyTorch is never installed: it is the `train`
# dependency group, for seo-agent/scripts/reranker_model.py outside the service, and `uv sync --no-dev` installs no group.
FROM python:${PYTHON_VERSION}-slim-trixie AS agent-build
WORKDIR /srv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never PIP_DISABLE_PIP_VERSION_CHECK=1
RUN pip install --no-cache-dir "uv==0.13.5"
COPY seo-agent/pyproject.toml seo-agent/uv.lock ./
# Exactly the locked versions, production dependencies only.
RUN uv sync --frozen --no-dev --no-install-project
# chromadb 1.5.9 (crewai pins ~=1.5.9 and imports it at load; no fixed release exists) ships a Chroma server whose
# advisories (GHSA-f4j7-r4q5-qw2c, GHSA-2wm9-hf6c-p5cr, GHSA-xph7-9rjv-w5fr, GHSA-36p7-vc44-83pf: code injection
# through the collections API, missing tenant checks, SimpleRBAC) all need that server running. This service only
# imports chromadb's client-side types, so the server is removed from the image: the Rust bindings (the `chroma run`
# server, 50 MB), the Python server, CLI and app, the basic-auth and RBAC providers, and the `chroma` command.
# docs/seo/DECISIONS.md D-53; seo-agent/tests/test_chromadb_surface.py fails if the service ever imports any of them.
RUN sp="$(echo /srv/.venv/lib/python3.*/site-packages)" \
 && rm -rf "$sp/chromadb_rust_bindings" "$sp/chromadb/server" "$sp/chromadb/cli" "$sp/chromadb/app.py" \
           "$sp/chromadb/auth/basic_authn" "$sp/chromadb/auth/simple_rbac_authz" /srv/.venv/bin/chroma \
 && CREWAI_TRACING_ENABLED=false /srv/.venv/bin/python -c "import crewai, chromadb.config" \
 && ! /srv/.venv/bin/python -c "import chromadb.server" 2>/dev/null

ARG MODEL_REPO=BAAI/bge-small-en-v1.5
ARG MODEL_REV=5c38ec7c405ec4b44b94cc5a9bb96e735b38267a
ARG MODEL_SHA256=828e1496d7fabb79cfa4dcd84fa38625c0d3d21da474a00f08db0f559940cf35
ARG TOKENIZER_SHA256=d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66
RUN mkdir -p /models/bge-small-en-v1.5 \
 && python -c "import urllib.request as u; u.urlretrieve('https://huggingface.co/${MODEL_REPO}/resolve/${MODEL_REV}/onnx/model.onnx', '/models/bge-small-en-v1.5/model.onnx'); u.urlretrieve('https://huggingface.co/${MODEL_REPO}/resolve/${MODEL_REV}/tokenizer.json', '/models/bge-small-en-v1.5/tokenizer.json')" \
 && echo "${MODEL_SHA256}  /models/bge-small-en-v1.5/model.onnx" | sha256sum -c - \
 && echo "${TOKENIZER_SHA256}  /models/bge-small-en-v1.5/tokenizer.json" | sha256sum -c -

# The reranker: cross-encoder/ms-marco-MiniLM-L6-v2 (Apache-2.0) at a pinned revision, the int8 ONNX export the model
# repository publishes (23 MB, 18 MB compressed). Its fp32 export would add 83 MB compressed, more than the image-size
# gate allows (D-68), for the same Recall@3 on the eval set (MRR 0.907 vs 0.899, seo-agent/app/reranker.py). Its
# tokenizer.json is bge-small's byte for byte (the same BERT vocabulary), checked against the same sha256.
ARG RERANKER_REPO=cross-encoder/ms-marco-MiniLM-L6-v2
ARG RERANKER_REV=233902d25c440f23af6f7d6e94d2946bac0bee0a
ARG RERANKER_FILE=onnx/model_qint8_arm64.onnx
ARG RERANKER_SHA256=3573b6b9593cb2f75987a31815d409ca3dd8808629118fd20451bb1a5d90cec7
RUN mkdir -p /models/ms-marco-MiniLM-L6-v2 \
 && python -c "import urllib.request as u; u.urlretrieve('https://huggingface.co/${RERANKER_REPO}/resolve/${RERANKER_REV}/${RERANKER_FILE}', '/models/ms-marco-MiniLM-L6-v2/model.onnx'); u.urlretrieve('https://huggingface.co/${RERANKER_REPO}/resolve/${RERANKER_REV}/tokenizer.json', '/models/ms-marco-MiniLM-L6-v2/tokenizer.json')" \
 && echo "${RERANKER_SHA256}  /models/ms-marco-MiniLM-L6-v2/model.onnx" | sha256sum -c - \
 && echo "${TOKENIZER_SHA256}  /models/ms-marco-MiniLM-L6-v2/tokenizer.json" | sha256sum -c -

# --- Node's binary only (no npm/npx at run time) ---------------------------------------------------------------------
FROM node:26-trixie-slim AS node

# --- The image ---------------------------------------------------------------------------------------------------------
FROM python:${PYTHON_VERSION}-slim-trixie AS runtime
# libgomp1: OpenMP, which the LightGBM wheel links against (news desk ranker, docs/news/ML.md); scikit-learn/SciPy
# wheels bundle their own. libstdc++6: Node and ONNX Runtime (already in the base image, which apt needs; named so it
# stays). User node (1000) as in the node images, for the site; the agent's container runs as 10001, no entry.
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 libstdc++6 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 1000 node && useradd --uid 1000 --gid node --shell /bin/bash --create-home node
COPY --from=node /usr/local/bin/node /usr/local/bin/node
# The agent: /srv (run with workingDir /srv)
COPY --from=agent-build /srv/.venv /srv/.venv
COPY --from=agent-build /models /models
COPY seo-agent/app /srv/app
# The site: /app. Standalone output already contains server.js, traced node_modules and content/ (CI builds with the test
# fixture site's, as defaults; a site's Deployment mounts its own site/, content/ and public/images/ over them).
WORKDIR /app
COPY --from=web-build --chown=1000:1000 /app/.next/standalone ./
COPY --from=web-build --chown=1000:1000 /app/.next/static ./.next/static
COPY --from=web-build --chown=1000:1000 /app/public ./public
# Reported by /api/health (site) and /healthz (agent) so CI can confirm which build is live.
ARG GIT_SHA=dev
# The site: APP_ENV=production: this is the release image, so the production rules (secure cookies, required secrets,
# the agent's 32-character tokens) apply even if a Deployment's own APP_ENV is ever lost. Set APP_ENV to something
# else to run it as a non-production site (the smoke tests do). No PORT: the agent reads PORT for its internal API
# (8080), and Next's standalone server listens on 3000 when PORT is unset.
# The agent: its virtualenv first on PATH (`python` is the venv's), writable state under /tmp (the pod mounts an emptyDir
# there for each container; root is read-only), thread limits (without them OpenMP/OpenBLAS and the tokenizers start one thread
# per core of the node, not of the container), no CrewAI telemetry.
ENV NODE_ENV=production APP_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 GIT_SHA=$GIT_SHA \
    PATH=/srv/.venv/bin:$PATH PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    HOME=/tmp XDG_DATA_HOME=/tmp XDG_CACHE_HOME=/tmp \
    EMBEDDINGS_MODEL_DIR=/models/bge-small-en-v1.5 RAG_RERANKER_DIR=/models/ms-marco-MiniLM-L6-v2 \
    TOKENIZERS_PARALLELISM=false RAYON_NUM_THREADS=1 OMP_NUM_THREADS=2 MALLOC_ARENA_MAX=2 \
    CREWAI_DISABLE_TELEMETRY=true CREWAI_DISABLE_TRACKING=true CREWAI_TRACING_ENABLED=false CREWAI_DISABLE_VERSION_CHECK=true \
    CREWAI_STORAGE_DIR=/tmp/crewai
USER 1000:1000
# 3000 the site · 8080 the agent's internal API (the site, the dispatcher CronJob, Prometheus) · 8090 its MCP edge (Kong)
EXPOSE 3000 8080 8090
CMD ["node", "server.js"]
