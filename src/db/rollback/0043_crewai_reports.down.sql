-- Manual rollback of 0043_crewai_reports.sql (never applied automatically). Deploy the web app before 0043 first. The
-- console reports' rows are deleted (their files stay in R2 under jithendar/www/reports/<tenant>/<site>/…; remove
-- them with the bucket's own tools if wanted) and the email history goes; the weekly and monthly briefings are kept.
DROP TABLE IF EXISTS "seo_report_deliveries";--> statement-breakpoint
DELETE FROM "seo_reports" WHERE "request" IS NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "seo_reports_run_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "seo_reports_site_created_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "seo_reports_one_open_uq";--> statement-breakpoint
DROP INDEX IF EXISTS "seo_reports_briefing_period_uq";--> statement-breakpoint
ALTER TABLE "seo_reports" ADD CONSTRAINT "seo_reports_period_type_period_start_key" UNIQUE ("period_type", "period_start");--> statement-breakpoint
ALTER TABLE "seo_reports" DROP COLUMN IF EXISTS "title", DROP COLUMN IF EXISTS "status", DROP COLUMN IF EXISTS "categories", DROP COLUMN IF EXISTS "request", DROP COLUMN IF EXISTS "request_hash", DROP COLUMN IF EXISTS "progress", DROP COLUMN IF EXISTS "files", DROP COLUMN IF EXISTS "error", DROP COLUMN IF EXISTS "warnings", DROP COLUMN IF EXISTS "run_id", DROP COLUMN IF EXISTS "attempts", DROP COLUMN IF EXISTS "created_by", DROP COLUMN IF EXISTS "created_by_id", DROP COLUMN IF EXISTS "created_at", DROP COLUMN IF EXISTS "started_at", DROP COLUMN IF EXISTS "finished_at", DROP COLUMN IF EXISTS "duration_ms", DROP COLUMN IF EXISTS "llm_tokens", DROP COLUMN IF EXISTS "llm_cost_usd", DROP COLUMN IF EXISTS "tenant_id", DROP COLUMN IF EXISTS "site_id", DROP COLUMN IF EXISTS "expires_at", DROP COLUMN IF EXISTS "deleted_at";--> statement-breakpoint
DELETE FROM "schema_migrations" WHERE "name" = '0043_crewai_reports.sql';
