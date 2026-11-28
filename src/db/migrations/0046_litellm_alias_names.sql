-- The site's two LiteLLM aliases are renamed (D-111): moks-cms-default → cms-claude-sonnet-latest, moks-cms-fast →
-- ops-claude-haiku-latest. Migration 0045 and admins stored the old names: settings, content flows and their versions,
-- writing profiles, crew overlays, crews, flows and schedule inputs. A name is renamed only where it is a whole value
-- (a JSON string, or a writing profile's model), never inside a longer text. moks-cms-quality and the AI visibility
-- aliases keep their names. What a call was charged under (seo_llm_usage, run history, drafts) is history and stays.
-- Rollback: src/db/rollback/0046_litellm_alias_names.down.sql.
CREATE OR REPLACE FUNCTION d111_alias(j jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT replace(replace(j::text, '"moks-cms-default"', '"cms-claude-sonnet-latest"'), '"moks-cms-fast"', '"ops-claude-haiku-latest"')::jsonb
$$;--> statement-breakpoint
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('setting', 'value'),
    ('news_jobs', 'config'),
    ('news_job_versions', 'snapshot'),
    ('seo_crew_configs', 'config'),
    ('seo_custom_crews', 'spec'),
    ('seo_custom_flows', 'spec'),
    ('crewai_crews', 'spec'),
    ('crewai_flows', 'spec'),
    ('crewai_spec_versions', 'spec'),
    ('seo_flow_schedules', 'inputs'),
    ('seo_flow_schedules', 'default_inputs')
  ) AS t(tbl, col) LOOP
    IF to_regclass(quote_ident(r.tbl)) IS NOT NULL THEN
      EXECUTE format('UPDATE %I SET %I = d111_alias(%I) WHERE %I <> d111_alias(%I)', r.tbl, r.col, r.col, r.col, r.col);
    END IF;
  END LOOP;
END $$;--> statement-breakpoint
UPDATE "news_writing_profiles" SET "model" = CASE "model" WHEN 'moks-cms-default' THEN 'cms-claude-sonnet-latest' ELSE 'ops-claude-haiku-latest' END
WHERE "model" IN ('moks-cms-default', 'moks-cms-fast');--> statement-breakpoint
DROP FUNCTION IF EXISTS d111_alias(jsonb);
