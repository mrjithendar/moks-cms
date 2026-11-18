-- Editorial calendar (owner request 2026-11-18): an item is unscheduled, scheduled or published, and scheduling it
-- schedules its draft post to publish at that date and time. "scheduled_by" is the admin or author who scheduled it
-- (the post is scheduled in their name, as the editor's Schedule button would); "schedule_note" says why a date is
-- kept but the post is not scheduled yet (no draft yet, draft not ready, fact-check errors, invalid post).
-- Additive. Rollback: src/db/rollback/0034_calendar_schedule.down.sql (manual).
ALTER TABLE "seo_editorial_calendar" ADD COLUMN IF NOT EXISTS "scheduled_by" text REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "seo_editorial_calendar" ADD COLUMN IF NOT EXISTS "schedule_note" text;
