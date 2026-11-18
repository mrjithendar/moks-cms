# Media: Cloudflare R2, responsive delivery, AI images

Status: implemented 2026-10-29. Live R2 and Gemini checks **require manual configuration** (see the end).

## Architecture

```
 editor (browser) ──server action (≤10 MB images)──▶ site pod ──S3 API──▶ R2 bucket
        │                                              ▲   │              jithendar/www/media/{type}/{yyyy}/{mm}/{id}.{ext}
        └──presigned PUT (video/audio/PDF, ≤200 MB)────┼───┼────────────▶ jithendar/www/tmp/generated/… (AI drafts, 1 day)
                                                       │   │
 reader ──/media/{id}/{name}──▶ site pod ──stream──────┘   └──Gemini Interactions API (Generate image)
        ──/_next/image?url=/media/…&w=…──▶ next/image (sharp) → AVIF/WebP, disk-cached
        ──(video/audio/PDF, when R2_PUBLIC_BASE_URL is set)──301──▶ public R2 domain (Cloudflare CDN, range requests)
```

No new service: storage, validation, image optimisation and Gemini calls run in the existing Next.js app.
A separate image service was not needed — `next/image` already resizes in the pods and is bounded (below).

| Concern | Where |
|---|---|
| R2 client, keys, presigning, config | `src/lib/storage.ts` |
| Legacy S3 (read-only, migration source) | `src/lib/storage-legacy.ts` |
| Validation, uploads, media records | `src/lib/media.ts` |
| Delivery (`/media/{id}/{name}`) | `src/app/media/[id]/[name]/route.ts` |
| S3 → R2 migration | `src/lib/media-migration.ts`, Admin → Storage, `GET /api/admin/media-migration` (manifest) |
| Gemini client | `src/lib/gemini.ts` |
| Generation workflow, limits, cleanup | `src/lib/image-generation.ts`, `POST /api/admin/images/generate`, `GET /api/admin/images/generations/{id}` |
| Editor UI | `src/components/admin/{CoverImagePicker,GenerateImageDialog,MediaPicker,Dialog}.tsx`, `src/app/admin/media/MediaUploader.tsx` |
| Schema | `src/db/migrations/0004_r2_media.sql` (`media` columns, `image_generation` table) |

A site's own files under `/images/…` (diagrams and covers kept in the site's repository) are not media library
uploads. They can be stored in R2 as well, under `jithendar/www/site-images/`, and are described in
[SITE_IMAGES.md](SITE_IMAGES.md).

## Object keys

`jithendar/www/media/{type}/{yyyy}/{mm}/{unique-id}.{extension}` — a key prefix inside the bucket.
`{type}` is `images`, `videos`, `audio` or `documents`; `{unique-id}` is the media row's random UUID;
the extension comes from the detected content type. User-supplied names never reach the key (they only
become the readable `{name}` in `/media/{id}/{name}`). Unaccepted AI images live under
`jithendar/www/tmp/generated/{yyyy}/{mm}/{id}.{ext}`.

## Upload rules

| Type | Formats (checked by magic bytes, not name) | Max | Path |
|---|---|---|---|
| images | JPEG, PNG, WebP, AVIF, GIF (no SVG: scripts) | 10 MB, ≤12 000 px a side | server action → `PutObject` with `Content-MD5` |
| videos | MP4, WebM | 200 MB | presigned `PUT` (10 min, `Content-Type` + `Content-Length` signed) → server verifies |
| audio | MP3, M4A, Ogg, WAV | 50 MB | presigned |
| documents | PDF | 20 MB | presigned |

Presigned flow: the browser computes SHA-256 → `requestUpload` validates type/size/alt, creates a
`pending` row (invisible everywhere) and signs a PUT for exactly that key/type/size → browser PUTs to R2
→ `finishUpload` HEADs the object (size), streams it to recompute SHA-256, sniffs the real type and,
for images, decodes dimensions. Any mismatch deletes the object and row. Pending rows older than an hour
are purged (before each new upload, and by Admin → Database → "Delete abandoned uploads…").

