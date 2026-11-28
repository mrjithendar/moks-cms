-- Manual rollback of 0045_litellm_only.sql (never applied automatically), from llm_config_archive. Deploy the release
-- before D-110 first: its SEO agent recreates its LLM tables at start, which this then fills again.
-- - Settings fields come back as they were archived. Sealed keys were never archived: enter the provider keys again
--   (or keep using LiteLLM, which the release before D-110 also supports, D-109).
-- - Model ids in tables come back as they were archived, in each row whose other columns are still as archived (a row
--   edited since keeps its edit).
-- - seo_llm_batches is recreated and filled; the agent's tables are filled only when they exist.
-- - llm_config_archive is dropped last.
UPDATE "setting" s SET "value" = s."value"
  || jsonb_build_object('llm', COALESCE(s."value"->'llm', '{}'::jsonb) || COALESCE(a."item"->'llm', '{}'::jsonb))
  || jsonb_build_object('drafts', COALESCE(s."value"->'drafts', '{}'::jsonb) || jsonb_strip_nulls(COALESCE(a."item"->'drafts', '{}'::jsonb)))
  || jsonb_build_object('aiVisibility', COALESCE(s."value"->'aiVisibility', '{}'::jsonb) || jsonb_strip_nulls(COALESCE(a."item"->'aiVisibility', '{}'::jsonb)))
FROM (SELECT DISTINCT ON ("source") "source", "item" FROM "llm_config_archive" WHERE "source" = 'setting:seo' ORDER BY "source", "id" DESC) a
WHERE s."key" = 'seo';--> statement-breakpoint
UPDATE "setting" s SET "value" = s."value"
  || jsonb_build_object('ai', COALESCE(s."value"->'ai', '{}'::jsonb) || COALESCE(a."item"->'ai', '{}'::jsonb))
  || jsonb_build_object('quotas', COALESCE(s."value"->'quotas', '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object('aiDailyBudgetUsd', a."item"->'aiDailyBudgetUsd')))
FROM (SELECT DISTINCT ON ("source") "source", "item" FROM "llm_config_archive" WHERE "source" = 'setting:practice' ORDER BY "source", "id" DESC) a
WHERE s."key" = 'practice';--> statement-breakpoint
UPDATE "setting" s SET "value" = s."value" || jsonb_strip_nulls(a."item")
FROM (SELECT DISTINCT ON ("source") "source", "item" FROM "llm_config_archive" WHERE "source" IN ('setting:ask_blog', 'setting:news') ORDER BY "source", "id" DESC) a
WHERE a."source" = 'setting:' || s."key";--> statement-breakpoint
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES ('news_jobs', 'config'), ('news_job_versions', 'snapshot'), ('seo_crew_configs', 'config'), ('seo_custom_crews', 'spec'), ('crewai_crews', 'spec'), ('crewai_spec_versions', 'spec')) AS t(tbl, col) LOOP
    IF to_regclass(quote_ident(r.tbl)) IS NOT NULL THEN
      EXECUTE format('UPDATE %I t SET %I = a.item->%L FROM llm_config_archive a WHERE a.source = %L AND to_jsonb(t) - %L = a.item->''row''', r.tbl, r.col, r.col, r.tbl || '.' || r.col, r.col);
    END IF;
  END LOOP;
  IF to_regclass('news_writing_profiles') IS NOT NULL THEN
    UPDATE news_writing_profiles p SET model = a.item->>'model' FROM llm_config_archive a WHERE a.source = 'news_writing_profiles.model' AND to_jsonb(p) - 'model' = a.item->'row';
  END IF;
END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "seo_llm_batches" (
	"id" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"model" text NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL,
	"estimated_cost_usd" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"error" text
);--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['seo_llm_batches', 'seo_agent_llm_providers', 'seo_agent_llm_models', 'seo_agent_llm_budget', 'seo_agent_llm_budgets'] LOOP
    IF to_regclass(quote_ident(t)) IS NOT NULL THEN
      EXECUTE format('INSERT INTO %I SELECT (jsonb_populate_record(NULL::%I, a.item)).* FROM llm_config_archive a WHERE a.source = %L ON CONFLICT DO NOTHING', t, t, t);
    END IF;
  END LOOP;
END $$;--> statement-breakpoint
DROP TABLE IF EXISTS "llm_config_archive";--> statement-breakpoint
DELETE FROM "schema_migrations" WHERE "name" = '0045_litellm_only.sql';
