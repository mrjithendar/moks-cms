-- 1) Ledger of content/{blog,news,projects}/*.mdx files that have been turned into posts (lib/bundled-posts.ts).
--    New files become drafts automatically at server start; the ledger stops a post that was permanently deleted
--    from being created again on the next start.
-- 2) image_generation also records generated videos (lib/video-generation.ts): kind, the provider's long-running
--    operation, the clip length, and where an accepted clip went (lib/video-destinations.ts: r2, or an external
--    streaming service and the video's id there).
-- Rollback: src/db/rollback/0027_bundled_import_and_video_generation.down.sql (manual).
CREATE TABLE IF NOT EXISTS "bundled_import" (
  "collection" text NOT NULL,
  "slug" text NOT NULL,
  "imported_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "bundled_import_pk" PRIMARY KEY ("collection", "slug")
);--> statement-breakpoint
ALTER TABLE "image_generation" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'image' NOT NULL;--> statement-breakpoint
ALTER TABLE "image_generation" ADD COLUMN IF NOT EXISTS "operation" text;--> statement-breakpoint
ALTER TABLE "image_generation" ADD COLUMN IF NOT EXISTS "duration_seconds" integer;--> statement-breakpoint
ALTER TABLE "image_generation" ADD COLUMN IF NOT EXISTS "destination" text;--> statement-breakpoint
ALTER TABLE "image_generation" ADD COLUMN IF NOT EXISTS "external_id" text;
