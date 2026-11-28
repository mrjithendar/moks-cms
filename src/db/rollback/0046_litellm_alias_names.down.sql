-- Manual rollback of 0046_litellm_alias_names.sql (never applied automatically): the old alias names come back wherever
-- the new ones are a whole value, including ones chosen after 0046. Deploy the release before D-111 with it, and keep
-- (or add again) moks-cms-default and moks-cms-fast in LiteLLM.
CREATE OR REPLACE FUNCTION d111_old_alias(j jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT replace(replace(j::text, '"cms-claude-sonnet-latest"', '"moks-cms-default"'), '"ops-claude-haiku-latest"', '"moks-cms-fast"')::jsonb
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
      EXECUTE format('UPDATE %I SET %I = d111_old_alias(%I) WHERE %I <> d111_old_alias(%I)', r.tbl, r.col, r.col, r.col, r.col);
    END IF;
  END LOOP;
END $$;--> statement-breakpoint
UPDATE "news_writing_profiles" SET "model" = CASE "model" WHEN 'cms-claude-sonnet-latest' THEN 'moks-cms-default' ELSE 'moks-cms-fast' END
WHERE "model" IN ('cms-claude-sonnet-latest', 'ops-claude-haiku-latest');--> statement-breakpoint
DROP FUNCTION IF EXISTS d111_old_alias(jsonb);--> statement-breakpoint
DELETE FROM "schema_migrations" WHERE "name" = '0046_litellm_alias_names.sql';
