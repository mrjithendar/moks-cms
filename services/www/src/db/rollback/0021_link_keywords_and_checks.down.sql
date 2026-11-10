DROP TABLE IF EXISTS "seo_link_checks";--> statement-breakpoint
DROP TABLE IF EXISTS "seo_link_keywords";--> statement-breakpoint
DELETE FROM "schema_migrations" WHERE "name" = '0021_link_keywords_and_checks.sql';
