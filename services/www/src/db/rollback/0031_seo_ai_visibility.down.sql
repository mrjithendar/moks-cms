-- Manual rollback of 0031_seo_ai_visibility.sql (never applied automatically). Tracked prompts and answer history are lost.
DROP TABLE IF EXISTS "seo_ai_answers";--> statement-breakpoint
DROP TABLE IF EXISTS "seo_ai_prompts";--> statement-breakpoint
DELETE FROM "schema_migrations" WHERE "name" = '0031_seo_ai_visibility.sql';
