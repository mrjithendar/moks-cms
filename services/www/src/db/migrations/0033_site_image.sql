-- Site images in R2 (lib/site-images.ts, docs/SITE_IMAGES.md): the files a site keeps under public/images/ and its
-- content refers to as /images/..., pushed through PUT /api/v1/images/<path> instead of being copied into the pod.
-- "path" is the path as pushed and as content refers to it (/images/aws-vpc/01.png). "served_path" is what pages
-- request: the same path, or the .webp twin when a PNG was stored as lossless WebP. source_sha256 is the hash of the
-- pushed file, so a push tool can skip files that have not changed.
-- Additive. Rollback: src/db/rollback/0033_site_image.down.sql (manual).
CREATE TABLE IF NOT EXISTS "site_image" (
  "path" text PRIMARY KEY NOT NULL,
  "served_path" text NOT NULL,
  "storage_key" text NOT NULL,
  "content_type" text NOT NULL,
  "size_bytes" integer NOT NULL,
  "source_bytes" integer NOT NULL,
  "source_sha256" text NOT NULL,
  "width" integer NOT NULL,
  "height" integer NOT NULL,
  "uploaded_by" text REFERENCES "user"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "site_image_served_path_unique" UNIQUE("served_path"),
  CONSTRAINT "site_image_storage_key_unique" UNIQUE("storage_key")
);
