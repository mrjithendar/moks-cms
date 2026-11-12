-- Manual rollback of 0027_bundled_import_and_video_generation.sql (never applied automatically). Posts already
-- created from files stay; rows of generated videos lose their kind and are indistinguishable from images.
DROP TABLE IF EXISTS "bundled_import";--> statement-breakpoint
ALTER TABLE "image_generation" DROP COLUMN IF EXISTS "duration_seconds";--> statement-breakpoint
ALTER TABLE "image_generation" DROP COLUMN IF EXISTS "operation";--> statement-breakpoint
ALTER TABLE "image_generation" DROP COLUMN IF EXISTS "kind";--> statement-breakpoint
DELETE FROM "schema_migrations" WHERE "name" = '0027_bundled_import_and_video_generation.sql';
