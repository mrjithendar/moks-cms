-- SEO platform v2, Phase 3: compliant search-engine submission log (docs/seo/SUBMISSION.md).
-- IndexNow URL submissions (batched, deduplicated), Search Console sitemap resubmissions, and the URL Inspection
-- check scheduled 2–3 days later ("Google's last-known state"). No Google Indexing API. Additive; rollback:
-- src/db/rollback/0013_seo_submissions.down.sql (manual).
CREATE TABLE IF NOT EXISTS "seo_search_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"url" text NOT NULL,
	-- indexnow | google
	"engine" text NOT NULL,
	-- url (IndexNow) | sitemap (Search Console sitemaps.submit) | inspection (URL Inspection API)
	"kind" text NOT NULL,
	"article_id" uuid REFERENCES "post"("id") ON DELETE SET NULL,
	"draft_id" uuid REFERENCES "seo_drafts"("id") ON DELETE SET NULL,
	-- publish | rollback | edit | sitemap
	"reason" text NOT NULL,
	-- queued | sending | accepted | error | skipped | deduplicated | scheduled | done
	"status" text DEFAULT 'queued' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"response_code" integer,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"inspection" jsonb,
	"inspected_at" timestamp with time zone
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_search_submissions_status_idx" ON "seo_search_submissions" ("engine", "kind", "status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_search_submissions_article_idx" ON "seo_search_submissions" ("article_id", "requested_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_search_submissions_url_idx" ON "seo_search_submissions" ("url", "requested_at" DESC);
