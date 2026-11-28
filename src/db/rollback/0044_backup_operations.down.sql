-- Manual rollback of 0044_backup_operations.sql (never applied automatically). Deploy the web app before 0044 first.
-- Verify and restore records are deleted; backups keep their row with the format 1 statuses. The archives themselves
-- stay in the bucket under jithendar/backups/ (format 1 does not list the new names: remove them with the bucket's own
-- tools if wanted).
DELETE FROM "backup_run" WHERE "operation" <> 'backup';--> statement-breakpoint
DROP INDEX IF EXISTS "backup_run_active_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "backup_run_filename_idx";--> statement-breakpoint
ALTER TABLE "backup_run" DROP CONSTRAINT IF EXISTS "backup_run_status_check";--> statement-breakpoint
UPDATE "backup_run" SET "status" = 'success' WHERE "status" = 'completed';--> statement-breakpoint
UPDATE "backup_run" SET "status" = 'failed' WHERE "status" IN ('pending', 'running', 'cancelled');--> statement-breakpoint
ALTER TABLE "backup_run" ALTER COLUMN "size_bytes" TYPE integer USING LEAST("size_bytes", 2147483647)::integer;--> statement-breakpoint
ALTER TABLE "backup_run" DROP COLUMN IF EXISTS "operation", DROP COLUMN IF EXISTS "backup_type", DROP COLUMN IF EXISTS "progress", DROP COLUMN IF EXISTS "detail", DROP COLUMN IF EXISTS "sha256", DROP COLUMN IF EXISTS "error", DROP COLUMN IF EXISTS "cancel_requested", DROP COLUMN IF EXISTS "attempts", DROP COLUMN IF EXISTS "requested_by_ref";--> statement-breakpoint
DELETE FROM "schema_migrations" WHERE "name" = '0044_backup_operations.sql';
