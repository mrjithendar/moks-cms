-- AI News Desk (docs/news/ARCHITECTURE.md). Purely additive: no existing table or column changes.
-- Rollback: src/db/rollback/0017_news_desk.down.sql (manual, owner-approved).
--
-- Who writes what:
--   web admin UI  → news_sources, news_jobs, news_job_versions, news_writing_profiles, news_image_profiles, news_topics,
--                   news_feedback (review decisions), news_articles.review_outcome
--   seo-agent     → news_items, news_clusters, news_candidates, news_runs, news_run_steps, news_run_logs, news_articles,
--                   news_images, news_labels, news_models, news_feedback (performance)
-- CMS drafts are created only through the existing callback path (CMS draft post + seo_drafts kind new_article), and
-- publishing only through the existing approval → publish_flow path. Nothing here can publish.
-- Embeddings are real[] (not pgvector): the extension is optional in this cluster (docs/seo/MANUAL_SETUP.md §13) and the
-- news window is small enough to compare in memory (docs/news/DECISIONS.md N-02).

CREATE TABLE IF NOT EXISTS "news_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL CHECK ("type" IN ('rss', 'atom', 'json_api', 'github_releases', 'sitemap', 'html_allowlisted')),
	"url" text NOT NULL,
	"topic_hints" text[] DEFAULT '{}'::text[] NOT NULL,
	"credibility" real DEFAULT 0.7 NOT NULL CHECK ("credibility" >= 0 AND "credibility" <= 1),
	"fetch_interval_minutes" integer DEFAULT 60 NOT NULL CHECK ("fetch_interval_minutes" BETWEEN 5 AND 10080),
	"enabled" boolean DEFAULT false NOT NULL,
	"terms_note" text,
	"etag" text,
	"last_modified" text,
	"last_fetch_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_status" text,
	"last_http_status" integer,
	"error_count" integer DEFAULT 0 NOT NULL,
	"consecutive_errors" integer DEFAULT 0 NOT NULL,
	"fetch_count" integer DEFAULT 0 NOT NULL,
	"avg_items" real DEFAULT 0 NOT NULL,
	"items_total" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "news_sources_url_uq" ON "news_sources" ("url") WHERE "deleted_at" IS NULL;--> statement-breakpoint

-- Versioned prompt templates: one row per (key, version). status: active (the one jobs use unless they pin a version),
-- proposed (the weekly style review's suggestion, waiting for the owner), archived.
CREATE TABLE IF NOT EXISTS "news_writing_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL CHECK ("key" ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
	"version" integer NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL CHECK ("status" IN ('active', 'proposed', 'archived')),
	"system_style" text DEFAULT '' NOT NULL,
	"structure_template" text DEFAULT '' NOT NULL,
	"tone" text DEFAULT '' NOT NULL,
	"audience" text DEFAULT '' NOT NULL,
	"banned_phrases" text[] DEFAULT '{}'::text[] NOT NULL,
	"required_sections" text[] DEFAULT '{}'::text[] NOT NULL,
	"examples" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"temperature" real,
	"model" text,
	"explanation" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	UNIQUE ("key", "version")
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "news_writing_profiles_one_active" ON "news_writing_profiles" ("key") WHERE "status" = 'active';--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "news_image_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL CHECK ("key" ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
	"version" integer NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL CHECK ("status" IN ('active', 'proposed', 'archived')),
	"provider" text DEFAULT 'template' NOT NULL CHECK ("provider" IN ('template', 'gemini', 'openai')),
	"style_prompt" text DEFAULT '' NOT NULL,
	"negative_prompt" text DEFAULT '' NOT NULL,
	"aspect_ratios" text[] DEFAULT '{1200x630,1600x900}'::text[] NOT NULL,
	"palette" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"template_fallback" boolean DEFAULT true NOT NULL,
	"variants" integer DEFAULT 2 NOT NULL CHECK ("variants" BETWEEN 1 AND 4),
	"safety_rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"explanation" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	UNIQUE ("key", "version")
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "news_image_profiles_one_active" ON "news_image_profiles" ("key") WHERE "status" = 'active';--> statement-breakpoint

-- Jobs. The frequently filtered fields are columns; everything else is `config` (validated by the same schema in
-- services/www/src/lib/news/jobs.ts and services/seo-agent/app/news/config.py). `version` = the latest news_job_versions row.
CREATE TABLE IF NOT EXISTS "news_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"cron" text DEFAULT '0 7 * * *' NOT NULL,
	"timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"mode" text DEFAULT 'single_stories' NOT NULL CHECK ("mode" IN ('single_stories', 'daily_digest', 'both')),
	"writing_profile_key" text DEFAULT 'news-default' NOT NULL,
	"image_profile_key" text DEFAULT 'cover-template' NOT NULL,
	"review_priority" integer DEFAULT 50 NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "news_jobs_due_idx" ON "news_jobs" ("enabled", "next_run_at") WHERE "deleted_at" IS NULL;--> statement-breakpoint

-- Immutable snapshot of every saved job config. Rows are only ever inserted.
CREATE TABLE IF NOT EXISTS "news_job_versions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL REFERENCES "news_jobs"("id") ON DELETE CASCADE,
	"version" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"diff" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"note" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	UNIQUE ("job_id", "version")
);--> statement-breakpoint

