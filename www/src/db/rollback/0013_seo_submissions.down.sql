-- Rollback for 0013_seo_submissions.sql. NEVER applied automatically. Drops the submission log only.
--   psql "$DATABASE_URL" -f src/db/rollback/0013_seo_submissions.down.sql
DROP TABLE IF EXISTS "seo_search_submissions";--> statement-breakpoint
DELETE FROM "schema_migrations" WHERE "name" = '0013_seo_submissions.sql';
