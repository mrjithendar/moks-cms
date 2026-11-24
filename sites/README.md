# Sites

moks-cms is the CMS. A website it serves is a folder with this layout, kept in **the site's own repository**: the
repository ships these files in its own content image and runs the moks-cms image, which reads them at run time.
moks-cms itself deploys nothing.

```
<site repository>/
  site.json        identity: host, name, tagline, description, language, time zone, author, social links, AdSense ID, Reader Revenue Manager product;
                   "aiCrawlers" sets robots.txt for AI crawlers: "search" (answer engines that cite pages:
                   OAI-SearchBot, Claude-SearchBot, PerplexityBot…) and "training" (GPTBot, ClaudeBot,
                   Google-Extended, CCBot…), each "allow" or "block" (src/lib/seo/ai-crawlers.ts)
  config/          redirects.json ([{"source", "destination"}], 308), gone.json (paths answered with 410),
                   hire-me-profile.json (/hire-me)
  content/         blog/ news/ projects/ pages/ authors/ (MDX), python-practice/
  public/images/   images the articles use, served as /images/…
  docs/            sources of the articles' figures, and scripts that check the articles (never shipped)
```

| Site | Repository |
|---|---|
| [jithendar.com](https://jithendar.com) | [`moks-tech/jithendar.com`](https://github.com/moks-tech/jithendar.com) (here as `sites/jithendar.com/` until 2026-11-16) |
| moksit.com | [`moksit.com/`](moksit.com/): identity only, not built or deployed yet |
| — | [`_template/`](_template/): the starting point for a new site's repository (folders starting with `_` are never built) |

## Working on a site

The app reads `site/`, `content/` and `public/images/` in its own folder. `npm run site` fills them
from a site folder ([`scripts/use-site.mjs`](../scripts/use-site.mjs)). It uses `SITE_DIR` (any path), else
`SITE` (a folder here), else the test fixture site `tests/fixtures/site`.

- `site/` is a copy of `site.json` and `config/`, refreshed by every `npm run dev`, `build`, `typecheck` and `test`.
- `content/` and `public/images/` are symlinks, so edit articles and images in the site folder as usual.
- `npm run site -- --copy` makes real copies instead. CI does this, and Docker builds need it.

```bash
SITE_DIR=../jithendar.com npm run dev                # a site repository checked out next to moks-cms
```

## Adding a site

1. Create a repository and copy the template into it:

   ```bash
   cp -R sites/_template/. ../example.com/
   ```

2. Fill in `site.json` (`host` without `https://`; `timeZone` one of the zones in Admin → Settings, otherwise UTC) and
   rename `content/authors/your-name.mdx` to the slug in `primaryAuthor`.
3. Ship `content/`, `public/images/`, `site.json` and `config/` in a content image (jithendar.com's
   `Dockerfile.content`) whose init container copies them to `/app/content`, `/app/public/images` and `/app/site`, next
   to `registry.jithendar.com/jithendar/moks-cms:pr-<number>`. The CMS reads them at server start.
4. Check the content with the CMS image that will serve it: start it with the folders mounted and an embedded
   database (`-e APP_ENV=development -e PGLITE_DIR=/tmp/pglite`) and request the pages. An invalid article answers 500
   (jithendar.com's `scripts/check-content.sh`).
5. Deploy it: a Deployment, Service, route, TLS certificate, Secret and database for the site. `moks-tech/jithendar.com`
   is the worked example (`kubernetes/`, `.github/workflows/content.yml`, `deploy-kubernetes.yml` and its README).
6. **Dashboards**: in [mrjithendar/monitoring](https://github.com/mrjithendar/monitoring): copy
   `dashboards/private/Jithendar.com/` to a folder for the site (`dashboards/private/` signed-in only, `public/` for
   anyone), change the `jithendar-com` job, service and namespace names, the uids and the titles, and add the folder's
   tag to `FOLDER_TAGS` in its `scripts/dashboards.py`. Its checks keep uids unique; merging deploys.