-- Taxonomy for news: maps to the CMS's own categories (category.slug) and suggests tags; it does not duplicate them.
CREATE TABLE IF NOT EXISTS "news_topics" (
	"slug" text PRIMARY KEY NOT NULL CHECK ("slug" ~ '^[a-z0-9][a-z0-9-]{1,60}$'),
	"label" text NOT NULL,
	"category_slug" text REFERENCES "category"("slug") ON DELETE SET NULL ON UPDATE CASCADE,
	"keywords" text[] DEFAULT '{}'::text[] NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"sort" integer DEFAULT 100 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "news_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"job_id" uuid REFERENCES "news_jobs"("id") ON DELETE SET NULL,
	"job_version" integer,
	"kind" text DEFAULT 'job' NOT NULL CHECK ("kind" IN ('job', 'ingest', 'train', 'style_review', 'dispatch', 'image', 'playground')),
	"flow_run_id" uuid,
	"parent_run_id" uuid,
	"trigger" text NOT NULL CHECK ("trigger" IN ('cron', 'manual', 'dry_run', 'mcp', 'retry', 'flow')),
	"slot" text,
	"status" text DEFAULT 'queued' NOT NULL CHECK ("status" IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'paused_budget', 'skipped')),
	"dry_run" boolean DEFAULT false NOT NULL,
	"llm_enabled" boolean DEFAULT true NOT NULL,
	"counters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"image_cost_usd" double precision DEFAULT 0 NOT NULL,
	"error_summary" text,
	"correlation_id" text,
	"actor" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);--> statement-breakpoint
