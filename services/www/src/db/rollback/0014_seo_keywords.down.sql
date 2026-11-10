-- Rollback for 0014_seo_keywords.sql. NEVER applied automatically. Drops keyword caches, tracked keywords and saved views.
--   psql "$DATABASE_URL" -f src/db/rollback/0014_seo_keywords.down.sql
DROP INDEX IF EXISTS "seo_gsc_query_daily_type_date_query_idx";--> statement-breakpoint
DROP TABLE IF EXISTS "seo_saved_views";--> statement-breakpoint
DROP TABLE IF EXISTS "seo_keyword_ignores";--> statement-breakpoint
DROP TABLE IF EXISTS "seo_tracked_keywords";--> statement-breakpoint
DROP TABLE IF EXISTS "seo_query_clusters";--> statement-breakpoint
DROP TABLE IF EXISTS "seo_query_intents";--> statement-breakpoint
DELETE FROM "schema_migrations" WHERE "name" = '0014_seo_keywords.sql';
