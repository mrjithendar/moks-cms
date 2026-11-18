-- Manual rollback of 0034_calendar_schedule.sql (never applied automatically). Posts already scheduled stay scheduled.
ALTER TABLE "seo_editorial_calendar" DROP COLUMN IF EXISTS "schedule_note";--> statement-breakpoint
ALTER TABLE "seo_editorial_calendar" DROP COLUMN IF EXISTS "scheduled_by";--> statement-breakpoint
DELETE FROM "schema_migrations" WHERE "name" = '0034_calendar_schedule.sql';
