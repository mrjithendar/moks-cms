-- Link tools (owner decision 2026-11-10, Link Whisper-style): the owner's keyword → URL list, and the broken-link
-- checker's results. Additive only. Rollback: src/db/rollback/0021_link_keywords_and_checks.down.sql (manual).

-- A keyword (exact phrase, whole words) whose FIRST mention in an article links to `url` (a site path like /blog/x or
-- an https URL). Used by the weekly auto-linker and the editor's link suggestions; every placement rule still applies.
CREATE TABLE IF NOT EXISTS "seo_link_keywords" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"keyword" text NOT NULL,
	"url" text NOT NULL,
	"case_sensitive" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "seo_link_keywords_keyword_idx" ON "seo_link_keywords" (lower("keyword"));--> statement-breakpoint

-- One row per distinct link target found in published posts and pages, with the latest check.
-- status: ok | redirect (works, but moved: final_url) | broken (404/410, or a missing site path) | blocked (401/403/429:
-- the site refuses checkers; not counted as broken) | error (timeout/5xx/DNS; broken after 2 failures in a row) | skipped
CREATE TABLE IF NOT EXISTS "seo_link_checks" (
	"url" text PRIMARY KEY NOT NULL,
	"internal" boolean NOT NULL,
	"status" text NOT NULL,
	"http_status" integer,
	"final_url" text,
	"error" text,
	"failures" integer DEFAULT 0 NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_link_checks_status_idx" ON "seo_link_checks" ("status", "checked_at");
