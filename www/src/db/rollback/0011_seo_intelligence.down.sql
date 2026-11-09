-- Rollback for 0011_seo_intelligence.sql. NEVER applied automatically (src/db/migrate.ts reads only
-- src/db/migrations). Drops the SEO tables and their data only; no other table is touched. Owner-approved, manual:
--   psql "$DATABASE_URL" -f src/db/rollback/0011_seo_intelligence.down.sql
-- Take a backup first (Admin → Backups). Also removes the migration's ledger entry so it can be re-applied.
DROP TABLE IF EXISTS "seo_llm_cache";--> statement-breakpoint
DROP TABLE IF EXISTS "seo_job_locks";--> statement-breakpoint
DROP TABLE IF EXISTS "seo_technical_issues";--> statement-breakpoint
DROP TABLE IF EXISTS "seo_technical_scans";--> statement-breakpoint
DROP TABLE IF EXISTS "seo_reports";--> statement-breakpoint
DROP TABLE IF EXISTS "seo_article_optimizations";--> statement-breakpoint
DROP TABLE IF EXISTS "seo_editorial_calendar";--> statement-breakpoint
DROP TABLE IF EXISTS "seo_internal_link_suggestions";--> statement-breakpoint
DROP TABLE IF EXISTS "seo_content_audits";--> statement-breakpoint
DROP TABLE IF EXISTS "seo_recommendation_evidence";--> statement-breakpoint
DROP TABLE IF EXISTS "seo_recommendations";--> statement-breakpoint
DROP TABLE IF EXISTS "seo_url_map";--> statement-breakpoint
DROP TABLE IF EXISTS "seo_ga4_page_daily";--> statement-breakpoint
DROP TABLE IF EXISTS "seo_gsc_query_daily";--> statement-breakpoint
DROP TABLE IF EXISTS "seo_gsc_page_daily";--> statement-breakpoint
DROP TABLE IF EXISTS "seo_gsc_daily_totals";--> statement-breakpoint
DROP TABLE IF EXISTS "seo_sync_jobs";--> statement-breakpoint
DROP TABLE IF EXISTS "seo_integrations";--> statement-breakpoint
DELETE FROM "schema_migrations" WHERE "name" = '0011_seo_intelligence.sql';
