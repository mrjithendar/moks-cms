-- Manual rollback of 0030_seo_dataforseo.sql (never applied automatically). Keyword metrics, rank history and backlink
-- snapshots are lost; the keyword pages fall back to Search Console data only.
DROP TABLE IF EXISTS "seo_referring_domains";--> statement-breakpoint
DROP TABLE IF EXISTS "seo_backlink_snapshots";--> statement-breakpoint
DROP TABLE IF EXISTS "seo_serp_ranks";--> statement-breakpoint
DROP TABLE IF EXISTS "seo_keyword_metrics";--> statement-breakpoint
DELETE FROM "schema_migrations" WHERE "name" = '0030_seo_dataforseo.sql';
