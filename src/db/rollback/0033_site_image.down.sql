-- Manual rollback of 0033_site_image.sql (never applied automatically). It forgets which site images are in R2, so
-- /images/... is served from public/images/ on disk again: put the files back there first (the site's content image),
-- or pages show "Image unavailable". The objects in R2 under jithendar/www/site-images/ are not deleted.
DROP TABLE IF EXISTS "site_image";--> statement-breakpoint
DELETE FROM "schema_migrations" WHERE "name" = '0033_site_image.sql';
