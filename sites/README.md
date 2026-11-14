# Sites

moks-cms is the CMS. Each folder here is one website it serves, named after the site's domain. Everything that
belongs to one site lives in its folder; the code in `services/` is shared.

```
sites/<domain>/
  site.json        identity: host, name, tagline, description, language, time zone, author, social links, AdSense ID,
                   and where CI deploys the site's content ("deploy")
  config/          redirects.ts, gone.ts (URLs answered with 410), hire-me-profile.ts (/hire-me)
  content/         blog/ news/ projects/ pages/ authors/ (MDX), python-practice/
  public/images/   images the articles use, served as /images/…
  docs/            sources of the articles' figures, and scripts that check the articles (never shipped)
```

| Folder | Site |
|---|---|
| [`jithendar.com/`](jithendar.com/) | [jithendar.com](https://jithendar.com) |
| [`_template/`](_template/) | Starting point for a new site (folders starting with `_` are never built or deployed) |

## Working on a site

The app in `services/www` reads `site/`, `content/` and `public/images/` in its own folder. `npm run site` fills them
from `sites/$SITE` (default `jithendar.com`; [`scripts/use-site.mjs`](../services/www/scripts/use-site.mjs)):

- `site/` is a copy of `site.json` and `config/`, refreshed by every `npm run dev`, `build`, `typecheck` and `test`.
- `content/` and `public/images/` are symlinks, so edit articles and images here in `sites/<domain>/` as usual.
- `npm run site -- --copy` makes real copies instead. CI does this, and Docker builds need it: run it before
  `docker build` in `services/www`.

```bash
cd services/www
npm run dev                                 # jithendar.com
SITE=example.com npm run site && SITE=example.com npm run dev
```

Content and images ship in the site's content image (`ci-content.yml`), without rebuilding the app. `site.json` and
`config/` are compiled into the app, so changing them releases a new app image (`ci-jithendar-com.yml`).

## Adding a site

1. Copy the template and name the folder after the domain:

   ```bash
   cp -R sites/_template sites/example.com
   ```

2. Fill in `site.json` (`host` without `https://`; `timeZone` one of the zones in Admin → Settings, otherwise UTC) and
   rename `content/authors/your-name.mdx` to the slug in `primaryAuthor`.
3. Write content under `content/` and check it locally:

   ```bash
   cd services/www
   SITE=example.com npm run site && SITE=example.com npm run dev
   ```

4. Open a pull request. `ci-content.yml` validates the new site's content (pull requests check every site whose files
   changed).

Until here nothing is deployed. To put the site on the cluster, a person does the following once:

5. **Cluster**: a Deployment, Service, route, TLS certificate, Secret and database for the site, like the
   `jithendar-com` objects in `kubernetes/`, running an app image built for the site (see the last paragraph) and the
   site's content image in its init container.
6. **CI access**: add the Deployment to the `github-ci-deployer` Role (`resourceNames` in
   `kubernetes/80-ci-deployer.yaml`), and let the Harbor robot push to the content image's repository.
7. **API key**: create an API key in the new site's Admin → API keys (scopes posts:read + posts:write) and store it as a
   repository secret.
8. **Deploy block**: add it to `site.json`; from then on, merging content for this site releases it:

   ```json
   "deploy": {
     "namespace": "jithendar",
     "deployment": "example-com",
     "contentImage": "registry.jithendar.com/jithendar/moks-cms-content-example-com",
     "apiKeySecret": "EXAMPLE_COM_API_KEY"
   }
   ```

The app image (`moks-cms`) is built for jithendar.com today (`ci-jithendar-com.yml` copies `sites/jithendar.com`). A second
site that needs its own `site.json` and `config/` compiled in needs its own app image too: build it with
`SITE=<domain> npm run site -- --copy` before the build.
