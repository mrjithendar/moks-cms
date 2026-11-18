-- SEO intelligence platform (/admin/seo): Google Search Console and GA4 data, recommendations, audits, editorial
-- calendar, optimisation proposals, reports. Purely additive: no existing table is altered. Rollback script:
-- src/db/rollback/0011_seo_intelligence.down.sql (manual; drops only these tables).
-- Settings are the `setting` row "seo" and audit entries go to `audit_log` (docs/seo/DECISIONS.md D-04, D-05).
CREATE TABLE IF NOT EXISTS "seo_integrations" (
	"provider" text PRIMARY KEY NOT NULL,
	"property_id" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'not_configured' NOT NULL,
	"last_verified_at" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "seo_sync_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_type" text NOT NULL,
	"trigger" text NOT NULL,
	"window_start" date,
	"window_end" date,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"rows_written" integer DEFAULT 0 NOT NULL,
	"api_requests" integer DEFAULT 0 NOT NULL,
	"retries" integer DEFAULT 0 NOT NULL,
	"error" text,
	"error_code" text,
	"correlation_id" text NOT NULL,
	"actor" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_sync_jobs_type_started_idx" ON "seo_sync_jobs" ("job_type", "started_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_sync_jobs_started_idx" ON "seo_sync_jobs" ("started_at" DESC);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "seo_gsc_daily_totals" (
	"date" date NOT NULL,
	"search_type" text NOT NULL,
	"clicks" bigint NOT NULL,
	"impressions" bigint NOT NULL,
	"ctr" double precision NOT NULL,
	"position" double precision,
	"data_state" text DEFAULT 'final' NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	PRIMARY KEY ("date", "search_type")
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "seo_gsc_page_daily" (
	"date" date NOT NULL,
	"page" text NOT NULL,
	"search_type" text NOT NULL,
	"device" text NOT NULL,
	"country" text NOT NULL,
	"clicks" bigint NOT NULL,
	"impressions" bigint NOT NULL,
	"ctr" double precision NOT NULL,
	"position" double precision,
	"data_state" text DEFAULT 'final' NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	PRIMARY KEY ("date", "page", "search_type", "device", "country")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_gsc_page_daily_page_date_idx" ON "seo_gsc_page_daily" ("page", "date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_gsc_page_daily_date_idx" ON "seo_gsc_page_daily" ("date", "search_type");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "seo_gsc_query_daily" (
	"date" date NOT NULL,
	"page" text NOT NULL,
	"query" text NOT NULL,
	"search_type" text NOT NULL,
	"device" text NOT NULL,
	"country" text NOT NULL,
	"clicks" bigint NOT NULL,
	"impressions" bigint NOT NULL,
	"ctr" double precision NOT NULL,
	"position" double precision,
	"data_state" text DEFAULT 'final' NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	PRIMARY KEY ("date", "page", "query", "search_type", "device", "country")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_gsc_query_daily_query_date_idx" ON "seo_gsc_query_daily" ("query", "date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_gsc_query_daily_page_date_idx" ON "seo_gsc_query_daily" ("page", "date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_gsc_query_daily_date_idx" ON "seo_gsc_query_daily" ("date", "search_type");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "seo_ga4_page_daily" (
	"date" date NOT NULL,
	"landing_page" text NOT NULL,
	"channel_group" text NOT NULL,
	"device" text NOT NULL,
	"country" text NOT NULL,
	"new_vs_returning" text NOT NULL,
	"active_users" bigint DEFAULT 0 NOT NULL,
	"new_users" bigint DEFAULT 0 NOT NULL,
	"sessions" bigint DEFAULT 0 NOT NULL,
	"engaged_sessions" bigint DEFAULT 0 NOT NULL,
	"engagement_rate" double precision DEFAULT 0 NOT NULL,
	"user_engagement_duration" double precision DEFAULT 0 NOT NULL,
	"screen_page_views" bigint DEFAULT 0 NOT NULL,
	"key_events" double precision DEFAULT 0 NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	PRIMARY KEY ("date", "landing_page", "channel_group", "device", "country", "new_vs_returning")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_ga4_page_daily_page_date_idx" ON "seo_ga4_page_daily" ("landing_page", "date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_ga4_page_daily_date_idx" ON "seo_ga4_page_daily" ("date", "channel_group");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "seo_url_map" (
	"url" text PRIMARY KEY NOT NULL,
	"path" text NOT NULL,
	"article_id" uuid REFERENCES "post"("id") ON DELETE SET NULL,
	"is_canonical" boolean DEFAULT true NOT NULL,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_url_map_article_idx" ON "seo_url_map" ("article_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_url_map_path_idx" ON "seo_url_map" ("path");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "seo_recommendations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fingerprint" text NOT NULL UNIQUE,
	"article_id" uuid REFERENCES "post"("id") ON DELETE SET NULL,
	"url" text,
	"query" text,
	"category" text NOT NULL,
	"rule_key" text NOT NULL,
	"problem" text NOT NULL,
	"proposed_action" text NOT NULL,
	"analysis_date" date NOT NULL,
	"priority_score" double precision NOT NULL,
	"priority_band" text NOT NULL,
	"score_inputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"confidence" text NOT NULL,
	"expected_impact" text NOT NULL,
	"ai_explanation" text,
	"ai_prompt_version" text,
	"review_status" text DEFAULT 'pending' NOT NULL,
	"implementation_status" text DEFAULT 'not_started' NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"implemented_at" timestamp with time zone,
	"baseline_metrics" jsonb,
	"post_metrics_28d" jsonb,
	"post_metrics_56d" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_recommendations_status_score_idx" ON "seo_recommendations" ("review_status", "priority_score" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_recommendations_article_idx" ON "seo_recommendations" ("article_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_recommendations_category_idx" ON "seo_recommendations" ("category");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "seo_recommendation_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recommendation_id" uuid NOT NULL REFERENCES "seo_recommendations"("id") ON DELETE CASCADE,
	"metric" text NOT NULL,
	"period" text NOT NULL,
	"value" double precision,
	"value_text" text,
	"source" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_recommendation_evidence_rec_idx" ON "seo_recommendation_evidence" ("recommendation_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "seo_content_audits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"article_id" uuid NOT NULL REFERENCES "post"("id") ON DELETE CASCADE,
	"audited_at" timestamp with time zone DEFAULT now() NOT NULL,
	"content_hash" text NOT NULL,
	"score" double precision NOT NULL,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_content_audits_article_idx" ON "seo_content_audits" ("article_id", "audited_at" DESC);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "seo_internal_link_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_article_id" uuid NOT NULL REFERENCES "post"("id") ON DELETE CASCADE,
	"target_article_id" uuid NOT NULL REFERENCES "post"("id") ON DELETE CASCADE,
	"anchor_text" text NOT NULL,
	"reason" text NOT NULL,
	"score" double precision NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'suggested' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	UNIQUE ("source_article_id", "target_article_id")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_internal_link_suggestions_source_idx" ON "seo_internal_link_suggestions" ("source_article_id", "status");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "seo_editorial_calendar" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fingerprint" text UNIQUE,
	"title" text NOT NULL,
	"status" text DEFAULT 'suggested' NOT NULL,
	"kind" text NOT NULL,
	"category" text,
	"cluster" text,
	"priority_score" double precision DEFAULT 0 NOT NULL,
	"priority_band" text DEFAULT 'low' NOT NULL,
	"target_date" date,
	"owner_id" text REFERENCES "user"("id") ON DELETE SET NULL,
	"recommendation_id" uuid REFERENCES "seo_recommendations"("id") ON DELETE SET NULL,
	"post_id" uuid REFERENCES "post"("id") ON DELETE SET NULL,
	"brief" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_editorial_calendar_status_date_idx" ON "seo_editorial_calendar" ("status", "target_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_editorial_calendar_post_idx" ON "seo_editorial_calendar" ("post_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "seo_article_optimizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"article_id" uuid NOT NULL REFERENCES "post"("id") ON DELETE CASCADE,
	"recommendation_id" uuid REFERENCES "seo_recommendations"("id") ON DELETE SET NULL,
	"field" text NOT NULL,
	"current_value" text,
	"proposed_value" text NOT NULL,
	"rationale" text NOT NULL,
	"source" text NOT NULL,
	"prompt_version" text,
	"base_version" integer NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"previous_working_copy" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_article_optimizations_article_idx" ON "seo_article_optimizations" ("article_id", "status");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "seo_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"period_type" text NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"payload" jsonb NOT NULL,
	"trigger" text NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"emailed_at" timestamp with time zone,
	UNIQUE ("period_type", "period_start")
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "seo_technical_scans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text DEFAULT 'running' NOT NULL,
	"pages_crawled" integer DEFAULT 0 NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "seo_technical_issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scan_id" uuid NOT NULL REFERENCES "seo_technical_scans"("id") ON DELETE CASCADE,
	"url" text NOT NULL,
	"check_key" text NOT NULL,
	"severity" text NOT NULL,
	"message" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_technical_issues_scan_idx" ON "seo_technical_issues" ("scan_id", "severity");--> statement-breakpoint
-- One lease per SEO job type: at most one run of a type at a time across replicas (docs/seo/DECISIONS.md D-02).
CREATE TABLE IF NOT EXISTS "seo_job_locks" (
	"job_type" text PRIMARY KEY NOT NULL,
	"holder" text NOT NULL,
	"locked_until" timestamp with time zone NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "seo_llm_cache" (
	"input_hash" text NOT NULL,
	"prompt_version" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"output" jsonb NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	PRIMARY KEY ("input_hash", "prompt_version")
);
