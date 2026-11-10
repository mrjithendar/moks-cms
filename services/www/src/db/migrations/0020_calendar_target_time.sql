-- Editorial calendar: optional time of day for a scheduled item, in the editorial time zone (Asia/Kolkata, IST).
-- Additive only. Rollback: src/db/rollback/0020_calendar_target_time.down.sql (manual).
ALTER TABLE "seo_editorial_calendar" ADD COLUMN IF NOT EXISTS "target_time" time;
