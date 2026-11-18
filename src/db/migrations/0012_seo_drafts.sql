-- SEO platform v2, Phase 1–2: Claude-drafted change sets, the review queue and LLM usage/cost accounting.
-- Purely additive. Rollback: src/db/rollback/0012_seo_drafts.down.sql (manual).
-- A draft never touches `post`: it holds a change set against a base version. Approval publishes it through the
-- CMS's own update path (revision + audit), see docs/seo/DECISIONS.md D-21.
CREATE TABLE IF NOT EXISTS "seo_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"article_id" uuid NOT NULL REFERENCES "post"("id") ON DELETE CASCADE,
	"collection" text NOT NULL,
	-- generating | ready_for_review | generation_failed | scheduled | publishing | published | rejected | superseded | rolled_back
	"status" text DEFAULT 'generating' NOT NULL,
	"base_version" integer NOT NULL,
	"base_snapshot" jsonb NOT NULL,
	"recommendation_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"categories" text[] DEFAULT '{}'::text[] NOT NULL,
	"changes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"summary" text,
	"failure_reason" text,
	"model" text,
	"prompt_version" text,
	"batch_id" text,
	-- Recommendations being merged into this (open) draft by an in-flight batch request.
	"pending_recommendation_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"trigger" text DEFAULT 'manual' NOT NULL,
	"generated_at" timestamp with time zone,
	"decided_by" text,
	"decided_by_id" text,
	"decided_at" timestamp with time zone,
	"reject_reason" text,
	"scheduled_for" timestamp with time zone,
	"published_version" integer,
	"previous_version" integer,
	"substantive" boolean,
	"verification" jsonb,
	"baseline_metrics" jsonb,
	"metrics_28d" jsonb,
	"metrics_56d" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
-- One open draft per article: a new recommendation for the same article is merged into it.
CREATE UNIQUE INDEX IF NOT EXISTS "seo_drafts_one_open_idx" ON "seo_drafts" ("article_id") WHERE "status" IN ('generating', 'ready_for_review', 'generation_failed', 'scheduled', 'publishing');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_drafts_status_idx" ON "seo_drafts" ("status", "created_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_drafts_article_idx" ON "seo_drafts" ("article_id", "created_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_drafts_batch_idx" ON "seo_drafts" ("batch_id") WHERE "batch_id" IS NOT NULL;--> statement-breakpoint
-- One row per model call (sync or batch result): tokens, cost, latency, request id. Month-to-date spend and the
-- hard budget cap are computed from this table.
CREATE TABLE IF NOT EXISTS "seo_llm_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"purpose" text NOT NULL,
	"prompt_version" text NOT NULL,
	"mode" text DEFAULT 'sync' NOT NULL,
	"request_id" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"latency_ms" integer,
	"outcome" text NOT NULL,
	"error_code" text,
	"draft_id" uuid REFERENCES "seo_drafts"("id") ON DELETE SET NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_llm_usage_at_idx" ON "seo_llm_usage" ("at" DESC);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "seo_llm_batches" (
	"id" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"model" text NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL,
	"estimated_cost_usd" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"error" text
);
