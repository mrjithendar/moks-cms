-- LiteLLM is the only LLM gateway (D-110): providers, models, provider keys, routing and budgets live in LiteLLM. This
-- removes what the CMS still kept of its own, after copying it to llm_config_archive (one row per archived item: where
-- it came from, the item, when). Sealed provider keys are never copied: nothing uses them any more, LiteLLM holds the
-- keys now, and a copy would only keep a secret alive.
-- 1. Archived, then dropped: the SEO agent's provider registry (seo_agent_llm_providers, seo_agent_llm_models), its
--    budget tables (seo_agent_llm_budget, seo_agent_llm_budgets) and the Message Batches ledger (seo_llm_batches). The
--    agent created the first four at run time, perhaps as its own database role: a table this migration's role may not
--    drop is kept (archive included), with a NOTICE, and can be dropped by its owner later.
-- 2. Retired settings fields, archived, then removed: the SEO settings' LLM provider, model, base URL, region and sealed
--    key, the draft and classify models and effort, AI visibility's per-answer price and model ids; the practice
--    tutor's provider, model, base URL, region, sealed key, prices and daily USD budget; Ask the Blog's daily budget;
--    the content flows' LLM USD caps.
-- 3. Stored Claude model ids become LiteLLM aliases (archived first): Haiku → moks-cms-fast, Opus → moks-cms-quality,
--    any other Claude id → moks-cms-default (all three are added by hand in LiteLLM's Admin UI). In the `news`
--    setting, the content flows' jobs and their versions, writing profiles, crew overlays and spec crews.
-- Nothing else is touched: seo_llm_usage keeps every row (its new rows are what LiteLLM charged), seo_drafts keeps its
-- batch columns (no longer written).
-- Rollback: src/db/rollback/0045_litellm_only.down.sql.
CREATE TABLE IF NOT EXISTS "llm_config_archive" (
	"id" bigserial PRIMARY KEY,
	"source" text NOT NULL,
	"item" jsonb NOT NULL,
	"archived_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE OR REPLACE FUNCTION d110_alias(m text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN m IS NULL OR m !~* '^(anthropic/)?claude-' THEN m
    WHEN m ~* 'haiku' THEN 'moks-cms-fast'
    WHEN m ~* 'opus' THEN 'moks-cms-quality'
    ELSE 'moks-cms-default'
  END
$$;--> statement-breakpoint
-- A spec crew: its default `model` and each of `agents[].model`.
CREATE OR REPLACE FUNCTION d110_spec(s jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN s IS NULL OR jsonb_typeof(s) <> 'object' THEN s ELSE
    (CASE WHEN jsonb_typeof(s->'model') = 'string' THEN jsonb_set(s, '{model}', to_jsonb(d110_alias(s->>'model'))) ELSE s END)
    || CASE WHEN jsonb_typeof(s->'agents') = 'array' AND jsonb_array_length(s->'agents') > 0 THEN jsonb_build_object('agents', (
      SELECT jsonb_agg(CASE WHEN jsonb_typeof(a->'model') = 'string' THEN jsonb_set(a, '{model}', to_jsonb(d110_alias(a->>'model'))) ELSE a END ORDER BY i)
      FROM jsonb_array_elements(s->'agents') WITH ORDINALITY AS x(a, i))) ELSE '{}'::jsonb END
  END
$$;--> statement-breakpoint
-- A crew overlay: `agents.<key>.model`.
CREATE OR REPLACE FUNCTION d110_overlay(c jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN c IS NULL OR jsonb_typeof(c->'agents') <> 'object' OR c->'agents' = '{}'::jsonb THEN c ELSE
    jsonb_set(c, '{agents}', (SELECT jsonb_object_agg(k, CASE WHEN jsonb_typeof(v->'model') = 'string' THEN jsonb_set(v, '{model}', to_jsonb(d110_alias(v->>'model'))) ELSE v END) FROM jsonb_each(c->'agents') AS e(k, v)))
  END
$$;--> statement-breakpoint
-- A content flow job's config: `models.<agent>` and the retired `budget.llm_daily_usd` / `budget.llm_monthly_usd`.
CREATE OR REPLACE FUNCTION d110_job(c jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN c IS NULL OR jsonb_typeof(c) <> 'object' THEN c ELSE
    (CASE WHEN jsonb_typeof(c->'models') = 'object' AND c->'models' <> '{}'::jsonb
      THEN jsonb_set(c, '{models}', (SELECT jsonb_object_agg(k, to_jsonb(d110_alias(v))) FROM jsonb_each_text(c->'models') AS e(k, v)))
      ELSE c END) #- '{budget,llm_daily_usd}' #- '{budget,llm_monthly_usd}'
  END
$$;--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['seo_agent_llm_models', 'seo_agent_llm_providers', 'seo_agent_llm_budget', 'seo_agent_llm_budgets', 'seo_llm_batches'] LOOP
    IF to_regclass(quote_ident(t)) IS NOT NULL THEN
      BEGIN
        EXECUTE format('INSERT INTO llm_config_archive (source, item) SELECT %L, to_jsonb(x) - ''key_sealed'' FROM %I x', t, t);
        EXECUTE format('DROP TABLE %I', t);
      EXCEPTION WHEN insufficient_privilege OR dependent_objects_still_exist THEN
        RAISE NOTICE 'D-110: table % kept (%); its owner can drop it once nothing uses it', t, SQLERRM;
      END;
    END IF;
  END LOOP;
END $$;--> statement-breakpoint
INSERT INTO "llm_config_archive" ("source", "item")
SELECT 'setting:' || "key", CASE "key"
  WHEN 'seo' THEN jsonb_build_object('llm', "value"->'llm', 'drafts', jsonb_build_object('draftModel', "value"#>'{drafts,draftModel}', 'classifyModel', "value"#>'{drafts,classifyModel}', 'effort', "value"#>'{drafts,effort}'), 'aiVisibility', jsonb_build_object('costPerAnswerUsd', "value"#>'{aiVisibility,costPerAnswerUsd}', 'models', "value"#>'{aiVisibility,models}'), 'llmKeySaved', COALESCE(jsonb_typeof("value"->'llmKey') = 'object', false))
  WHEN 'practice' THEN jsonb_build_object('ai', COALESCE("value"->'ai', '{}'::jsonb) - 'apiKey', 'aiKeySaved', COALESCE(jsonb_typeof("value"#>'{ai,apiKey}') = 'object', false), 'aiDailyBudgetUsd', "value"#>'{quotas,aiDailyBudgetUsd}')
  WHEN 'ask_blog' THEN jsonb_build_object('dailyBudgetUsd', "value"->'dailyBudgetUsd')
  WHEN 'news' THEN jsonb_build_object('llm_daily_usd', "value"->'llm_daily_usd', 'llm_monthly_usd', "value"->'llm_monthly_usd', 'writer_model', "value"->'writer_model', 'fast_model', "value"->'fast_model', 'vision_model', "value"->'vision_model')
END
FROM "setting" WHERE jsonb_typeof("value") = 'object' AND CASE "key"
  WHEN 'seo' THEN "value" ? 'llmKey' OR COALESCE("value"->'llm' ?| ARRAY['provider', 'model', 'baseUrl', 'region'], false) OR COALESCE("value"->'drafts' ?| ARRAY['draftModel', 'classifyModel', 'effort'], false) OR COALESCE("value"->'aiVisibility' ?| ARRAY['costPerAnswerUsd', 'models'], false)
  WHEN 'practice' THEN COALESCE("value"->'ai' ?| ARRAY['provider', 'model', 'baseUrl', 'region', 'apiKey', 'inputUsdPerMTok', 'outputUsdPerMTok'], false) OR COALESCE("value"->'quotas' ? 'aiDailyBudgetUsd', false)
  WHEN 'ask_blog' THEN "value" ? 'dailyBudgetUsd'
  WHEN 'news' THEN "value" ?| ARRAY['llm_daily_usd', 'llm_monthly_usd'] OR COALESCE("value"->>'writer_model', '') ~* '^(anthropic/)?claude-' OR COALESCE("value"->>'fast_model', '') ~* '^(anthropic/)?claude-' OR COALESCE("value"->>'vision_model', '') ~* '^(anthropic/)?claude-'
  ELSE false
END;--> statement-breakpoint
UPDATE "setting" SET "value" = ("value" - 'llmKey') #- '{llm,provider}' #- '{llm,model}' #- '{llm,baseUrl}' #- '{llm,region}' #- '{drafts,draftModel}' #- '{drafts,classifyModel}' #- '{drafts,effort}' #- '{aiVisibility,costPerAnswerUsd}' #- '{aiVisibility,models}'
WHERE "key" = 'seo' AND jsonb_typeof("value") = 'object';--> statement-breakpoint
UPDATE "setting" SET "value" = "value" #- '{ai,provider}' #- '{ai,model}' #- '{ai,baseUrl}' #- '{ai,region}' #- '{ai,apiKey}' #- '{ai,inputUsdPerMTok}' #- '{ai,outputUsdPerMTok}' #- '{quotas,aiDailyBudgetUsd}'
WHERE "key" = 'practice' AND jsonb_typeof("value") = 'object';--> statement-breakpoint
UPDATE "setting" SET "value" = "value" - 'dailyBudgetUsd' WHERE "key" = 'ask_blog' AND jsonb_typeof("value") = 'object';--> statement-breakpoint
UPDATE "setting" SET "value" = ("value" - 'llm_daily_usd' - 'llm_monthly_usd')
  || CASE WHEN jsonb_typeof("value"->'writer_model') = 'string' THEN jsonb_build_object('writer_model', d110_alias("value"->>'writer_model')) ELSE '{}'::jsonb END
  || CASE WHEN jsonb_typeof("value"->'fast_model') = 'string' THEN jsonb_build_object('fast_model', d110_alias("value"->>'fast_model')) ELSE '{}'::jsonb END
  || CASE WHEN jsonb_typeof("value"->'vision_model') = 'string' THEN jsonb_build_object('vision_model', d110_alias("value"->>'vision_model')) ELSE '{}'::jsonb END
WHERE "key" = 'news' AND jsonb_typeof("value") = 'object';--> statement-breakpoint
-- Stored model ids in tables (each guarded: a table a site never got is skipped). The old value is archived first.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('news_jobs', 'config', 'd110_job'),
    ('news_job_versions', 'snapshot', 'd110_job'),
    ('seo_crew_configs', 'config', 'd110_overlay'),
    ('seo_custom_crews', 'spec', 'd110_spec'),
    ('crewai_crews', 'spec', 'd110_spec'),
    ('crewai_spec_versions', 'spec', 'd110_spec')
  ) AS t(tbl, col, fn) LOOP
    IF to_regclass(quote_ident(r.tbl)) IS NOT NULL AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = r.tbl AND column_name = r.col AND table_schema = current_schema()) THEN
      EXECUTE format('INSERT INTO llm_config_archive (source, item) SELECT %L, jsonb_build_object(''row'', to_jsonb(x) - %L, %L, x.%I) FROM %I x WHERE x.%I::text <> %I(x.%I)::text', r.tbl || '.' || r.col, r.col, r.col, r.col, r.tbl, r.col, r.fn, r.col);
      EXECUTE format('UPDATE %I SET %I = %I(%I) WHERE %I::text <> %I(%I)::text', r.tbl, r.col, r.fn, r.col, r.col, r.fn, r.col);
    END IF;
  END LOOP;
  IF to_regclass('news_writing_profiles') IS NOT NULL THEN
    INSERT INTO llm_config_archive (source, item) SELECT 'news_writing_profiles.model', jsonb_build_object('row', to_jsonb(x) - 'model', 'model', x.model) FROM news_writing_profiles x WHERE x.model IS DISTINCT FROM d110_alias(x.model);
    UPDATE news_writing_profiles SET model = d110_alias(model) WHERE model IS DISTINCT FROM d110_alias(model);
  END IF;
END $$;--> statement-breakpoint
DROP FUNCTION IF EXISTS d110_job(jsonb);--> statement-breakpoint
DROP FUNCTION IF EXISTS d110_overlay(jsonb);--> statement-breakpoint
DROP FUNCTION IF EXISTS d110_spec(jsonb);--> statement-breakpoint
DROP FUNCTION IF EXISTS d110_alias(text);
