# jithendar.com

Personal website and tech blog covering DevOps, cloud infrastructure, Kubernetes and AI engineering.
Built with Next.js, MDX, PostgreSQL, Cloudflare R2 and Kubernetes.

| Path | Contents |
|---|---|
| [`services/www/`](services/www/README.md) | The Next.js site: source, content, tests, Dockerfiles and [docs](services/www/docs/) |
| [`minikube/`](minikube/README.md) | Every manifest the site runs on the mk4 minikube cluster, in one flat folder: the site (`kustomization.yaml`), the Python practice executor (`practice-executor-*.yaml`) and the SEO agent (`seo-agent-*.yaml`); `scripts/manifests.sh <group>` prints one group |
| [`services/executor/`](services/executor/README.md) | Python practice executor (sandboxed code runner) |
| `services/seo-agent/` | SEO v4 agent service (Python: CrewAI Flows and Crews as the only job engine, MCP servers, pgvector, Ask the Blog, report PDFs); see [FLOWS.md](services/www/docs/seo/FLOWS.md) and [MCP.md](services/www/docs/seo/MCP.md) |
| [`services/grafana/`](services/grafana/README.md) | Grafana dashboards for the site (metrics, logs and traces), loaded by Argo CD's `grafana` app (its path must be `services/grafana`) |
| `deploy.sh` | Apply the site manifests and restart the site on `jithendar-com:latest` |
| `scripts/` | `create-secrets.sh` (first-time Secrets), `set-*-config.sh` (update site settings), `smoke.sh` (post-deploy checks) |
| [`runner/`](runner/README.md) | Self-hosted GitHub Actions runners (retired for CI: builds run on GitHub-hosted runners) |
| `.github/workflows/` | CI: checks pull requests; on `master`, builds and pushes the image to ECR (`infra.yml` applies `infra/`) |
| `infra/` | Terraform: ECR repositories and the CI's AWS role ([infra/README.md](infra/README.md)) |

## Release

Push to `master`. CI tests, builds, pushes `registry.jithendar.com/jithendar/jithendar-com:latest` (Harbor) and
restarts the site, which always runs `:latest` with `imagePullPolicy: Always`. That is the whole release.

**Content-only changes** (`services/www/content/**`, `services/www/public/images/**`) do not rebuild the site. `ci-content.yml`
validates the MDX (schema and internal links), packages both folders into the small
`registry.jithendar.com/jithendar/jithendar-content:latest` image (`services/www/Dockerfile.content`), pushes it and restarts
the site. The pods' init container `content` copies it over `/app/content` and `/app/public/images`. This takes about a
minute, not a full build. A push that changes both code and content runs both workflows.

Run `./deploy.sh` only after changing `minikube/` (it applies the manifests and restarts the site). It needs
`kubectl` with the `mk4` context. First-time setup,
Secrets, routing and rollback: [services/www/docs/DEPLOYMENT.md](services/www/docs/DEPLOYMENT.md).

## Local development

See [services/www/README.md](services/www/README.md).

## License

Copyright (c) 2026 Jithendar Dharmapuri. All rights reserved. This is proprietary software; no use, copying, modification or distribution is permitted without written permission. See [LICENSE](LICENSE).
