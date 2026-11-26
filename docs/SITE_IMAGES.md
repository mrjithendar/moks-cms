# Site images in R2 (`/images/…`)

A site's own images (diagrams, screenshots, covers) live in its repository under `public/images/` and content refers
to them as `/images/…`. They used to reach the pod only inside the site's content image, which an init container
copied to `public/images/` at start: every new image needed an image build and a restart, and the copy grew with every
article. They can now be pushed to R2 through the API and served from there. Uploads from the editor (`/media/…`) are
a separate thing and unchanged: see [MEDIA.md](MEDIA.md).

## How it works

| Piece | Where |
|---|---|
| Store, validate, convert, look up, serve | `src/lib/site-images.ts` |
| Table `site_image` | migration `0033_site_image.sql`, rollback in `src/db/rollback/` |
| Push one file | `PUT /api/v1/images/<path>` (`src/app/api/v1/images/[...path]/route.ts`) |
| Push a large document or media file | `POST /api/v1/images/<path>` start → PUT to R2 → complete (same route) |
| List what is stored | `GET /api/v1/images` (`src/app/api/v1/images/route.ts`) |
| Serve | `GET /images/<path>` (`src/app/images/[...path]/route.ts`) |
| Size and URL for pages | `resolveImage()` in `src/lib/media.ts` |

- **Object keys:** `jithendar/www/site-images/<path below /images/>`, in the media bucket (Admin → Settings → Media & storage).
- **URLs do not change.** A file that is still on disk in `public/images/` is served from disk and wins, exactly as
  before: Next serves `public/` before any route, and `resolveImage()` looks on disk first. Only a path that is not on
  disk is answered from R2. So pushing images changes nothing for readers until the files leave the pod.
- **Readers make no third-party request.** The bytes come through the site, as for `/media/…` images. A pod keeps up
  to 32 MB of them in memory (entries up to 2 MB), because SVGs are requested by every reader (`next/image` does not
  re-encode them). An entry is used only while its ETag matches the row, so a replaced image is not served stale.
- **Caching:** `Cache-Control: public, max-age=86400, stale-while-revalidate=604800` (what `next.config.ts` sends for
  files on disk) and an `ETag`; `If-None-Match` answers `304`.

## PNG files are stored as lossless WebP

A pushed PNG is stored as **lossless** WebP when that is smaller: the same pixels, about half the bytes for diagrams
(the 88 PNGs of jithendar.com: 25.2 MB → 12.9 MB, measured with libwebp on 2026-11-16). Lossy WebP was not chosen: at
quality 90 it saved only three points more and it blurs thin lines and small text. A 16-bit or animated PNG, or one
that WebP does not make smaller, stays a PNG.

Such an image has two paths:

| | Example | Used by |
|---|---|---|
| `path` | `/images/aws-vpc/01.png` | Content (`![…](/images/aws-vpc/01.png)`, `featuredImage.src`), the file in the repository, the editor's image picker |
| `servedPath` | `/images/aws-vpc/01.webp` | Pages: `resolveImage()` returns it, so `next/image` reads the WebP |

**Content is not rewritten.** Articles keep the `.png` path they always had. The `.png` URL keeps answering too, with
a PNG made from the stored WebP (the same pixels), so anything that names it directly still gets a PNG: `og:image` and
`twitter:image` (some link-preview clients do not show WebP), the image sitemap, JSON-LD, feeds and old links. A PNG
and a WebP that would share a URL (`a.png` and a real `a.webp`) are refused with `409`.

## Pushing

```sh
# scope images:write, a key that belongs to an admin (Admin → API keys)
curl -X PUT -H "Authorization: Bearer $KEY" --data-binary @public/images/my-post/diagram.png \
  https://jithendar.com/api/v1/images/my-post/diagram.png
```

- The body is the file itself, at most 20 MB. Allowed: PNG, JPEG, WebP, AVIF, GIF and SVG (images: at most 20 MB, SVG
  2 MB, 12,000 pixels a side), and PDF, MP4, WebM and MP3 (documents and media, below). The type is read from the bytes
  and must match the file name.
