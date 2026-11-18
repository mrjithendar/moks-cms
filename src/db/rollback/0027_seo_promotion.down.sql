DROP TABLE IF EXISTS "seo_content_ideas";--> statement-breakpoint
DROP TABLE IF EXISTS "seo_promo_opportunities";--> statement-breakpoint
DROP TABLE IF EXISTS "seo_promo_signals";--> statement-breakpoint
DELETE FROM "setting" WHERE "key" = 'promotion';--> statement-breakpoint
DELETE FROM "schema_migrations" WHERE "name" = '0027_seo_promotion.sql';