Objects get `Cache-Control: public, max-age=31536000, immutable` (names are unique). Private files
(`visibility = private`) are only reachable by signed-in staff via a 5-minute presigned GET.

## Transformation (resizing) and its limits

R2 does not resize. `next/image` does, inside the site pods, from `/images/**` and `/media/**` only:

- widths: `deviceSizes` 640, 750, 828, 1080, 1200, 1920 and `imageSizes` 96, 128, 256, 384 — any other `w` is a 400;
- one quality (75), formats AVIF then WebP (original as fallback for old browsers);
- sources over 12 MB refused (`maximumResponseBody`), redirects not followed;
- results cached on disk for 30 days, LRU-capped at 200 MB (`maximumDiskCacheSize`) inside the 256 MiB `next-cache` emptyDir;
- verified locally against `next start`: `w=640`/`w=1920` → 200 `image/avif`; `w=1000`, `w=3840`, `q=100`, remote URL, `/api/health` → 400.

Components: `CoverImage` (cards, 16:9 crop around the author's focal point, `sizes` per layout, eager +
`fetchPriority="high"` only for the homepage lead card), the article hero (eager LCP image), and
`ContentImage` (Markdown images, lazy, intrinsic size, alt text placeholder when missing).

## Content shortcodes

```
::video{src="/media/<id>/clip.mp4" poster="/media/<id>/still.jpg" caption="…" ratio="16:9|4:3|1:1|9:16"}
::audio{src="/media/<id>/episode.mp3" caption="…"}
::embed{src="https://www.youtube.com/watch?v=…" title="…"}      # YouTube (youtube-nocookie) or Vimeo (dnt=1) only
```

Fixed aspect-ratio frames (no layout shift), lazy iframes, sandboxed embeds, download fallbacks. Tables
are wrapped in a focusable horizontal scroll region; code blocks scroll inside themselves.

## Generate image (Gemini)

- API: `POST https://generativelanguage.googleapis.com/v1beta/interactions` with `x-goog-api-key`, body
  `{ model, input, response_format: { type: "image", mime_type: "image/jpeg", aspect_ratio, image_size }, store: false }`;
  image read from `steps[].content[]` blocks of `type: "image"` (base64 `data`). Checked against Google's
  published OpenAPI description on 2026-10-29. Plain `fetch` (no SDK dependency) so cancellation aborts the request.
- Key and model: **Admin → Integrations** (key sealed in the database; saving verifies it with a free
  `GET v1beta/models/{model}` request, nothing is generated). `GEMINI_API_KEY`/`GEMINI_IMAGE_MODEL`/`GEMINI_IMAGE_SIZE`
  remain a fallback until the admin entry is saved. Nothing is hard-coded. On 2026-10-29 Google's models page listed
  `gemini-3.1-flash-image` (Nano Banana 2) and `gemini-nano-banana-2.1` as stable image models.
- Limits (env): `GEMINI_IMAGE_USER_HOURLY_LIMIT` (10), `GEMINI_IMAGE_USER_CONCURRENCY` (1), `GEMINI_IMAGE_DAILY_LIMIT`
  (50, whole site), `GEMINI_IMAGE_TIMEOUT_MS` (90 000). Counted in Postgres, so they hold across replicas.
- Errors → clear messages: content-policy refusal, quota/429, timeout, cancel, unsupported option, bad key,
  unknown model, outage, no image, invalid image. Refusal detection is heuristic (Google does not document
  a refusal field for this API): `status: failed` errors or text mentioning safety/policy.
- Returned bytes are validated (allowed raster type, decodable, ≤10 MB, ≤12 000 px) before anything is stored.
- Privacy: prompts are never stored or logged — only SHA-256, length, model, ratio, size, latency, outcome.
- Lifecycle: result → `tmp/generated` (private, no-store preview) → **Use as cover** copies it to
  `media/images/…`, creates the media row and puts it in the editor (the post changes only when saved;
  nothing is published). **Discard**/close deletes it; unaccepted results are deleted after 1 hour by the
  app and after 1 day by the R2 lifecycle rule (backstop).

