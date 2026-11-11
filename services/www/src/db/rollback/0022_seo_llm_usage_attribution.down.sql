-- Manual rollback of 0022_seo_llm_usage_attribution.sql (never applied automatically; drops only the attribution columns).
DROP INDEX IF EXISTS "seo_llm_usage_run_idx";--> statement-breakpoint
ALTER TABLE "seo_llm_usage" DROP COLUMN IF EXISTS "agent";--> statement-breakpoint
ALTER TABLE "seo_llm_usage" DROP COLUMN IF EXISTS "run_id";--> statement-breakpoint
DELETE FROM "schema_migrations" WHERE "name" = '0022_seo_llm_usage_attribution.sql';
