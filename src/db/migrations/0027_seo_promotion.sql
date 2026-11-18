-- Promotion (docs/seo/PROMOTION.md): where to promote published articles, Claude-drafted posts a person reviews and
-- posts by hand, and content ideas chosen because they have a real audience (Search Console gaps + Reddit threads).
-- Additive only. Rollback: src/db/rollback/0027_seo_promotion.down.sql (manual).

-- External signals collected for promotion: Reddit threads from the configured subreddits (public listing data only:
-- no usernames, no post bodies). One row per thread, refreshed on every sync; pruned after 60 days.
CREATE TABLE IF NOT EXISTS "seo_promo_signals" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"community" text NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"score" integer DEFAULT 0 NOT NULL,
	"comments" integer DEFAULT 0 NOT NULL,
	"posted_at" timestamp with time zone,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "seo_promo_signals_source_external_idx" ON "seo_promo_signals" ("source", "external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_promo_signals_fetched_idx" ON "seo_promo_signals" ("source", "fetched_at");--> statement-breakpoint

-- One row per published article and channel: the deterministic score and its reasons, the tagged link, and the drafted
-- post. status: open (scored, no draft yet) | drafted (draft waiting for a person) | posted (a person posted it and
-- recorded that) | dismissed. Nothing here is ever posted by the system.
CREATE TABLE IF NOT EXISTS "seo_promo_opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"article_id" uuid NOT NULL REFERENCES "post"("id") ON DELETE CASCADE,
	"channel" text NOT NULL,
	"score" double precision DEFAULT 0 NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"link" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"draft_title" text,
	"draft_body" text,
	"draft_notes" text,
	"draft_flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"draft_source" text,
	"run_id" text,
	"edited_by" text,
	"posted_url" text,
	"posted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "seo_promo_opportunities_article_channel_idx" ON "seo_promo_opportunities" ("article_id", "channel");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_promo_opportunities_status_idx" ON "seo_promo_opportunities" ("status", "score");--> statement-breakpoint

-- Content ideas: articles worth writing because they would be easy to promote. status: new | saved | dismissed |
-- sent (on the editorial calendar: calendar_id). The fingerprint (normalised title tokens) stops repeats, including
-- ideas the owner dismissed.
CREATE TABLE IF NOT EXISTS "seo_content_ideas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fingerprint" text NOT NULL,
	"title" text NOT NULL,
	"angle" text DEFAULT '' NOT NULL,
	"outline" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"target_query" text,
	"channels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"signals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"score" double precision DEFAULT 0 NOT NULL,
	"source" text DEFAULT 'crew' NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"calendar_id" uuid REFERENCES "seo_editorial_calendar"("id") ON DELETE SET NULL,
	"run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "seo_content_ideas_fingerprint_idx" ON "seo_content_ideas" ("fingerprint");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_content_ideas_status_idx" ON "seo_content_ideas" ("status", "score");
