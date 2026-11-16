# moks-cms

A CMS for MDX publications, built with Next.js, MDX, PostgreSQL, Cloudflare R2 and Kubernetes. This repository holds
the software only: it tests the code, builds the CMS image and pushes it to the registry, and deploys nothing. The
image serves any site: it reads the site's `site.json`, `config/`, articles and images at run time. Each website lives
in its own repository, ships those files in its own content image and deploys the CMS image with its own manifests. [jithendar.com](https://jithendar.com),
the first site, is [`moks-tech/jithendar.com`](https://github.com/moks-tech/jithendar.com). It lived here as
`sites/jithendar.com/` until 2026-11-16, and this repository was itself called `jithendar.com` until 2026-11-14.

| Path | Contents |
|---|---|
| [`services/www/`](services/www/README.md) | The Next.js app: source, tests, the test fixture site (`tests/fixtures/site`), Dockerfiles and [docs](services/www/docs/) |
| `services/seo-agent/` | SEO v4 agent service (Python: CrewAI Flows and Crews as the only job engine, MCP servers, pgvector, Ask the Blog, report PDFs); see [FLOWS.md](services/www/docs/seo/FLOWS.md) and [MCP.md](services/www/docs/seo/MCP.md) |
| [`sites/`](sites/README.md) | The template for a new site's repository (`_template/`) |
| `scripts/` | Image checks and release: `smoke-site-image.sh`, `image-size.sh`, `notify-sites.sh`, `check-dashboards.py`, `build-alerts.py` |
| [`runner/`](runner/README.md) | Self-hosted GitHub Actions runners (retired for CI: builds run on GitHub-hosted runners) |
| `.github/workflows/` | CI: checks pull requests; when one is merged, tests and pushes the images to Harbor (`registry.jithendar.com/jithendar`) |

## Images

Merge a pull request into `master`. CI pushes, each as `:pr-<number>` and `:latest`:

| Image | Workflow | What it is |
|---|---|---|
| `moks-cms` | `ci-moks-cms.yml` | The CMS (`services/www/Dockerfile.ci`). It ships the test fixture site's files as defaults, so it starts bare; a site mounts its own over `/app/site`, `/app/content` and `/app/public/images` |
| `seo-agent` | `ci-seo-agent.yml` | The SEO agent service |

Lint and the tests run on the pull request; a release skips them only if the pull request's last commit passed them
there, and runs them itself otherwise. A commit pushed straight to `master` builds nothing (no `push` triggers).

After a push, CI sends a `moks-cms-released` repository_dispatch (`{component, tag, revision}`) to each repository in
variable `RELEASE_NOTIFY_REPOS` (space-separated, secret `RELEASE_NOTIFY_TOKEN`; `scripts/notify-sites.sh`). What a
site does with it is up to the site. jithendar.com moves its pin in `moks-cms.json`, rebuilds and deploys.

## A new site

1. Create a repository from [`sites/_template/`](sites/README.md): `site.json`, `config/`, `content/`, `public/images/`.
2. Ship those files in a content image whose init container copies them into the pod, and run
   `registry.jithendar.com/jithendar/moks-cms:pr-<number>` next to it.
3. Deploy it the way `moks-tech/jithendar.com` does (its `Dockerfile.content`, `kubernetes/`, `content.yml`,
   `deploy-kubernetes.yml` and `README.md`).

## Local development

See [services/www/README.md](services/www/README.md).

## License

Copyright (c) 2026 Jithendar Dharmapuri. All rights reserved. This is proprietary software; no use, copying, modification or distribution is permitted without written permission. See [LICENSE](LICENSE).
