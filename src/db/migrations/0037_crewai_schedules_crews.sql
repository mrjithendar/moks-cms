-- CrewAI console, phases 2 and 3 (owner request 2026-11-19, D-98): flow schedules in the database, run by one
-- dispatcher instead of fifteen CronJobs, and versioned crew configuration with test runs.
--   seo_flow_schedules  when a flow runs: a 5-field cron in an IANA time zone, and the inputs the run gets. Admins edit
--                       them in /admin/crewai/schedules. The seo-agent's dispatcher (moks-seo-agent/app/schedules.py,
--                       POST /schedules/dispatch, one CronJob every minute) starts each one that is due and writes only
--                       last_slot, last_fired_at, last_status, last_run_id and last_error. It never fires a time at or
--                       before armed_at, which the web app moves when cron, timezone or enabled change. The fifteen
--                       built-in rows below are the CronJobs jithendar.com ran until now (same times, UTC); they can be
--                       edited, paused and reset to default_*, not deleted.
--   seo_crew_configs    versions of a crew's editable configuration: an overlay on the code's defaults (agents' role,
--                       goal, backstory, model, output tokens, iterations and tools; tasks' instructions and expected
--                       output; moks-seo-agent/app/crews/config.py). Rows are never changed except `active`: at most
--                       one active version per crew, served to the agent on GET /internal/seo-agent/crew-configs. No
--                       active row means the code's defaults.
-- Additive. Rollback: src/db/rollback/0037_crewai_schedules_crews.down.sql (manual).
CREATE TABLE IF NOT EXISTS "seo_flow_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL UNIQUE CHECK ("name" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("name") <= 64),
	"flow_name" text NOT NULL CHECK ("flow_name" ~ '^[a-z][a-z0-9_]{2,39}_flow$'),
	"description" text DEFAULT '' NOT NULL CHECK (char_length("description") <= 300),
	"cron" text NOT NULL CHECK (char_length("cron") BETWEEN 1 AND 120),
	"timezone" text DEFAULT 'Etc/UTC' NOT NULL CHECK (char_length("timezone") BETWEEN 1 AND 64),
	"inputs" jsonb DEFAULT '{}'::jsonb NOT NULL CHECK (jsonb_typeof("inputs") = 'object'),
	"enabled" boolean DEFAULT true NOT NULL,
	"builtin" boolean DEFAULT false NOT NULL,
	"default_cron" text,
	"default_timezone" text,
	"default_inputs" jsonb,
	"armed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_slot" text,
	"last_fired_at" timestamp with time zone,
	"last_status" text CHECK ("last_status" IN ('starting', 'started', 'already_running', 'failed')),
	"last_run_id" uuid,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_flow_schedules_flow_idx" ON "seo_flow_schedules" ("flow_name");--> statement-breakpoint
INSERT INTO "seo_flow_schedules" ("name", "flow_name", "description", "cron", "timezone", "inputs", "builtin", "default_cron", "default_timezone", "default_inputs", "updated_by")
SELECT v.name, v.flow, v.description, v.cron, 'Etc/UTC', v.inputs::jsonb, true, v.cron, 'Etc/UTC', v.inputs::jsonb, 'migration 0037'
FROM (VALUES
	('gsc-sync', 'gsc_sync_flow', 'Daily Search Console sync.', '10 6 * * *', '{}'),
	('ga4-sync', 'ga4_sync_flow', 'Daily GA4 sync.', '20 6 * * *', '{}'),
	('tech-audit', 'tech_audit_flow', 'Weekly technical audit.', '0 3 * * 1', '{}'),
	('ask-gaps', 'ask_gaps_flow', 'Weekly Ask the Blog gap clustering.', '30 4 * * 1', '{}'),
	('weekly-recommendations', 'weekly_recommendations_flow', 'Weekly rules, scoring and the top drafts, after the syncs and the audit.', '0 7 * * 1', '{}'),
	('report-weekly', 'report_flow', 'Weekly report and PDF.', '0 8 * * 1', '{"period":"weekly"}'),
	('internal-linking', 'internal_linking_flow', 'Weekly internal links merged into open drafts, after the weekly drafts.', '0 9 * * 1', '{}'),
	('report-monthly', 'report_flow', 'Monthly report and PDF, on the 2nd.', '0 8 2 * *', '{"period":"monthly"}'),
	('reindex', 'reindex_flow', 'Weekly incremental reindex of the article embeddings (publishing also reindexes each article).', '17 3 * * 0', '{}'),
	('seo-ml', 'seo_ml_flow', 'Weekly SEO models (decay, query clusters, intent, priority, related) and the retrieval eval, after the reindex.', '47 4 * * 0', '{}'),
	('news-dispatch', 'news_dispatch_flow', 'Starts each news job that is due (their times are set in Admin → News) and the daily news housekeeping.', '*/15 * * * *', '{}'),
	('news-train', 'news_train_flow', 'Weekly retraining of the news topic classifier and, with enough feedback, the ranker.', '30 2 * * 0', '{}'),
	('news-style-review', 'news_style_review_flow', 'Weekly writing-profile proposal from last week''s edits (never applied automatically).', '30 3 * * 1', '{}'),
	('promotion', 'promotion_flow', 'Daily channel scores and post drafts for newly published articles, after the Search Console sync.', '40 7 * * *', '{}'),
	('content-ideas', 'content_ideas_flow', 'Weekly content ideas from Search Console demand and Reddit threads.', '20 5 * * 2', '{}')
) AS v(name, flow, description, cron, inputs)
ON CONFLICT ("name") DO NOTHING;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "seo_crew_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"crew" text NOT NULL CHECK ("crew" ~ '^[a-z][a-z0-9_]{1,39}$'),
	"version" integer NOT NULL CHECK ("version" >= 1),
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL CHECK (jsonb_typeof("config") = 'object'),
	"note" text DEFAULT '' NOT NULL CHECK (char_length("note") <= 500),
	"source" text DEFAULT 'editor' NOT NULL CHECK ("source" IN ('editor', 'import', 'test')),
	"base_hash" text,
	"prompt_version" text,
	"active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"activated_at" timestamp with time zone,
	"activated_by" text,
	UNIQUE ("crew", "version")
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "seo_crew_configs_one_active" ON "seo_crew_configs" ("crew") WHERE "active";
