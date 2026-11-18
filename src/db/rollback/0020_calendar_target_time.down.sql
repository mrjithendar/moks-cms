ALTER TABLE "seo_editorial_calendar" DROP COLUMN IF EXISTS "target_time";--> statement-breakpoint
DELETE FROM "schema_migrations" WHERE "name" = '0020_calendar_target_time.sql';
