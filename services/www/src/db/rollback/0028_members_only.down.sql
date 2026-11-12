-- Manual rollback of 0028_members_only.sql (never applied automatically). Every members-only article becomes fully public.
ALTER TABLE "post" DROP COLUMN IF EXISTS "preview_percent";--> statement-breakpoint
ALTER TABLE "post" DROP COLUMN IF EXISTS "members_only";--> statement-breakpoint
DELETE FROM "schema_migrations" WHERE "name" = '0028_members_only.sql';
