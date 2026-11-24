-- CrewAI console reports (owner brief 2026-11-24, D-102). One report table, not two: seo_reports (0011) keeps the weekly
-- and monthly SEO briefings (period_type weekly|monthly, `request` null) and now also holds the reports made in the
-- CrewAI console and in SEO-AI Reports: any date range (period_type = the preset: today, last_7_days, custom, …), the
-- categories, crews, flows and sources chosen (`request`), a lifecycle (queued → running → completed | failed |
-- cancelled), progress, the files stored in R2 (PDF, HTML, JSON, CSV: key, size, type), the run of report_flow that
-- analysed it, its LLM tokens and cost, who asked, and when it expires. Rows are never shared between sites: every
-- console report carries its tenant and site, and every read filters on the site.
--   seo_report_deliveries   every email of a report: recipient, attachment or link, status (queued, sent, failed,
--                           retried), attempts and the error. A deleted report's deliveries go with it (ON DELETE
--                           CASCADE; reports are soft-deleted first, so that only happens on purge); the audit log
--                           keeps every send.
-- The weekly/monthly uniqueness stays, for the briefings only (a partial index replaces the table constraint, so a
-- console report can cover the same dates). Nothing is deleted. Rollback: src/db/rollback/0043_crewai_reports.down.sql.
ALTER TABLE "seo_reports" ADD COLUMN IF NOT EXISTS "title" text CHECK (char_length("title") <= 160);--> statement-breakpoint
ALTER TABLE "seo_reports" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'completed' NOT NULL CHECK ("status" IN ('queued', 'running', 'completed', 'failed', 'cancelled'));--> statement-breakpoint
ALTER TABLE "seo_reports" ADD COLUMN IF NOT EXISTS "categories" text[] DEFAULT '{}'::text[] NOT NULL CHECK (cardinality("categories") <= 30);--> statement-breakpoint
ALTER TABLE "seo_reports" ADD COLUMN IF NOT EXISTS "request" jsonb CHECK ("request" IS NULL OR jsonb_typeof("request") = 'object');--> statement-breakpoint
ALTER TABLE "seo_reports" ADD COLUMN IF NOT EXISTS "request_hash" text;--> statement-breakpoint
ALTER TABLE "seo_reports" ADD COLUMN IF NOT EXISTS "progress" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "seo_reports" ADD COLUMN IF NOT EXISTS "files" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "seo_reports" ADD COLUMN IF NOT EXISTS "error" text CHECK (char_length("error") <= 1000);--> statement-breakpoint
ALTER TABLE "seo_reports" ADD COLUMN IF NOT EXISTS "warnings" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "seo_reports" ADD COLUMN IF NOT EXISTS "run_id" uuid;--> statement-breakpoint
ALTER TABLE "seo_reports" ADD COLUMN IF NOT EXISTS "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "seo_reports" ADD COLUMN IF NOT EXISTS "created_by" text;--> statement-breakpoint
ALTER TABLE "seo_reports" ADD COLUMN IF NOT EXISTS "created_by_id" text;--> statement-breakpoint
ALTER TABLE "seo_reports" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "seo_reports" ADD COLUMN IF NOT EXISTS "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "seo_reports" ADD COLUMN IF NOT EXISTS "finished_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "seo_reports" ADD COLUMN IF NOT EXISTS "duration_ms" integer;--> statement-breakpoint
ALTER TABLE "seo_reports" ADD COLUMN IF NOT EXISTS "llm_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "seo_reports" ADD COLUMN IF NOT EXISTS "llm_cost_usd" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "seo_reports" ADD COLUMN IF NOT EXISTS "tenant_id" text;--> statement-breakpoint
ALTER TABLE "seo_reports" ADD COLUMN IF NOT EXISTS "site_id" text;--> statement-breakpoint
ALTER TABLE "seo_reports" ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "seo_reports" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;--> statement-breakpoint
-- Existing briefings: created when generated.
UPDATE "seo_reports" SET "created_at" = "generated_at" WHERE "request" IS NULL AND "created_at" > "generated_at";--> statement-breakpoint
ALTER TABLE "seo_reports" DROP CONSTRAINT IF EXISTS "seo_reports_period_type_period_start_key";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "seo_reports_briefing_period_uq" ON "seo_reports" ("period_type", "period_start") WHERE "request" IS NULL;--> statement-breakpoint
-- One open report per site and request (the same dates, categories, crews, flows and sources): asking again while one
-- is queued or running returns it.
CREATE UNIQUE INDEX IF NOT EXISTS "seo_reports_one_open_uq" ON "seo_reports" ("site_id", "request_hash") WHERE "status" IN ('queued', 'running') AND "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_reports_site_created_idx" ON "seo_reports" ("site_id", "created_at" DESC) WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_reports_run_idx" ON "seo_reports" ("run_id") WHERE "run_id" IS NOT NULL;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "seo_report_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL REFERENCES "seo_reports"("id") ON DELETE CASCADE,
	"recipient" text NOT NULL CHECK (char_length("recipient") BETWEEN 3 AND 254),
	"status" text DEFAULT 'queued' NOT NULL CHECK ("status" IN ('queued', 'sent', 'failed', 'retried')),
	"mode" text DEFAULT 'attachment' NOT NULL CHECK ("mode" IN ('attachment', 'link')),
	"subject" text DEFAULT '' NOT NULL CHECK (char_length("subject") <= 300),
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text CHECK (char_length("error") <= 500),
	"provider" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_report_deliveries_report_idx" ON "seo_report_deliveries" ("report_id", "created_at" DESC);
