-- Rollback for 0012_seo_drafts.sql. NEVER applied automatically (src/db/migrate.ts reads only src/db/migrations).
-- Drops the v2 draft/usage tables and their data only. Published changes stay published: they are ordinary post
-- revisions. Run the rollbacks of LATER migrations first (0013+ reference seo_drafts). Owner-approved, manual:
--   psql "$DATABASE_URL" -f src/db/rollback/0012_seo_drafts.down.sql
DROP TABLE IF EXISTS "seo_llm_usage";--> statement-breakpoint
DROP TABLE IF EXISTS "seo_llm_batches";--> statement-breakpoint
DROP TABLE IF EXISTS "seo_drafts";--> statement-breakpoint
DELETE FROM "schema_migrations" WHERE "name" = '0012_seo_drafts.sql';
