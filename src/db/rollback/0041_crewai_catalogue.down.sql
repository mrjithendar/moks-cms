-- Manual rollback of 0041_crewai_catalogue.sql (never applied automatically). The catalogue's categories, tags,
-- objectives, switches of code flows and every crew or flow made after 0041 are lost; seo_custom_crews and
-- seo_custom_flows (left untouched by 0041) still hold what existed before it. Deploy the web app before 0041 first.
DROP TRIGGER IF EXISTS "news_jobs_crewai_flow" ON "news_jobs";--> statement-breakpoint
DROP FUNCTION IF EXISTS "crewai_content_flow_sync"();--> statement-breakpoint
DROP INDEX IF EXISTS "seo_flow_runs_target_idx";--> statement-breakpoint
DROP TABLE IF EXISTS "crewai_spec_versions";--> statement-breakpoint
DROP TABLE IF EXISTS "crewai_flows";--> statement-breakpoint
DROP TABLE IF EXISTS "crewai_crews";--> statement-breakpoint
DROP TABLE IF EXISTS "crewai_categories";--> statement-breakpoint
DELETE FROM "schema_migrations" WHERE "name" = '0041_crewai_catalogue.sql';
