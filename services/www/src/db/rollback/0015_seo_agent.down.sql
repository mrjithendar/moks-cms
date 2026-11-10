-- Manual rollback of 0015_seo_agent.sql (never applied automatically; deletes v3 run records, approvals, new-article
-- documents and the Ask-the-Blog log). Run newest first. The seo-agent's own tables are dropped separately:
--   drop table if exists seo_article_chunks;
--   drop table if exists checkpoint_writes, checkpoint_blobs, checkpoints, checkpoint_migrations;
DROP TABLE IF EXISTS "seo_ask_gaps";--> statement-breakpoint
DROP TABLE IF EXISTS "seo_ask_log";--> statement-breakpoint
DROP TABLE IF EXISTS "seo_draft_approvals";--> statement-breakpoint
ALTER TABLE "seo_drafts" DROP COLUMN IF EXISTS "calendar_id";--> statement-breakpoint
ALTER TABLE "seo_drafts" DROP COLUMN IF EXISTS "thread_id";--> statement-breakpoint
ALTER TABLE "seo_drafts" DROP COLUMN IF EXISTS "document";--> statement-breakpoint
ALTER TABLE "seo_drafts" DROP COLUMN IF EXISTS "kind";--> statement-breakpoint
DROP TABLE IF EXISTS "seo_agent_runs";--> statement-breakpoint
DELETE FROM "schema_migrations" WHERE "name" = '0015_seo_agent.sql';