## Generate video (Veo through the Gemini API)

**Requires manual configuration**: off until a video model is set in **Admin → Advanced settings → Video generation**
(`GEMINI_VIDEO_MODEL`, a Veo model code from ai.google.dev). It uses the Gemini key from Integrations and needs R2.
Not yet exercised against the real API (no key in development): request and response shapes follow Google's Veo guide
as read on 2026-11-12, and the tests use canned responses. Generate one clip after configuring it.

- API: `POST {base}/models/{model}:predictLongRunning` with `{ instances: [{ prompt }], parameters: { aspectRatio } }`
  (`resolution` / `durationSeconds` only when `GEMINI_VIDEO_RESOLUTION` / `GEMINI_VIDEO_SECONDS` are set) → operation
  name; `GET {base}/{operation}` until `done`; the clip is downloaded from
  `response.generateVideoResponse.generatedSamples[0].video.uri` with the key in `x-goog-api-key`. The key is only sent
  to the API host or another `*.googleapis.com` host.
- A clip takes minutes, so nothing waits in memory: `POST /api/admin/videos/generate` returns the generation id
  (row in `image_generation`, `kind = 'video'`), the dialog polls `GET …/generations/{id}/status` every 8 s, and the
  poll that finds the operation done downloads the clip, checks it is an MP4 and stores it under `tmp/generated`
  (one replica only: the row is claimed as `finalizing`). A poll that cannot reach Google keeps waiting; after
  `GEMINI_VIDEO_TIMEOUT_MS` (10 min) the generation is closed as timed out.
- Limits: `GEMINI_VIDEO_USER_HOURLY_LIMIT` (3), `GEMINI_VIDEO_DAILY_LIMIT` (10, whole site), one running video per
  author. Counted separately from images. A cancelled video still counts: Google's operation cannot be cancelled and
  is billed.
- Lifecycle as for images: private preview (`GET /api/admin/videos/generations/{id}`, Range supported) → **Insert
  video** copies it to `media/videos/…`, creates the media row (description required) and inserts `::video`;
  **Discard**/close deletes it; unaccepted clips expire after 1 hour.
