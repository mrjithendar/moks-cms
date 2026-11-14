-- Topic discovery (docs/seo/TOPICS.md): trend items from public sources and the scored topic candidates built from
-- them and from Search Console queries. Additive only. Rollback: src/db/rollback/0029_seo_topics.down.sql (manual).

-- One row per trending item (public listing data only: title, link, counts; no usernames, no bodies).
CREATE TABLE IF NOT EXISTS "seo_topic_signals" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"score" integer DEFAULT 0 NOT NULL,
	"comments" integer DEFAULT 0 NOT NULL,
	"posted_at" timestamp with time zone,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "seo_topic_signals_source_external_idx" ON "seo_topic_signals" ("source", "external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_topic_signals_fetched_idx" ON "seo_topic_signals" ("fetched_at");--> statement-breakpoint

-- One row per topic worth writing about. status: new | scheduled (sent to the editorial calendar) | dismissed.
-- calendar_id is the calendar item it became (no foreign key: the calendar row may be deleted independently).
CREATE TABLE IF NOT EXISTS "seo_topic_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"title" text NOT NULL,
	"kind" text NOT NULL,
	"queries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"signals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"impressions" double precision DEFAULT 0 NOT NULL,
	"position" double precision,
	"parts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"score" double precision DEFAULT 0 NOT NULL,
	"difficulty" double precision DEFAULT 50 NOT NULL,
	"difficulty_source" text DEFAULT 'proxy' NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"calendar_id" uuid,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "seo_topic_candidates_key_idx" ON "seo_topic_candidates" ("key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_topic_candidates_status_score_idx" ON "seo_topic_candidates" ("status", "score");
