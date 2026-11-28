-- Full site backups (D-108): backup_run records every backup operation, not only backups. `operation` says which
-- (backup | verify | restore); a backup's `backup_type` is full | database | prerestore (legacy for the content-only zips
-- of format 1). Each row goes pending → running → completed | failed | cancelled ("success" and "partial" of format 1
-- become "completed": there is one destination since 2026-11-18). `progress` is what the running operation is doing
-- (phase, counts, bytes) for the admin page; `detail` keeps the outcome (the manifest summary of a backup, the checks
-- of a verification, what a restore put back); `sha256` is the archive's own checksum; `cancel_requested` asks a
-- running operation to stop at its next step; `requested_by_ref` links a row to what asked for it (a CrewAI run).
-- size_bytes becomes bigint: a full backup with the media library can pass 2 GiB. Nothing is deleted.
-- Rollback: src/db/rollback/0044_backup_operations.down.sql.
ALTER TABLE "backup_run" ADD COLUMN IF NOT EXISTS "operation" text DEFAULT 'backup' NOT NULL CHECK ("operation" IN ('backup', 'verify', 'restore'));--> statement-breakpoint
ALTER TABLE "backup_run" ADD COLUMN IF NOT EXISTS "backup_type" text CHECK ("backup_type" IS NULL OR "backup_type" IN ('full', 'database', 'prerestore', 'legacy'));--> statement-breakpoint
ALTER TABLE "backup_run" ADD COLUMN IF NOT EXISTS "progress" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "backup_run" ADD COLUMN IF NOT EXISTS "detail" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "backup_run" ADD COLUMN IF NOT EXISTS "sha256" text;--> statement-breakpoint
ALTER TABLE "backup_run" ADD COLUMN IF NOT EXISTS "error" text;--> statement-breakpoint
ALTER TABLE "backup_run" ADD COLUMN IF NOT EXISTS "cancel_requested" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "backup_run" ADD COLUMN IF NOT EXISTS "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "backup_run" ADD COLUMN IF NOT EXISTS "requested_by_ref" text;--> statement-breakpoint
ALTER TABLE "backup_run" ALTER COLUMN "size_bytes" TYPE bigint;--> statement-breakpoint
UPDATE "backup_run" SET "status" = 'completed', "backup_type" = 'legacy' WHERE "status" IN ('success', 'partial');--> statement-breakpoint
UPDATE "backup_run" SET "backup_type" = 'legacy' WHERE "backup_type" IS NULL;--> statement-breakpoint
-- A run left "running" by format 1 (its pod went away) never finishes now.
UPDATE "backup_run" SET "status" = 'failed', "error" = 'interrupted before the upgrade to full site backups', "finished_at" = COALESCE("finished_at", now()) WHERE "status" = 'running';--> statement-breakpoint
ALTER TABLE "backup_run" ADD CONSTRAINT "backup_run_status_check" CHECK ("status" IN ('pending', 'running', 'completed', 'failed', 'cancelled'));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "backup_run_filename_idx" ON "backup_run" ("filename");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "backup_run_active_idx" ON "backup_run" ("status") WHERE "status" IN ('pending', 'running');
