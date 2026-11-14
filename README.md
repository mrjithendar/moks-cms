# moks-cms

A CMS for MDX publications, and the source of [jithendar.com](https://jithendar.com), the site it serves (this repository was called `jithendar.com` until 2026-11-14): a personal website and tech blog covering DevOps, cloud infrastructure, Kubernetes and AI engineering.
Built with Next.js, MDX, PostgreSQL, Cloudflare R2 and Kubernetes.

| Path | Contents |
|---|---|
| [`sites/`](sites/README.md) | One folder per website the CMS serves (`sites/jithendar.com/`): identity (`site.json`), redirects and other config, articles, images, the articles' figure sources and the site's Grafana dashboards (`grafana/`, one ConfigMap and one Argo CD app per site). [Adding a site](sites/README.md#adding-a-site) |
| [`services/www/`](services/www/README.md) | The Next.js app (moks-cms): source, tests, Dockerfiles and [docs](services/www/docs/) |
| [`kubernetes/`](kubernetes/README.md) | Every manifest the site runs on the mk4 minikube cluster, in one flat folder: the site (`kustomization.yaml`), the Python practice executor (`practice-executor-*.yaml`) and the SEO agent (`seo-agent-*.yaml`); `scripts/manifests.sh <group>` prints one group |
| [`services/executor/`](services/executor/README.md) | Python practice executor (sandboxed code runner) |
| `services/seo-agent/` | SEO v4 agent service (Python: CrewAI Flows and Crews as the only job engine, MCP servers, pgvector, Ask the Blog, report PDFs); see [FLOWS.md](services/www/docs/seo/FLOWS.md) and [MCP.md](services/www/docs/seo/MCP.md) |
| `scripts/` | `create-secrets.sh` (first-time Secrets), `set-*-config.sh` (update site settings), `smoke.sh` (post-deploy checks) |
| [`runner/`](runner/README.md) | Self-hosted GitHub Actions runners (retired for CI: builds run on GitHub-hosted runners) |
| `.github/workflows/` | CI: checks pull requests; when one is merged, builds the images (`moks-cms`, `moks-cms-content`, `seo-agent`, `practice-executor`), pushes them to Harbor (`registry.jithendar.com/jithendar`), rolls them out and applies `kubernetes/` |

## Release

Merge a pull request into `master`. CI builds, pushes `registry.jithendar.com/jithendar/moks-cms:pr-<number>`
and `:latest` (Harbor; the same image) and rolls the site out on `:pr-<number>` (`scripts/ci-rollout.py`). That is
the whole release. Lint and the tests run on the pull request; the release skips them only if the pull request's last
commit passed them there, and runs them itself if it was merged before they finished (or while they were failing). A commit pushed straight to `master` builds and deploys nothing (the workflows have no `push` trigger;
only `ci-content.yml`, for articles and images, still runs on push).

**Content-only changes** (`sites/*/content/**`, `sites/*/public/images/**`) do not rebuild the site. `ci-content.yml`
validates the MDX (schema and internal links) of each site that changed, packages both folders into that site's small
content image (jithendar.com: `registry.jithendar.com/jithendar/moks-cms-content:latest`, from `deploy` in its `site.json`) (`services/www/Dockerfile.content`), pushes it and restarts
the site. The pods' init container `content` copies it over `/app/content` and `/app/public/images`. This takes about a
minute, not a full build. A push that changes both code and content runs both workflows.

**Drafts don't deploy.** A content push that only adds or edits articles with `status: draft` or `review` (plus new
images) still pushes the content image but does not restart the site: readers would see nothing new. New articles in such
a push are sent to Admin → Posts as drafts through the posts API (`push-post --create-only`, secret `JITHENDAR_API_KEY`),
unless they use an `/images/` file that is not live yet: then CI restarts the site so the draft and its images arrive. Setting an article to
`status: published`, or editing or deleting a published one, restarts it as above. Changes under `sites/*/docs/`,
`services/www/docs/` and `services/www/*.md` (notes, article diagram sources) are not in the site image and never trigger a site build or deploy.

Changes to `kubernetes/` are applied by the `deploy to kubernetes` workflow when their pull request is merged; run it by
hand (Actions → deploy to kubernetes → Run workflow) to re-apply everything and restart the site. There is no
`deploy.sh` any more (removed 2026-11-14). First-time setup,
Secrets, routing and rollback: [services/www/docs/DEPLOYMENT.md](services/www/docs/DEPLOYMENT.md).

## Local development

See [services/www/README.md](services/www/README.md).

## License

Copyright (c) 2026 Jithendar Dharmapuri. All rights reserved. This is proprietary software; no use, copying, modification or distribution is permitted without written permission. See [LICENSE](LICENSE).
