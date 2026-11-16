# moks-cms web app

Next.js 16 (App Router) + MDX publication site. It serves one site, a folder with `site.json`, `config/`, `content/`
and `public/images/`: `npm run site` links or copies those into `site/`, `content/` and `public/images/` here, and every
command below runs it first. Which folder: `SITE_DIR` (any path, e.g. a site's own repository such as
`mrjithendar/jithendar.com` checked out next to this one), else `SITE` (a folder of [`sites/`](../../sites/README.md)),
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
| `SITE_DIR` | The site folder to build (`npm run site`): a site repository's checkout, or `/site` in the `moks-cms-builder` image. Compiled in: set it before `build`, not at run time. |
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

CI (`.github/workflows/ci-moks-cms.yml`) deploys nothing. On merge it pushes `moks-cms-builder` (`Dockerfile.builder`:
this app with its dependencies installed and no site), after building the fixture site on it with `Dockerfile.site`
and smoke-testing that. A site's repository builds its own app image the same way: `Dockerfile.site` with the site
folder as the build context and `MOKS_CMS_BUILDER` set to the builder tag it pins (jithendar.com: `moks-cms.json`).

```bash
../../scripts/build-site-image.sh moks-cms-builder:dev site:dev "$(git rev-parse HEAD)" ../../../jithendar.com
```
