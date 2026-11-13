DROP TABLE IF EXISTS "seo_topic_candidates";--> statement-breakpoint
DROP TABLE IF EXISTS "seo_topic_signals";
--> statement-breakpoint
DELETE FROM "setting" WHERE "key" = 'topics';--> statement-breakpoint
DELETE FROM "schema_migrations" WHERE "name" = '0029_seo_topics.sql';
