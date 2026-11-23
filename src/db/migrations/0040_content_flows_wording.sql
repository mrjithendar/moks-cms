-- AI & SEO has flows and crews only since 2026-11-23: a crew job is a content flow (still a news_jobs row), the Jobs page
-- is gone and the built-in schedules ("system jobs") are AI & SEO → Flows → Schedules. The built-in schedule row that
-- runs the content flows' housekeeping keeps its name and time; only what it says changes. A description an admin
-- already changed is left alone.
-- Additive. Rollback: src/db/rollback/0040_content_flows_wording.down.sql (manual).
UPDATE "seo_flow_schedules"
SET "description" = 'Content flows: daily clean-up and gauges. The content flows themselves start on their own times (the one dispatcher).', "updated_at" = now(), "updated_by" = 'migration 0040'
WHERE "name" = 'news-dispatch' AND "builtin" AND "description" = 'Crew jobs: daily clean-up and gauges. The jobs themselves start on their own times (the one dispatcher).';