-- A scheduled slot runs once per job (the dispatcher can fire twice during a deploy; the second insert is a no-op).
CREATE UNIQUE INDEX IF NOT EXISTS "news_runs_slot_uq" ON "news_runs" ("job_id", "slot") WHERE "slot" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "news_runs_job_idx" ON "news_runs" ("job_id", "started_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "news_runs_status_idx" ON "news_runs" ("status", "started_at" DESC);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "news_run_steps" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL REFERENCES "news_runs"("id") ON DELETE CASCADE,
	"step" text NOT NULL,
	"seq" integer NOT NULL,
	"status" text DEFAULT 'running' NOT NULL CHECK ("status" IN ('running', 'succeeded', 'failed', 'skipped')),
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"input_count" integer,
	"output_count" integer,
	"error" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "news_run_steps_run_idx" ON "news_run_steps" ("run_id", "seq");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "news_run_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL REFERENCES "news_runs"("id") ON DELETE CASCADE,
	"step" text,
	"level" text DEFAULT 'info' NOT NULL CHECK ("level" IN ('debug', 'info', 'warning', 'error')),
	"message" text NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "news_run_logs_run_idx" ON "news_run_logs" ("run_id", "id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "news_run_logs_at_idx" ON "news_run_logs" ("at");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "news_clusters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"centroid" real[],
	"entities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cve_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"severity" real,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"item_count" integer DEFAULT 0 NOT NULL,
	"source_count" integer DEFAULT 0 NOT NULL,
	"burst" real DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'new' NOT NULL CHECK ("status" IN ('new', 'covered', 'skipped', 'drafted', 'update_candidate')),
	"topics" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"site_match" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "news_clusters_seen_idx" ON "news_clusters" ("last_seen" DESC);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "news_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL REFERENCES "news_sources"("id") ON DELETE CASCADE,
	"url" text NOT NULL,
	"url_hash" text NOT NULL,
	"title" text NOT NULL,
	"published_at" timestamp with time zone,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"excerpt" text DEFAULT '' NOT NULL CHECK (length("excerpt") <= 4000),
	"clean_text" text DEFAULT '' NOT NULL CHECK (length("clean_text") <= 20000),
	"content_hash" text NOT NULL,
	"simhash" bigint,
	"minhash" bigint[],
	"embedding" real[],
	"entities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"language" text,
	"fetch_run_id" uuid,
	"cluster_id" uuid REFERENCES "news_clusters"("id") ON DELETE SET NULL,
	"duplicate_of" uuid,
	"dedupe_reason" text CHECK ("dedupe_reason" IS NULL OR "dedupe_reason" IN ('exact', 'near', 'semantic')),
	UNIQUE ("source_id", "url_hash")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "news_items_fetched_idx" ON "news_items" ("fetched_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "news_items_hash_idx" ON "news_items" ("content_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "news_items_cluster_idx" ON "news_items" ("cluster_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "news_candidates" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL REFERENCES "news_runs"("id") ON DELETE CASCADE,
	"job_id" uuid REFERENCES "news_jobs"("id") ON DELETE SET NULL,
	"cluster_id" uuid NOT NULL REFERENCES "news_clusters"("id") ON DELETE CASCADE,
	"features" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"score" real NOT NULL,
	"breakdown" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"model_version" text NOT NULL,
	"decision" text NOT NULL CHECK ("decision" IN ('selected', 'rejected')),
	"reason" text NOT NULL,
	"rank" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	UNIQUE ("run_id", "cluster_id")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "news_candidates_cluster_idx" ON "news_candidates" ("cluster_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "news_articles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid REFERENCES "news_jobs"("id") ON DELETE SET NULL,
	"job_version" integer,
	"run_id" uuid REFERENCES "news_runs"("id") ON DELETE SET NULL,
	"cluster_id" uuid REFERENCES "news_clusters"("id") ON DELETE SET NULL,
	"cluster_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"mode" text DEFAULT 'single' NOT NULL CHECK ("mode" IN ('single', 'digest')),
	"draft_id" uuid,
	"post_id" uuid,
	"status" text DEFAULT 'drafting' NOT NULL CHECK ("status" IN ('drafting', 'ready_for_review', 'failed_quality', 'incomplete', 'failed', 'published', 'rejected', 'superseded', 'dry_run', 'paused_budget')),
	"writing_profile_key" text,
	"writing_profile_version" integer,
	"image_profile_key" text,
	"image_profile_version" integer,
	"score" real,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fact_sheet" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fact_check" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"similarity" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"quality" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"generated_doc" jsonb,
	"tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"review_outcome" text CHECK ("review_outcome" IS NULL OR "review_outcome" IN ('approved', 'rejected', 'scheduled')),
	"reject_category" text CHECK ("reject_category" IS NULL OR "reject_category" IN ('off_topic', 'low_value', 'duplicate', 'inaccurate', 'style', 'other')),
	"reject_reason" text,
	"edit_distance" real,
	"expires_after_days" integer,
	"published_at" timestamp with time zone,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
-- One active draft per cluster per job.
CREATE UNIQUE INDEX IF NOT EXISTS "news_articles_one_active" ON "news_articles" ("job_id", "cluster_id") WHERE "status" IN ('drafting', 'ready_for_review') AND "cluster_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "news_articles_draft_idx" ON "news_articles" ("draft_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "news_articles_post_idx" ON "news_articles" ("post_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "news_articles_job_idx" ON "news_articles" ("job_id", "created_at" DESC);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "news_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"article_id" uuid NOT NULL REFERENCES "news_articles"("id") ON DELETE CASCADE,
	"variant" integer DEFAULT 1 NOT NULL,
	"provider" text NOT NULL,
	"model" text,
	"prompt" text,
	"negative_prompt" text,
	"seed" bigint,
	"width" integer,
	"height" integer,
	"sizes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"media_id" text,
	"src" text,
	"alt" text,
	"decorative" boolean DEFAULT false NOT NULL,
	"ai_generated" boolean DEFAULT false NOT NULL,
	"safety" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"score" real,
	"selected" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'ok' NOT NULL CHECK ("status" IN ('ok', 'rejected_safety', 'failed', 'stored')),
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "news_images_article_idx" ON "news_images" ("article_id", "created_at");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "news_feedback" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"article_id" uuid REFERENCES "news_articles"("id") ON DELETE SET NULL,
	"cluster_id" uuid,
	"job_id" uuid,
	"kind" text NOT NULL CHECK ("kind" IN ('approve', 'reject', 'edit', 'category_correction', 'performance', 'source_accuracy')),
	"reason_category" text,
	"reason" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "news_feedback_kind_idx" ON "news_feedback" ("kind", "at" DESC);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "news_feedback_perf_uq" ON "news_feedback" ("article_id", ((payload->>'window'))) WHERE "kind" = 'performance';--> statement-breakpoint

-- Topic labels for the classifier: Claude's one-off bootstrap labels and the owner's corrections.
CREATE TABLE IF NOT EXISTS "news_labels" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"item_id" uuid REFERENCES "news_items"("id") ON DELETE CASCADE,
	"cluster_id" uuid REFERENCES "news_clusters"("id") ON DELETE CASCADE,
	"topics" text[] NOT NULL,
	"source" text NOT NULL CHECK ("source" IN ('claude', 'human')),
	"at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "news_labels_item_uq" ON "news_labels" ("item_id", "source") WHERE "item_id" IS NOT NULL;--> statement-breakpoint

-- Versioned ML models (classifier, ranker) with their evaluation metrics. CPU-only artefacts, a few hundred KB.
CREATE TABLE IF NOT EXISTS "news_models" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL CHECK ("kind" IN ('classifier', 'ranker')),
	"version" text NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"n_samples" integer DEFAULT 0 NOT NULL,
	"artifact" bytea,
	"notes" text,
	"trained_at" timestamp with time zone DEFAULT now() NOT NULL,
	UNIQUE ("kind", "version")
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "news_models_one_active" ON "news_models" ("kind") WHERE "active";
