# Test fixture site

The site the tests, `npm run dev` and the CI image smoke test use when neither `SITE_DIR` nor `SITE` is set
(`scripts/use-site.mjs`). It is a small snapshot of jithendar.com, taken on 2026-11-16 when that site moved to its own
repository (`moks-tech/jithendar.com`): its `site.json` and `config/` unchanged (tests check that identity), its
pages, author and Python practice problems, and five articles with the images they use. Links and `related` entries to
articles that are not here were removed.

It is test data, not a website: nothing here is deployed. Real sites live in their own repository and build on the
`moks-cms-builder` image (`Dockerfile.builder`).

To work on a real site locally, point the app at its checkout:

```bash
SITE_DIR=../jithendar.com npm run dev
```
