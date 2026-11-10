-- SEO platform v2, Phase 6: keyword opportunities from Search Console data only (no third-party volume/difficulty).
-- Additive. Rollback: src/db/rollback/0014_seo_keywords.down.sql (manual).
-- Intent per query (Claude Haiku or the rules fallback), cached.
CREATE TABLE IF NOT EXISTS "seo_query_intents" (
	"query" text PRIMARY KEY NOT NULL,
	-- informational | navigational | commercial | troubleshooting | comparison
	"intent" text NOT NULL,
	-- llm | rules
	"source" text NOT NULL,
	"model" text,
	"classified_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
-- Topic clusters (n-gram similarity; no embedding store exists). parent_topic = the cluster's top query.
CREATE TABLE IF NOT EXISTS "seo_query_clusters" (
	"query" text PRIMARY KEY NOT NULL,
	"cluster_id" integer NOT NULL,
	"parent_topic" text NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_query_clusters_cluster_idx" ON "seo_query_clusters" ("cluster_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "seo_tracked_keywords" (
	"query" text PRIMARY KEY NOT NULL,
	"added_by" text,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"alert_positions" double precision,
	"last_position" double precision,
	"last_alert_at" timestamp with time zone,
	"last_alert" jsonb
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "seo_keyword_ignores" (
	"query" text PRIMARY KEY NOT NULL,
	"added_by" text,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "seo_saved_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"page" text NOT NULL,
	"name" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	UNIQUE ("page", "name")
);--> statement-breakpoint
-- Server-side aggregation by period for the keyword table (sort/paginate in SQL).
CREATE INDEX IF NOT EXISTS "seo_gsc_query_daily_type_date_query_idx" ON "seo_gsc_query_daily" ("search_type", "date", "query");
