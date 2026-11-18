-- Manual rollback of 0023_contact_enquiry.sql (never applied automatically; enquiries stay as plain messages).
DROP INDEX IF EXISTS "contact_kind_idx";--> statement-breakpoint
ALTER TABLE "contact_message" DROP COLUMN IF EXISTS "details";--> statement-breakpoint
ALTER TABLE "contact_message" DROP COLUMN IF EXISTS "kind";--> statement-breakpoint
DELETE FROM "schema_migrations" WHERE "name" = '0023_contact_enquiry.sql';
