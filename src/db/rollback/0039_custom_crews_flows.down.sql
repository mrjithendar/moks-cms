-- Manual rollback of 0039_custom_crews_flows.sql (never applied automatically). Custom crews and flows are lost;
-- schedules that start custom_flow then fail with "no custom flow".
DROP TABLE IF EXISTS "seo_custom_flows";--> statement-breakpoint
DROP TABLE IF EXISTS "seo_custom_crews";--> statement-breakpoint
DELETE FROM "schema_migrations" WHERE "name" = '0039_custom_crews_flows.sql';
