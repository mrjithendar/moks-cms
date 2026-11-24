-- One catalogue of crews and flows (owner brief 2026-11-24, D-100): every crew and every flow is a row of the same
-- table, with the same lifecycle (create, edit, duplicate, switch off, delete and restore), categories and tags. There
-- are no system, custom, content or SEO kinds of flow any more: categories and tags organise them and nothing else.
--   crewai_categories     the categories admins file crews and flows under (create, rename, remove). Seeded below.
--   crewai_crews          every crew. `definition` says where its agents and tasks are defined: 'code' (the seo-agent's
--                         own crews: edited as versions in seo_crew_configs, as before) or 'spec' (made or duplicated in
--                         the admin: `spec`, checked by the agent before every save and every run).
--   crewai_flows          every flow. 'code': a flow of the seo-agent (`key` is its name); 'spec': steps run by the
--                         agent's generic flow engine (custom_flow); 'content': a content flow, whose settings stay in
--                         news_jobs (kept in step by a trigger, below) and which news_job_flow runs. `crews` lists the
--                         crews a flow runs (crew execution references). A code flow switched off or deleted here is
--                         refused by the agent whoever starts it (GET /internal/seo-agent/flow-switches).
--   crewai_spec_versions  every saved version of a spec crew or flow (restore = save an old one as the newest).
-- seo_custom_crews and seo_custom_flows are copied (keys, specs, versions, switches, deletions and times kept) and left in
-- place, unused, until the copy has been checked on mk4; a later migration drops them. Nothing is deleted here, and
-- every statement can run again (tests re-run it after inserting rows into the old tables).
-- Rollback: src/db/rollback/0041_crewai_catalogue.down.sql (manual).
CREATE TABLE IF NOT EXISTS "crewai_categories" (
	"slug" text PRIMARY KEY NOT NULL CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("slug") <= 40),
	"label" text NOT NULL CHECK (char_length("label") BETWEEN 1 AND 60),
	"description" text DEFAULT '' NOT NULL CHECK (char_length("description") <= 300),
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text
);--> statement-breakpoint
INSERT INTO "crewai_categories" ("slug", "label", "description", "position", "updated_by") VALUES
	('seo', 'SEO', 'Search performance, technical audits and optimisation.', 10, 'migration 0041'),
	('content', 'Content', 'Drafting, editing and promoting articles and news.', 20, 'migration 0041'),
	('ai', 'AI', 'Models, embeddings and machine learning.', 30, 'migration 0041'),
	('automation', 'Automation', 'Data syncs, housekeeping and other scheduled work.', 40, 'migration 0041'),
	('research', 'Research', 'Ideas, gaps and questions worth writing about.', 50, 'migration 0041'),
	('monitoring', 'Monitoring', 'Checks and audits of the site''s health.', 60, 'migration 0041'),
	('custom', 'Custom', 'Crews and flows made in the admin.', 90, 'migration 0041')