- Paths: one to six segments of letters, digits, `.`, `_` and `-`, each starting with a letter or digit.
- **SVG** is accepted here, unlike in the media library, because these files come from the site's own repository.
  An SVG with a `<script>` element, an event handler attribute or a `javascript:` link is refused, and every response
  is sent with a sandboxing `Content-Security-Policy`. `<foreignObject>` is allowed: draw.io uses it for text labels.
- Pushing the same bytes again changes nothing (`unchanged: true`), so a tool can send every file on every push.
  `GET /api/v1/images` returns each stored `path` with the SHA-256 of the pushed file, to skip unchanged files without
  sending them (scope `images:write` or `posts:read`).
- Pushing different bytes to a stored path **replaces** the image on every page that uses it.
- The usual API limit applies: 120 requests a minute per key (`429` with `Retry-After: 60`).
- Every new or replaced image is written to the audit log (`site_image.create`, `site_image.replace`).

### Documents, video and audio; large files

PDF (up to 100 MB), MP4 and WebM (500 MB) and MP3 (100 MB) are kept under the same `/images/…` paths, for links and
players in articles (`[the guide](/images/my-post/guide.pdf)`). They are never converted or measured (`width` and
`height` are 0), `resolveImage()` does not treat them as images, and they are not kept in memory: `GET /images/<path>`
redirects to R2's public domain when one is configured (`R2_PUBLIC_BASE_URL`, Cloudflare serves the bytes and range
requests), and otherwise streams them from R2 with `Range` support.

A file up to 20 MB can be sent in one PUT. A larger one goes straight to R2, so it never passes through Cloudflare's
request limit or the pod's memory:

```sh
# 1. start: a 10-minute presigned PUT for exactly this type and size, to a staging key
curl -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"action":"start","size":104857600,"sha256":"<hex>"}' https://jithendar.com/api/v1/images/my-post/demo.mp4
#    → {"data":{"upload":"<id>","uploadUrl":"https://…r2.cloudflarestorage.com/…","headers":{…},"expiresInSeconds":600}}
# 2. send the file to uploadUrl with those headers
curl -X PUT -H 'Content-Type: video/mp4' -H 'Cache-Control: …' --data-binary @demo.mp4 "$uploadUrl"
# 3. complete: size, SHA-256 and type are checked, then the file is copied into place (the same answer as PUT)
curl -X POST … -d '{"action":"complete","upload":"<id>","size":104857600,"sha256":"<hex>"}' …/my-post/demo.mp4
```

A wrong size, checksum or type is refused and the staged object deleted; the file already at that path (if any) stays
as it was. Images always go in one PUT. `scripts/push-content.py` in a site repository does all three steps.

### Who may push

Only a key with scope `images:write`, and only an admin can create one: a site image can be part of any page, not
only of the key owner's posts. A leaked key can replace images on live pages, so give it to CI only and revoke it when
in doubt. It cannot read, publish or change posts. There is no delete through the API yet.

## Moving an existing site to R2

1. Deploy this version (migration `0033_site_image.sql` runs at start). Nothing changes yet.
2. Configure R2 if it is not (Admin → Settings → Media & storage) and create an `images:write` key.
3. Push every file under `public/images/`. Pages are unchanged, because the files on disk still win.
4. Check a few: `/images/<path>.webp` for a pushed PNG answers `200 image/webp`; `GET /api/v1/images` lists them all.
5. Stop copying `public/images/` into the pod. From then on `/images/…` is answered from R2.

Rollback of step 5: copy the files into the pod again. Disk wins as soon as the files are back.

## Tests

`tests/site-images.test.ts`: paths; PNG → WebP with identical pixels; both URLs; ETag and `304`; replacement; JPEG and
SVG kept as they are; refused files; URL clashes; scopes and roles; the list; `resolveImage()` and the social card;
documents and media in one PUT and through the direct upload, and refused uploads leaving the live file alone.