- **Destinations** (`src/lib/video-destinations.ts`; Admin → Advanced settings → Video destinations). An admin switches
  each one on or off; the dialog's "Save the video to" list shows only those that are on and fully filled in (with one,
  there is nothing to choose; with none, Generate video is disabled). **Requires manual configuration**, and none of
  the three services has been exercised with real credentials: the tests use canned responses.

  | Destination | Needs | What happens on Insert | In the article |
  |---|---|---|---|
  | This site (R2), on unless `VIDEO_DEST_R2_DISABLED` | media storage | copied to `media/videos/…`, media row created | `::video` (native player) |
  | Cloudflare Stream | `CF_STREAM_ENABLED`, account id, API token (Stream: Edit), customer code | multipart upload to `…/accounts/{id}/stream` | `::embed` of `customer-{code}.cloudflarestream.com/{uid}/iframe` |
  | Mux | `MUX_ENABLED`, token id + secret | asset created from a one-hour signed link to the private copy (Mux downloads it) | `::embed` of `player.mux.com/{playbackId}` |
  | Bunny Stream | `BUNNY_STREAM_ENABLED`, library id, library API key | video created, then bytes `PUT` | `::embed` of `iframe.mediadelivery.net/embed/{library}/{guid}` |

  **Uploads** (Admin → Media): when at least one streaming service is on, each video in the upload list gets a "Save
  the video to" choice. The file always lands in the media library first (verified as usual); choosing a service
  then sends it on from there (`lib/video-publish.ts`: Cloudflare Stream and Mux download it through a one-hour signed
  link, Bunny Stream is streamed the bytes) and the list shows the player address to paste into the editor's "Video
  embed" block. The library copy stays (delete it later if you do not want both) with the player address noted in its
  description. Private files are not sent anywhere.

  Generated videos sent to a service are **not** in Admin → Media: they live in that service's account (the id is kept in
  `image_generation.external_id` and the audit log) and are deleted there. The services encode after upload, so the
  player can show "processing" for a minute. A silent loop adds `autoplay`, `loop` and `muted` to the player address
  (each player's own options; check them once per service). Readers' browsers then load a third-party player.
- `::video{src="/media/…" loop="true"}` plays muted, by itself and repeating (GIF-style). The controls stay so a reader
  can pause it. A real `.gif` file is not produced: an MP4 loop is a fraction of the size.

## Media library (Admin → Media)

WordPress-style: grid or list view; filters by type, month and “missing alt text”; search over file name, alt
text, title and caption; drag-and-drop upload of up to 20 files at once (alt text pre-filled from the file name
and required for images before upload); **Attachment details** (preview, file facts, uploader, alt text, title,
caption, description, where the file is used with edit links, copy URL/Markdown, previous/next); bulk select
and delete (files still used by a post, page or the site settings are always kept). Pages have featured images
like posts (shown under the page title and used as the share image).

## Backups (Admin → Backups)

Cloudflare R2 only (S3, SFTP and Google Drive destinations were removed on 2026-10-29). Backups reuse the media
R2 account and token and are written to `jithendar/backups/jithendar-backup-{yyyymmdd-hhmmss}.zip` in
the media bucket or, recommended, a separate private bucket (the token needs Object Read & Write on it).

Each backup is a standard zip: `backup.json` (the data) and `README.txt` (what it holds and how to open it).
**Encryption is a switch** in Schedule and encryption: on (the default), `backup.json` is AES-256 encrypted inside
the zip with the backup passphrase (WinZip AES via `@zip.js/zip.js`: opens in 7-Zip, Keka, WinRAR or `7z x`, not
macOS Archive Utility); off, it is a plain zip anyone with the file can read. The switch applies to new backups.
Backups from before the zip format (`….json.gz.enc`, gzip + AES-256-GCM) are still listed, downloaded and restored,
and need the passphrase, which is kept when encryption is turned off.
The page (Admin → Operations → Backups) lists the newest 10 backups in R2 with **Download** and **Restore**;
the retention setting prunes older ones.

**Restore** (one click + confirmation, `restoreStoredBackup` in `src/lib/backups.ts`): first writes a fresh
backup of the current state to R2 (named in the success message, restorable the same way), then in one
transaction replaces posts, pages, categories, author profiles, comments (with likes and reports), contact
messages, media records, redirects and Appearance settings with the backup. Accounts are merged: missing ones
are recreated without a password (they use “Forgot password” or social sign-in); existing accounts, sign-in
methods, sessions, API keys and stored credentials are never touched. Media files in R2 are not changed.

Two rules protect what a backup does not hold (since 2026-11-15):

- **Posts and categories are updated in place** (`KEEP_ROWS`). A post or category that is in the backup and still
  exists keeps its row; only those the backup does not have are deleted. Tables outside the backup hang off them
  (`seo_drafts`, `seo_content_audits`, `seo_article_optimizations`, `seo_internal_link_suggestions`,
  `seo_ml_related_articles` and `seo_promo_opportunities` are deleted with their post; `seo_recommendations`,
  `seo_editorial_calendar`, `seo_url_map`, `seo_search_submissions` and `news_topics` lose their link), and a restore
  used to delete every post and category first, which emptied or unlinked all of them although the same posts came
  straight back. That SEO data is kept as it is, not rolled back: a draft or audit made after the backup now sits
  next to the older article text.
- **A recreated account is always a reader.** The role in the file is ignored, because the file comes from a bucket:
  with the role taken from it, anyone who can write to that bucket could add an admin of their own and then set its
  password with “Forgot password”. The success message says how many recreated accounts had a staff role in the
  backup, and the `backup.restore` audit entry names them (`rolesNotRestored`); an admin gives the roles back in
  Admin → Users. A plain (unencrypted) zip is still accepted while encryption is on, so that backups made before it was
  switched on can be restored; a file planted in the bucket can therefore still replace content if an admin restores
  it, but it can no longer grant access.
Logged as `backup.restore` (critical). Backups made before 2026-10-29 lack Appearance settings and comment
likes/reports; restoring one leaves those empty/default.

## IndexNow (Admin → Integrations)

**Turn on IndexNow** generates a 32-character key (stored in `setting.integrations`, not secret) that the proxy
serves at `/{key}.txt`; publishing, updating or trashing a post then queues its URL for `api.indexnow.org` (job
queue, retries, production only). **Submit all pages now** queues every sitemap URL once. `INDEXNOW_KEY` in the
deployment still overrides the admin setting.

## Setup (in order) — requires manual configuration

1. **Bucket**: Cloudflare dashboard → R2 → Create bucket (e.g. `jithendar-media`, private).
2. **API token**: R2 → Manage API tokens → Object Read & Write, scoped to that bucket. Note the access key ID,
   secret and account ID.
3. **CORS** (needed for direct video/audio/PDF uploads): R2 → bucket → Settings → CORS policy → paste the
   rules from `deploy/r2/cors.json` (dashboard format: the array inside `CORSRules`), or:
   ```bash
   AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… aws s3api put-bucket-cors --bucket jithendar-media \
     --cors-configuration file://www/deploy/r2/cors.json \
     --endpoint-url https://<ACCOUNT_ID>.r2.cloudflarestorage.com --region auto
   ```
4. **Lifecycle**: R2 → bucket → Settings → Object lifecycle rules: delete `jithendar/www/tmp/` after 1 day; abort
   incomplete multipart uploads after 1 day — or `aws s3api put-bucket-lifecycle-configuration … --lifecycle-configuration file://www/deploy/r2/lifecycle.json` (same endpoint flags).
5. **Public domain** (optional, recommended for video): bucket → Settings → Custom domains → e.g. `media.jithendar.com`.
6. **Secret**: `scripts/set-media-config.sh mk4` (prompts; values never echoed), then
   `kubectl -n jithendar rollout restart deployment/jithendar-com` — or deploy normally.
7. **Verify**: Admin → System status shows "Media storage (Cloudflare R2): ok" and "Image generation (Gemini)".
   Upload an image and a short MP4 in Admin → Media; generate a cover in a draft post.

## Migrating existing S3 media

Public URLs are `/media/{id}/{name}` and never contain a storage key, so **no stored reference changes**.
Rows created before R2 are marked `s3-legacy` by migration 0004 and keep being served from the old bucket
(Admin → Storage keeps its sealed S3 settings as the read-only source) until copied.

1. Admin → Storage → **Dry run**: lists the next 25 files with old key → new key. Nothing changes.
2. **Copy next 25** (repeat until 0 remain): copies with `Content-MD5`, checks the size, switches the row,
   records `legacy_key`. Interrupted runs resume; objects already in R2 are reused. S3 objects are never deleted.
3. **Download manifest**: JSON of `{ id, oldKey, newKey, url, publicUrl, bytes, status }` for every migrated file.
4. Spot-check pages with images. Keep the S3 bucket untouched until you are satisfied.

**Rollback**: Admin → Storage → **Roll back to S3** points every migrated row at its S3 object again (R2 copies
stay and are reused if you migrate again). Code rollback: revert the commit and push (CI redeploys `:latest`); migration 0004 only
adds columns and a table, so the previous image starts and serves S3 rows (uploads it makes are labelled
`s3-legacy` by the column default). Files uploaded to R2 after the upgrade are not readable by the old image
until you roll forward again.

## Live checks still required (not run here: no R2 bucket or Gemini key in this environment)

- Real R2 upload/HEAD/GET/copy/delete, presigned PUT from a browser with the CORS policy, Range playback of a video.
- A real Gemini generation with the chosen model (and its supported aspect ratios / image sizes).
- `/_next/image` for an uploaded `/media/…` image in the cluster.
