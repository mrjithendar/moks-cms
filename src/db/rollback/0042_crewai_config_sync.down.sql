-- Manual rollback of 0042_crewai_config_sync.sql (never applied automatically). The history of configuration imports
-- and exports, their rollback snapshots and the drift baseline are lost; the configuration itself is unchanged.
-- Deploy the web app before 0042 first.
DROP TABLE IF EXISTS "crewai_config_syncs";--> statement-breakpoint
DELETE FROM "schema_migrations" WHERE "name" = '0042_crewai_config_sync.sql';
