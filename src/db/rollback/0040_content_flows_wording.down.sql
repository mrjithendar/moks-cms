-- Manual rollback of 0040_content_flows_wording.sql (never applied automatically): the news-dispatch row's earlier text.
UPDATE "seo_flow_schedules"
SET "description" = 'Crew jobs: daily clean-up and gauges. The jobs themselves start on their own times (the one dispatcher).', "updated_at" = now(), "updated_by" = 'rollback 0040'
WHERE "name" = 'news-dispatch' AND "builtin" AND "updated_by" = 'migration 0040';--> statement-breakpoint
DELETE FROM "schema_migrations" WHERE "name" = '0040_content_flows_wording.sql';
