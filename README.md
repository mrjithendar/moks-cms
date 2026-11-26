# moks-cms

A CMS for MDX publications, built with Next.js, MDX, PostgreSQL, Cloudflare R2 and Kubernetes, with its SEO agent. This
repository holds the software only. It tests the code, builds the one image (the web app and the SEO agent) and pushes
it to the registry. It deploys nothing.

The image serves any site. It reads the site's `site.json`, `config/`, articles and images at run time. Each website
lives in its own repository and deploys the CMS image with its own manifests. [jithendar.com](https://jithendar.com),
the first site, is [`moks-tech/jithendar.com`](https://github.com/moks-tech/jithendar.com). It lived here as
`sites/jithendar.com/` until 2026-11-16, and this repository was itself called `jithendar.com` until 2026-11-14.

The SEO agent (Python: CrewAI Flows and Crews, MCP servers, pgvector, Ask the Blog, report PDFs) is
[`seo-agent/`](seo-agent/README.md), with its own `pyproject.toml`, tests and scripts. It was `services/seo-agent/` here
until 2026-11-18, then its own repository (mrjithendar/moks-seo-agent) until 2026-11-26, when it came back with its
history (D-105). Its design docs are in [docs/seo/](docs/seo/) (start with [FLOWS.md](docs/seo/FLOWS.md) and
[MCP.md](docs/seo/MCP.md)). The image is the same for both: a site's pod runs it as two containers, the site
(`node server.js`) and the agent (`python -m app.main` in `/srv`).

| Path | Contents |
|---|---|
| `src/`, `tests/`, `e2e/`, `public/` | The Next.js app: source, unit and end-to-end tests, the test fixture site (`tests/fixtures/site`) |
| [`seo-agent/`](seo-agent/README.md) | The SEO agent (Python, uv): `app/`, `tests/` (pytest, including contract tests against this app), `scripts/` |
| [`docs/`](docs/) | Design and operations docs (content model, media, SEO, news desk, cache bus) |
| `Dockerfile` | The one image, for CI and local builds: the web app's standalone build and the SEO agent (virtualenv and ONNX models) on Debian |
| [`sites/`](sites/README.md) | The template for a new site's repository (`_template/`) |
| `scripts/` | The app's scripts (`use-site.mjs`, seeds, `push-post.ts`) and CI's: `smoke-site-image.sh`, `smoke-seo-agent-image.sh`, `image-size.sh`, `build-alerts.py` |
| `.github/workflows/` | CI: checks pull requests; when one is merged, tests and pushes the image to Harbor (`registry.jithendar.com/jithendar`) |

Standing rules for agents: [AGENTS.md](AGENTS.md). Content guide: [docs/CONTENT_MODEL.md](docs/CONTENT_MODEL.md).

## Local development

The app serves one site: a folder with `site.json`, `config/`, `content/` and `public/images/`. `npm run site` links or
copies those into `site/`, `content/` and `public/images/` here, and every command below runs it first. It picks the
folder from `SITE_DIR` (any path, such as a site's own repository checked out next to this one). If that isn't set it
uses `SITE` (a folder of [`sites/`](sites/README.md)), and otherwise the test fixture site `tests/fixtures/site`. See
[`scripts/use-site.mjs`](scripts/use-site.mjs).

Requires Node ≥ 24 (`.nvmrc`). On this Mac, Node 26 is at `/opt/homebrew/bin/node`, but `/usr/local/bin/node` (v20) comes first in `PATH`.

```bash
export PATH=/opt/homebrew/bin:$PATH
npm install
npm run dev          # http://localhost:3000 (SITE_DIR=../jithendar.com npm run dev for a real site)
npm run preview      # same, but also shows items in status: review
npm run lint
npm run typecheck
npm test
npm run build        # standalone output in .next/standalone
npm run site -- --copy   # real copies instead of links: before docker build
```

| Variable | Purpose |
|---|---|
| `APP_ENV` | `production` allows indexing. Any other value makes every page `noindex`. Set it at **build** time (meta tag) and at **run** time (`X-Robots-Tag`, `robots.txt`). |
| `SITE_DIR` | The site folder `npm run site` links or copies from: a site repository's checkout. |
| `SITE_CONFIG_DIR` | Where the running app reads `site.json` and `config/` (default `site/`; `/app/site` in the image). Read at server start, never compiled in (`src/config/site-files.ts`). |
| `SITE` | Without `SITE_DIR`: which folder of `sites/` to build. Neither set: `tests/fixtures/site`. |
| `SITE_URL` | Canonical origin, default `https://` + the site's `host`. |
| `CONTENT_DIR` | Optional content root; tests use `tests/fixtures/content`. |

To run the standalone build locally:

```bash
cp -R .next/static .next/standalone/.next/static
cd .next/standalone && APP_ENV=production PORT=3000 node server.js
```

ISR writes to `.next/cache` at runtime. Phase 6 must mount that path as writable.

## Images

Merge a pull request into `master`. CI (`.github/workflows/ci-moks-cms.yml`) pushes
`registry.jithendar.com/jithendar/moks-cms` as `:pr-<number>` and `:latest` (`Dockerfile`), after smoke tests of the
image as the site and as the SEO agent. The image holds no site of its own beyond the test fixture's files as
defaults. A site's Deployment mounts its own `site/` (site.json, config/), `content/` and `public/images/` over
`/app/site`, `/app/content` and `/app/public/images`. The app reads them at run time, so a site never builds the CMS.
The same image runs the SEO agent (a second container: workingDir `/srv`, command `python -m app.main`); there is no
separate `seo-agent` image any more.

Lint and the tests run on the pull request. A release skips them only if the pull request's last commit passed them
there. Otherwise they run again on the merge commit while the image builds, and nothing is pushed until they pass. A
commit pushed straight to `master` builds nothing (no `push` triggers).

CI only pushes the image. It doesn't tell any site about it: each site decides when to pull and restart.

The seo-agent's contract tests read files here: the migrations, `src/lib/seo-agent/internal-server.ts` and the
constants both sides keep equal. No CI job runs them across the two repositories (no cross-repository credentials, by
choice). Before merging a change to one of those files, run the agent's tests with this checkout next to it
(`cd ../moks-seo-agent && uv run pytest -q`).

## A new site

1. Create a repository from [`sites/_template/`](sites/README.md): `site.json`, `config/`, `content/`, `public/images/`.
2. Ship those files in a content image whose init container copies them into the pod, and run
   `registry.jithendar.com/jithendar/moks-cms:pr-<number>` next to it.
3. Deploy it the way `moks-tech/jithendar.com` does (its `kubernetes/`, workflows and `README.md`).

## License

Copyright (c) 2026 Jithendar Dharmapuri. All rights reserved. This is proprietary software; no use, copying, modification or distribution is permitted without written permission. See [LICENSE](LICENSE).
