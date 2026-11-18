-- Manual rollback of 0018_seo_v5_rag.sql (never applied automatically; drops only the v5 retrieval log columns).
ALTER TABLE "seo_ask_log" DROP COLUMN IF EXISTS "retrieval";--> statement-breakpoint
ALTER TABLE "seo_ask_log" DROP COLUMN IF EXISTS "prompt_version";--> statement-breakpoint
DELETE FROM "schema_migrations" WHERE "name" = '0018_seo_v5_rag.sql';
