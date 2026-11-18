-- Manual rollback of 0036_flow_run_history.sql (never applied automatically). Run numbers, steps, logs and transcripts
-- are lost; the seo-agent sees the tables missing and stops writing them (app/run_history.py), flows run as before.
DROP TRIGGER IF EXISTS "seo_flow_runs_number" ON "seo_flow_runs";--> statement-breakpoint
DROP FUNCTION IF EXISTS "seo_flow_run_number"();--> statement-breakpoint
DROP TABLE IF EXISTS "seo_flow_run_calls";--> statement-breakpoint
DROP TABLE IF EXISTS "seo_flow_run_logs";--> statement-breakpoint
DROP TABLE IF EXISTS "seo_flow_run_steps";--> statement-breakpoint
DROP TABLE IF EXISTS "seo_flow_run_counters";--> statement-breakpoint
DROP INDEX IF EXISTS "seo_flow_runs_number_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "seo_flow_runs_started_idx";--> statement-breakpoint
ALTER TABLE "seo_flow_runs" DROP COLUMN IF EXISTS "run_number";--> statement-breakpoint
DELETE FROM "schema_migrations" WHERE "name" = '0036_flow_run_history.sql';
