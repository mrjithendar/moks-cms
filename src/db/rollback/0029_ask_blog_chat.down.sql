-- Manual rollback of 0029_ask_blog_chat.sql (never applied automatically). Reader feedback on answers is lost; the
-- seo-agent goes back to writing rows without the new columns after its next restart.
DROP INDEX IF EXISTS "seo_ask_log_feedback_token_idx";--> statement-breakpoint
ALTER TABLE "seo_ask_log" DROP COLUMN IF EXISTS "feedback_at";--> statement-breakpoint
ALTER TABLE "seo_ask_log" DROP COLUMN IF EXISTS "feedback";--> statement-breakpoint
ALTER TABLE "seo_ask_log" DROP COLUMN IF EXISTS "feedback_token";--> statement-breakpoint
ALTER TABLE "seo_ask_log" DROP COLUMN IF EXISTS "standalone";--> statement-breakpoint
DELETE FROM "schema_migrations" WHERE "name" = '0029_ask_blog_chat.sql';
