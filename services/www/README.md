# moks-cms web app

Next.js 16 (App Router) + MDX publication site. It serves one site from the repository's [`sites/`](../../sites/README.md)
folder (`SITE`, default `jithendar.com`): `npm run site` links or copies that site's `site.json`, `config/`, `content/`
and `public/images/` into `site/`, `content/` and `public/images/` here, and every command below runs it first.
Standing rules: [AGENTS.md](AGENTS.md). Content guide: [docs/CONTENT_MODEL.md](docs/CONTENT_MODEL.md).

Requires Node ≥ 24 (`.nvmrc`). On this Mac, Node 26 is at `/opt/homebrew/bin/node`, but `/usr/local/bin/node` (v20) comes first in `PATH`.

```bash
export PATH=/opt/homebrew/bin:$PATH
npm install
npm run dev          # http://localhost:3000 (SITE=<domain> npm run dev for another site)
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
| `SITE` | Which folder of `sites/` to build (`npm run site`), default `jithendar.com`. Compiled in: set it before `build`, not at run time. |
| `SITE_URL` | Canonical origin, default `https://` + the site's `host`. |
| `CONTENT_DIR` | Optional content root; tests use `tests/fixtures/content`. |

To run the standalone build locally:

```bash
cp -R .next/static .next/standalone/.next/static
cd .next/standalone && APP_ENV=production PORT=3000 node server.js
```

ISR writes to `.next/cache` at runtime. Phase 6 must mount that path as writable.
