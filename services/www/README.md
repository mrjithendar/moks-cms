# moks-cms web app

Next.js 16 (App Router) + MDX publication site. It serves one site, a folder with `site.json`, `config/`, `content/`
and `public/images/`: `npm run site` links or copies those into `site/`, `content/` and `public/images/` here, and every
command below runs it first. Which folder: `SITE_DIR` (any path, e.g. a site's own repository such as
`moks-tech/jithendar.com` checked out next to this one), else `SITE` (a folder of [`sites/`](../../sites/README.md)),
else the test fixture site `tests/fixtures/site` ([`scripts/use-site.mjs`](scripts/use-site.mjs)).
Standing rules: [AGENTS.md](AGENTS.md). Content guide: [docs/CONTENT_MODEL.md](docs/CONTENT_MODEL.md).

Requires Node ≥ 24 (`.nvmrc`). On this Mac, Node 26 is at `/opt/homebrew/bin/node`, but `/usr/local/bin/node` (v20) comes first in `PATH`.

```bash
export PATH=/opt/homebrew/bin:$PATH
npm install
npm run dev          # http://localhost:3000 (SITE_DIR=../../../jithendar.com npm run dev for a real site)
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

CI (`.github/workflows/ci-moks-cms.yml`) deploys nothing. On merge it pushes the CMS image
`registry.jithendar.com/jithendar/moks-cms:pr-<number>` (`Dockerfile.ci`), after a smoke test. The image holds no site
of its own beyond the test fixture's files as defaults. A site's Deployment mounts its own `site/` (site.json, config/),
`content/` and `public/images/` over `/app/site`, `/app/content` and `/app/public/images`; jithendar.com ships them in
its content image. The app reads them at run time, so a site never builds the CMS.
