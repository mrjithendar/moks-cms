-- DataForSEO (docs/seo/DATAFORSEO.md): keyword volume and difficulty, live Google rank tracking, backlink snapshots.
-- Additive. Rollback: src/db/rollback/0030_seo_dataforseo.down.sql (manual).
-- One row per query: the latest metrics for the configured market (location + language).
CREATE TABLE IF NOT EXISTS "seo_keyword_metrics" (
	"query" text PRIMARY KEY NOT NULL,
	"location_code" integer NOT NULL,
	"language_code" text NOT NULL,
	-- null = DataForSEO has no data for this query (kept so it is not bought again before refreshDays)
	"search_volume" integer,
	-- 0–100
	"keyword_difficulty" integer,
	"cpc" double precision,
	-- 0–1 (Google Ads competition)
	"competition" double precision,
	-- informational | navigational | commercial | transactional (DataForSEO's labels)
	"main_intent" text,
	-- [{ "month": "2026-10", "volume": 1300 }, …] newest first
	"monthly_searches" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
-- Live Google SERP position of tracked keywords, one row per query, day and location.
CREATE TABLE IF NOT EXISTS "seo_serp_ranks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"query" text NOT NULL,
	"checked_on" date NOT NULL,
	"location_code" integer NOT NULL,
	"language_code" text NOT NULL,
	-- organic rank_group of this site's best result; null = not in the checked depth
	"position" integer,
	"url" text,
	"ai_overview" boolean DEFAULT false NOT NULL,
	"item_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	-- top 10 organic results: [{ position, domain, url, title }]
	"top_results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seo_serp_ranks_query_day_location_key" UNIQUE ("query", "checked_on", "location_code")
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "seo_backlink_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target" text NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"taken_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_backlink_snapshots_taken_idx" ON "seo_backlink_snapshots" ("taken_at" DESC);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "seo_referring_domains" (
	"snapshot_id" uuid NOT NULL REFERENCES "seo_backlink_snapshots" ("id") ON DELETE CASCADE,
	"domain" text NOT NULL,
	"rank" integer,
	"backlinks" integer,
	"first_seen" timestamp with time zone,
	"spam_score" integer,
	PRIMARY KEY ("snapshot_id", "domain")
);
