-- Manual rollback of 0017_news_desk.sql (never applied automatically). Deletes every news job, source, profile, run,
-- log, candidate, model and feedback row. CMS posts and seo_drafts created by the news desk are NOT touched (they are
-- ordinary CMS drafts/posts); cover images stay in the media library. Run newest first.
DROP TABLE IF EXISTS "news_models";--> statement-breakpoint
DROP TABLE IF EXISTS "news_labels";--> statement-breakpoint
DROP TABLE IF EXISTS "news_feedback";--> statement-breakpoint
DROP TABLE IF EXISTS "news_images";--> statement-breakpoint
DROP TABLE IF EXISTS "news_articles";--> statement-breakpoint
DROP TABLE IF EXISTS "news_candidates";--> statement-breakpoint
DROP TABLE IF EXISTS "news_items";--> statement-breakpoint
DROP TABLE IF EXISTS "news_clusters";--> statement-breakpoint
DROP TABLE IF EXISTS "news_run_logs";--> statement-breakpoint
DROP TABLE IF EXISTS "news_run_steps";--> statement-breakpoint
DROP TABLE IF EXISTS "news_runs";--> statement-breakpoint
DROP TABLE IF EXISTS "news_topics";--> statement-breakpoint
DROP TABLE IF EXISTS "news_job_versions";--> statement-breakpoint
DROP TABLE IF EXISTS "news_jobs";--> statement-breakpoint
DROP TABLE IF EXISTS "news_image_profiles";--> statement-breakpoint
DROP TABLE IF EXISTS "news_writing_profiles";--> statement-breakpoint
DROP TABLE IF EXISTS "news_sources";--> statement-breakpoint
DELETE FROM "schema_migrations" WHERE "name" = '0017_news_desk.sql';
