-- SEO v5, Phase 3: SEO-side ML (docs/seo/ML.md). Additive only. Rollback: src/db/rollback/0019_seo_v5_ml.down.sql (manual).
-- The models run in the seo-agent (seo_ml_flow, weekly CronJob) and write these tables; the web app only reads them and
-- falls back to its rules when a table is empty, older than 2 × the schedule (14 days), or the model is not active.

-- One row per trained model version. `beats_rule`: held-out metrics beat the rule's on the same data (the activation
-- rule in ML.md). `active`: what the web app uses in "auto" mode (at most one per kind).
CREATE TABLE IF NOT EXISTS "seo_ml_models" (
	"id" bigserial PRIMARY KEY NOT NULL,
	-- decay | query_clusters | intent | priority | related
	"kind" text NOT NULL,
	"version" text NOT NULL,
	"trained_at" timestamp with time zone DEFAULT now() NOT NULL,
	"n_samples" integer DEFAULT 0 NOT NULL,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rule_metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"beats_rule" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	-- trained | collecting_data | needs_review | experiment_running | failed
	"status" text DEFAULT 'trained' NOT NULL,
	"notes" text,
	-- Owner sign-off where the activation rule needs one (decay: review of the real back-test; intent: 50 spot-checks).
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"artifact" bytea,
	UNIQUE ("kind", "version")
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "seo_ml_models_one_active" ON "seo_ml_models" ("kind") WHERE "active";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_ml_models_kind_idx" ON "seo_ml_models" ("kind", "trained_at" DESC);--> statement-breakpoint

-- Owner override per model kind: auto (the activation rule decides) | rule (force the rule) | model (force the latest model).
CREATE TABLE IF NOT EXISTS "seo_ml_overrides" (
	"kind" text PRIMARY KEY NOT NULL,
	"mode" text DEFAULT 'auto' NOT NULL CHECK ("mode" IN ('auto', 'rule', 'model')),
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

-- 3.1 Seasonality-aware decay (STL). One row per page per run; `evidence` holds the trend-vs-actual series for the chart.
CREATE TABLE IF NOT EXISTS "seo_ml_decay_signals" (
	"page" text NOT NULL,
	"window_start" date NOT NULL,
	"window_end" date NOT NULL,
	"decaying" boolean NOT NULL,
	"trend_slope" double precision,
	"drop_pct" double precision,
	"confidence" double precision,
	-- stl-v1 | insufficient_history
	"method_version" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	PRIMARY KEY ("page", "method_version")
);--> statement-breakpoint

-- 3.2 Query clusters from embeddings (HDBSCAN). cluster_id -1 never appears: noise points are singletons.
CREATE TABLE IF NOT EXISTS "seo_ml_query_clusters" (
	"query" text PRIMARY KEY NOT NULL,
	"cluster_id" integer NOT NULL,
	"cluster_label" text NOT NULL,
	"model_version" text NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_ml_query_clusters_cluster_idx" ON "seo_ml_query_clusters" ("cluster_id");--> statement-breakpoint
-- Embedding cache by normalised query text (and the embedding model), so weekly runs embed only new queries.
CREATE TABLE IF NOT EXISTS "seo_ml_query_embeddings" (
	"query" text NOT NULL,
	"model" text NOT NULL,
	"embedding" real[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	PRIMARY KEY ("query", "model")
);--> statement-breakpoint

-- 3.3 Intent predictions from the distilled classifier; the web uses one only at confidence ≥ the model's threshold.
CREATE TABLE IF NOT EXISTS "seo_ml_intent_predictions" (
	"query" text PRIMARY KEY NOT NULL,
	"intent" text NOT NULL,
	"confidence" double precision NOT NULL,
	"model_version" text NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
-- Training data must come from the current intent prompt. Every existing Haiku label was made with seo-intent-v1
-- (the only version that has existed), so it is recorded as such.
ALTER TABLE "seo_query_intents" ADD COLUMN IF NOT EXISTS "prompt_version" text;--> statement-breakpoint
UPDATE "seo_query_intents" SET "prompt_version" = 'seo-intent-v1' WHERE "source" = 'llm' AND "prompt_version" IS NULL;--> statement-breakpoint
-- Which method made each topic cluster the keyword views show: "rule" (token sets) or "model vN" (seo_ml_query_clusters).
ALTER TABLE "seo_query_clusters" ADD COLUMN IF NOT EXISTS "source" text;--> statement-breakpoint

-- 3.4 Learned weight proposals (never applied automatically; approving one writes the weights into the settings).
CREATE TABLE IF NOT EXISTS "seo_ml_weight_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"model_version" text NOT NULL,
	"weights" jsonb NOT NULL,
	"current_weights" jsonb NOT NULL,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"n_outcomes" integer NOT NULL,
	-- proposed | approved | dismissed | superseded
	"status" text DEFAULT 'proposed' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone
);--> statement-breakpoint

-- 3.5 Related articles (similarity + reader co-visitation / shared queries + category).
CREATE TABLE IF NOT EXISTS "seo_ml_related_articles" (
	"article_id" uuid NOT NULL REFERENCES "post"("id") ON DELETE CASCADE,
	"related_id" uuid NOT NULL REFERENCES "post"("id") ON DELETE CASCADE,
	"rank" integer NOT NULL,
	"score" double precision NOT NULL,
	"components" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"model_version" text NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	PRIMARY KEY ("article_id", "related_id")
);--> statement-breakpoint
-- GA4 landing page → page path views in the same sessions (aggregate, last 28 days), when the property supports the
-- dimension pair; filled by the web app's GA4 sync. Empty = no co-visitation data (ML.md "Related articles").
CREATE TABLE IF NOT EXISTS "seo_ga4_page_pairs" (
	"landing_page" text NOT NULL,
	"page_path" text NOT NULL,
	"views" bigint NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	PRIMARY KEY ("landing_page", "page_path")
);--> statement-breakpoint

-- Labelling tasks for the owner (Models → Labelling): cluster groupings Claude suggested, intent disagreements to spot-check.
CREATE TABLE IF NOT EXISTS "seo_ml_labels" (
	"id" bigserial PRIMARY KEY NOT NULL,
	-- cluster | intent_check
	"task" text NOT NULL,
	"item" text NOT NULL,
	"suggestion" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"label" jsonb,
	-- pending | confirmed | changed | skipped
	"status" text DEFAULT 'pending' NOT NULL,
	"labelled_by" text,
	"labelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	UNIQUE ("task", "item")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_ml_labels_task_status_idx" ON "seo_ml_labels" ("task", "status");--> statement-breakpoint

-- Retrieval evaluation runs against the live index (seo_ml_flow step rag_eval) → seo_rag_eval_recall_at_3.
CREATE TABLE IF NOT EXISTS "seo_rag_eval_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"config" text NOT NULL,
	"metrics" jsonb NOT NULL
);
