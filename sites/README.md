# Sites

moks-cms is the CMS. A website it serves is a folder with this layout, kept in **the site's own repository**: the
repository builds the site's app on the `moks-cms-builder` image and deploys it. moks-cms itself deploys nothing.

```
<site repository>/
  site.json        identity: host, name, tagline, description, language, time zone, author, social links, AdSense ID;
                   "aiCrawlers" sets robots.txt for AI crawlers: "search" (answer engines that cite pages:
                   OAI-SearchBot, Claude-SearchBot, PerplexityBot…) and "training" (GPTBot, ClaudeBot,
                   Google-Extended, CCBot…), each "allow" or "block" (services/www/src/lib/seo/ai-crawlers.ts)
  config/          redirects.ts, gone.ts (URLs answered with 410), hire-me-profile.ts (/hire-me)
  content/         blog/ news/ projects/ pages/ authors/ (MDX), python-practice/
  public/images/   images the articles use, served as /images/…
  docs/            sources of the articles' figures, and scripts that check the articles (never shipped)
  grafana/         the site's Grafana dashboards: JSON files and a kustomization.yaml that makes them one ConfigMap
```

| Site | Repository |
|---|---|
| [jithendar.com](https://jithendar.com) | [`mrjithendar/jithendar.com`](https://github.com/mrjithendar/jithendar.com) (here as `sites/jithendar.com/` until 2026-11-16) |
| moksit.com | [`moksit.com/`](moksit.com/): identity and dashboards only, not built or deployed yet |
| — | [`_template/`](_template/): the starting point for a new site's repository (folders starting with `_` are never built) |

## Working on a site

The app in `services/www` reads `site/`, `content/` and `public/images/` in its own folder. `npm run site` fills them
from a site folder ([`scripts/use-site.mjs`](../services/www/scripts/use-site.mjs)). It uses `SITE_DIR` (any path), else
`SITE` (a folder here), else the test fixture site `services/www/tests/fixtures/site`.

- `site/` is a copy of `site.json` and `config/`, refreshed by every `npm run dev`, `build`, `typecheck` and `test`.
- `content/` and `public/images/` are symlinks, so edit articles and images in the site folder as usual.
- `npm run site -- --copy` makes real copies instead. CI does this, and Docker builds need it.

```bash
cd services/www
SITE_DIR=../../../jithendar.com npm run dev          # a site repository checked out next to moks-cms
```

## Adding a site

1. Create a repository and copy the template into it:

   ```bash
   cp -R sites/_template/. ../example.com/
   ```

2. Fill in `site.json` (`host` without `https://`; `timeZone` one of the zones in Admin → Settings, otherwise UTC) and
   rename `content/authors/your-name.mdx` to the slug in `primaryAuthor`.
3. Copy `services/www/Dockerfile.site` into it as `Dockerfile` (and its `.dockerignore`), and pin a builder tag:
   `registry.jithendar.com/jithendar/moks-cms-builder:pr-<number>`.
4. Check the content with moks-cms's own tests in that builder (the site mounted at `/site`):

   ```bash
   docker run --rm -v "$PWD:/site:ro" <builder> sh -c 'npm run site -- --copy && npx vitest run tests/content.test.ts tests/links.test.ts'
   ```

5. Deploy it: a Deployment, Service, route, TLS certificate, Secret and database for the site, with the site's app
   image and its content image in an init container. `mrjithendar/jithendar.com` is the worked example
   (`kubernetes/`, `.github/workflows/release.yml`, `deploy-kubernetes.yml` and its README's setup list).
6. To hear about new moks-cms images, add the repository to moks-cms's variable `RELEASE_NOTIFY_REPOS` and handle
   the `moks-cms-released` repository_dispatch.
7. **Dashboards**: copy jithendar.com's `grafana/`, change the `jithendar-com` job, service and namespace names, the
   uids and the titles, name the ConfigMap after the site, and add an Argo CD Application for the folder (tools repo,
   next to jithendar.com's in `deploy/minikube/applications/grafana.yaml`). uids and ConfigMap names must be unique
   across sites, since all sites share one Grafana.
