-- Manual rollback of 0037_crewai_schedules_crews.sql (never applied automatically). Schedules and crew configuration
-- versions are lost: export them first (CrewAI console → Import / export). Without the table the seo-agent's dispatcher
-- answers 503 and starts nothing, so put the per-flow CronJobs back before running this; the crews use the code's
-- defaults.
DROP TABLE IF EXISTS "seo_crew_configs";--> statement-breakpoint
DROP TABLE IF EXISTS "seo_flow_schedules";--> statement-breakpoint
DELETE FROM "schema_migrations" WHERE "name" = '0037_crewai_schedules_crews.sql';