ON CONFLICT ("slug") DO NOTHING;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "crewai_crews" (
	"key" text PRIMARY KEY NOT NULL CHECK ("key" ~ '^[a-z][a-z0-9_]{1,39}$'),
	"label" text NOT NULL CHECK (char_length("label") BETWEEN 2 AND 120),
	"description" text DEFAULT '' NOT NULL CHECK (char_length("description") <= 1000),
	"objective" text DEFAULT '' NOT NULL CHECK (char_length("objective") <= 1500),
	"categories" text[] DEFAULT '{}'::text[] NOT NULL CHECK (cardinality("categories") <= 10),
	"tags" text[] DEFAULT '{}'::text[] NOT NULL CHECK (cardinality("tags") <= 20),
	"enabled" boolean DEFAULT true NOT NULL,
	"definition" text DEFAULT 'spec' NOT NULL CHECK ("definition" IN ('code', 'spec')),
	"spec" jsonb CHECK ("spec" IS NULL OR jsonb_typeof("spec") = 'object'),
	"version" integer DEFAULT 1 NOT NULL CHECK ("version" >= 1),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	"deleted_at" timestamp with time zone,
	CHECK ("definition" = 'code' OR "spec" IS NOT NULL)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "crewai_crews_categories_idx" ON "crewai_crews" USING gin ("categories");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "crewai_crews_tags_idx" ON "crewai_crews" USING gin ("tags");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "crewai_flows" (
	"key" text PRIMARY KEY NOT NULL CHECK ("key" ~ '^[a-z][a-z0-9_]{1,39}$'),
	"label" text NOT NULL CHECK (char_length("label") BETWEEN 2 AND 120),
	"description" text DEFAULT '' NOT NULL CHECK (char_length("description") <= 1000),
	"categories" text[] DEFAULT '{}'::text[] NOT NULL CHECK (cardinality("categories") <= 10),
	"tags" text[] DEFAULT '{}'::text[] NOT NULL CHECK (cardinality("tags") <= 20),
	"enabled" boolean DEFAULT true NOT NULL,
	"disabled_reason" text CHECK (char_length("disabled_reason") <= 300),
	"definition" text DEFAULT 'spec' NOT NULL CHECK ("definition" IN ('code', 'spec', 'content')),
	"flow_name" text NOT NULL CHECK ("flow_name" ~ '^[a-z][a-z0-9_]{2,39}_flow$'),
	"start" text DEFAULT 'manual' NOT NULL CHECK ("start" IN ('manual', 'review', 'approval', 'schedule', 'internal')),
	"content_job_id" uuid UNIQUE,
	"spec" jsonb CHECK ("spec" IS NULL OR jsonb_typeof("spec") = 'object'),
	"crews" text[] DEFAULT '{}'::text[] NOT NULL,
	"version" integer DEFAULT 1 NOT NULL CHECK ("version" >= 1),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	"deleted_at" timestamp with time zone,
	CHECK ("definition" <> 'spec' OR "spec" IS NOT NULL),
	CHECK ("definition" <> 'content' OR "content_job_id" IS NOT NULL)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "crewai_flows_categories_idx" ON "crewai_flows" USING gin ("categories");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "crewai_flows_tags_idx" ON "crewai_flows" USING gin ("tags");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "crewai_flows_crews_idx" ON "crewai_flows" USING gin ("crews");--> statement-breakpoint
-- A step flow's runs are custom_flow runs with target custom:<key>, a content flow's news_job_flow runs with job:<id>.
CREATE INDEX IF NOT EXISTS "seo_flow_runs_target_idx" ON "seo_flow_runs" ("flow_name", "target_id", "started_at" DESC);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "crewai_spec_versions" (
	"kind" text NOT NULL CHECK ("kind" IN ('crew', 'flow')),
	"key" text NOT NULL,
	"version" integer NOT NULL CHECK ("version" >= 1),
	"spec" jsonb NOT NULL CHECK (jsonb_typeof("spec") = 'object'),
	"note" text DEFAULT '' NOT NULL CHECK (char_length("note") <= 500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	PRIMARY KEY ("kind", "key", "version")
);--> statement-breakpoint

-- The seo-agent's own crews (moks-seo-agent app/crews/config.py registry). The agent's GET /crews adds any newer one.
INSERT INTO "crewai_crews" ("key", "label", "description", "categories", "definition", "created_by", "updated_by") VALUES
	('editorial', 'Editorial crew', 'Researches, writes, reviews and edits a new article from a calendar item.', ARRAY['content'], 'code', 'migration 0041', 'migration 0041'),
	('optimization', 'Optimization crew', 'Turns recommendations into a change set for a published article.', ARRAY['content', 'seo'], 'code', 'migration 0041', 'migration 0041'),
	('report', 'Report crew', 'Writes the weekly or monthly briefing and checks its numbers.', ARRAY['seo'], 'code', 'migration 0041', 'migration 0041'),
	('promotion', 'Promotion crew', 'Scores where to share new articles, drafts the posts and finds content ideas.', ARRAY['content'], 'code', 'migration 0041', 'migration 0041'),
	('news', 'News desk crew', 'Writes news stories and digests for the content flows.', ARRAY['content'], 'code', 'migration 0041', 'migration 0041')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint

-- Custom crews (migration 0039), as they are: same key, spec, version, switch, deletion and times.
INSERT INTO "crewai_crews" ("key", "label", "description", "categories", "enabled", "definition", "spec", "version", "created_at", "created_by", "updated_at", "updated_by", "deleted_at")
SELECT c."key", c."label", left(coalesce(c."spec"->>'description', ''), 1000), ARRAY['custom'], c."enabled", 'spec', c."spec", c."version", c."created_at", c."updated_by", c."updated_at", c."updated_by", c."deleted_at"
FROM "seo_custom_crews" c
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "crewai_spec_versions" ("kind", "key", "version", "spec", "note", "created_at", "created_by")
SELECT 'crew', c."key", c."version", c."spec", 'copied from seo_custom_crews (migration 0041)', c."updated_at", c."updated_by" FROM "seo_custom_crews" c
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- The seo-agent's flows (app/flows/__init__.py SPECS and FLOW_INFO), with the names, descriptions and groups the console
-- showed until now as categories. The two runners (custom_flow, news_job_flow) and the crew test run are not listed: each
-- spec flow and content flow is its own row, and a crew test run is started from its crew.
INSERT INTO "crewai_flows" ("key", "label", "description", "categories", "definition", "flow_name", "start", "crews", "created_by", "updated_by")
SELECT v.key, v.label, v.description, v.categories, 'code', v.key, v.start, v.crews, 'migration 0041', 'migration 0041'
FROM (VALUES
	('new_article_flow', 'New article', 'The Editorial crew researches, writes, reviews and edits a new article from a calendar item; the draft waits for review.', ARRAY['content'], 'review', ARRAY['editorial']),
	('optimize_article_flow', 'Optimize article', 'The Optimization crew turns recommendations into a change set for a published article; the draft waits for review.', ARRAY['content', 'seo'], 'review', ARRAY['optimization']),
	('publish_flow', 'Publish', 'Publishes an approved draft, verifies it live, submits it to search engines and reindexes it. Starts only from an approval.', ARRAY['content'], 'approval', ARRAY[]::text[]),
	('weekly_recommendations_flow', 'Weekly recommendations', 'Picks this week''s articles to improve and starts an Optimize article run for each.', ARRAY['seo', 'content'], 'manual', ARRAY[]::text[]),
	('internal_linking_flow', 'Internal linking', 'Plans internal links between related articles.', ARRAY['seo'], 'manual', ARRAY[]::text[]),
	('report_flow', 'Report', 'The Report crew writes the weekly or monthly briefing, checks its numbers, renders the PDF and emails it.', ARRAY['seo'], 'manual', ARRAY['report']),
	('tech_audit_flow', 'Technical audit', 'Crawls the site and records technical SEO issues.', ARRAY['seo', 'monitoring'], 'manual', ARRAY[]::text[]),
	('ask_gaps_flow', 'Ask the Blog gaps', 'Groups questions Ask the Blog could not answer into article ideas.', ARRAY['research'], 'manual', ARRAY[]::text[]),
	('gsc_sync_flow', 'Search Console sync', 'Imports Google Search Console data.', ARRAY['seo', 'automation'], 'manual', ARRAY[]::text[]),
	('ga4_sync_flow', 'GA4 sync', 'Imports Google Analytics 4 data.', ARRAY['seo', 'automation'], 'manual', ARRAY[]::text[]),
	('promotion_flow', 'Promotion', 'The Promotion crew scores where to share new articles and drafts the posts.', ARRAY['content'], 'manual', ARRAY['promotion']),
	('content_ideas_flow', 'Content ideas', 'Turns community and search signals into article ideas for the calendar.', ARRAY['content', 'research'], 'manual', ARRAY['promotion']),
	('news_dispatch_flow', 'Content flows housekeeping', 'Keeps the content flows'' gauges current on every run and does their daily clean-up. The content flows themselves start on their own times.', ARRAY['content', 'automation'], 'schedule', ARRAY[]::text[]),
	('news_ingest_flow', 'News ingest', 'Fetches and stores items from the news sources.', ARRAY['content', 'automation'], 'manual', ARRAY[]::text[]),
	('news_draft_flow', 'News draft', 'The News desk crew writes one story or digest.', ARRAY['content'], 'internal', ARRAY['news']),
	('news_image_flow', 'News image', 'Generates and checks a cover image for a news draft.', ARRAY['content', 'ai'], 'internal', ARRAY[]::text[]),
	('news_train_flow', 'News model training', 'Retrains the news ranking model from editor decisions.', ARRAY['ai'], 'manual', ARRAY[]::text[]),
	('news_style_review_flow', 'News style review', 'Reviews recent edits to keep the news writing profile current.', ARRAY['content', 'ai'], 'manual', ARRAY[]::text[]),
	('news_playground_flow', 'News playground', 'A trial draft from the profile playground.', ARRAY['content'], 'internal', ARRAY['news']),
	('reindex_flow', 'Reindex', 'Rebuilds the article search index the agents and Ask the Blog use.', ARRAY['ai', 'automation'], 'manual', ARRAY[]::text[]),
	('seo_ml_flow', 'ML models', 'Retrains the SEO models (decay, query clusters, intent, priority, related articles).', ARRAY['ai', 'seo'], 'manual', ARRAY[]::text[])
) AS v(key, label, description, categories, start, crews)
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint

-- Custom flows (migration 0039), as they are; `crews` from their crew steps.
INSERT INTO "crewai_flows" ("key", "label", "description", "categories", "enabled", "definition", "flow_name", "spec", "crews", "version", "created_at", "created_by", "updated_at", "updated_by", "deleted_at")
SELECT f."key", f."label", left(coalesce(f."spec"->>'description', ''), 1000), ARRAY['custom'], f."enabled", 'spec', 'custom_flow', f."spec",
	coalesce(ARRAY(SELECT DISTINCT s->>'crew' FROM jsonb_array_elements(coalesce(f."spec"->'steps', '[]'::jsonb)) s WHERE s->>'kind' = 'crew' AND s->>'crew' IS NOT NULL), ARRAY[]::text[]),
	f."version", f."created_at", f."updated_by", f."updated_at", f."updated_by", f."deleted_at"
FROM "seo_custom_flows" f
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "crewai_spec_versions" ("kind", "key", "version", "spec", "note", "created_at", "created_by")
SELECT 'flow', f."key", f."version", f."spec", 'copied from seo_custom_flows (migration 0041)', f."updated_at", f."updated_by" FROM "seo_custom_flows" f
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- Content flows: one row per news_jobs row (its settings stay there, edited on the content flow's settings page). No
-- foreign key (news_jobs rows are soft-deleted, and the news desk's own rollback drops its tables). The trigger below
-- keeps name, description, switch and deletion in step; SECURITY DEFINER because the seo-agent's role
-- updates news_jobs (its run times) and has no grant here. It fires only on the columns it copies.
CREATE OR REPLACE FUNCTION "crewai_content_flow_sync"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO "crewai_flows" ("key", "label", "description", "categories", "enabled", "definition", "flow_name", "start", "content_job_id", "crews", "created_at", "created_by", "updated_at", "updated_by", "deleted_at")
  VALUES ('content_' || substr(replace(NEW."id"::text, '-', ''), 1, 12),
          CASE WHEN char_length(btrim(NEW."name")) >= 2 THEN left(btrim(NEW."name"), 120) ELSE 'Content flow' END,
          left(coalesce(NEW."description", ''), 1000), ARRAY['content'], NEW."enabled", 'content', 'news_job_flow', 'manual', NEW."id", ARRAY['news'],
          NEW."created_at", NEW."created_by", now(), NEW."created_by", NEW."deleted_at")
  ON CONFLICT ("content_job_id") DO UPDATE SET
    "label" = EXCLUDED."label", "description" = EXCLUDED."description", "enabled" = EXCLUDED."enabled",
    "deleted_at" = EXCLUDED."deleted_at", "updated_at" = now();
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "news_jobs_crewai_flow" ON "news_jobs";--> statement-breakpoint
CREATE TRIGGER "news_jobs_crewai_flow" AFTER INSERT OR UPDATE OF "name", "description", "enabled", "deleted_at" ON "news_jobs"
FOR EACH ROW EXECUTE FUNCTION "crewai_content_flow_sync"();--> statement-breakpoint
INSERT INTO "crewai_flows" ("key", "label", "description", "categories", "enabled", "definition", "flow_name", "start", "content_job_id", "crews", "created_at", "created_by", "updated_at", "updated_by", "deleted_at")
SELECT 'content_' || substr(replace(j."id"::text, '-', ''), 1, 12),
	CASE WHEN char_length(btrim(j."name")) >= 2 THEN left(btrim(j."name"), 120) ELSE 'Content flow' END,
	left(coalesce(j."description", ''), 1000), ARRAY['content'], j."enabled", 'content', 'news_job_flow', 'manual', j."id", ARRAY['news'],
	j."created_at", j."created_by", j."updated_at", j."created_by", j."deleted_at"
FROM "news_jobs" j
ON CONFLICT DO NOTHING;
