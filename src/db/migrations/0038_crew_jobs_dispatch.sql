-- Crew jobs are started by the one dispatcher (moks-seo-agent app/news/dispatch.py, from POST /schedules/dispatch every
-- minute) since 2026-11-21; news_dispatch_flow keeps the daily housekeeping and the gauges. The built-in schedule row
-- that runs it keeps its name and time; only what it says changes (AI & SEO → Jobs → System jobs). A description an
-- admin already changed is left alone.
-- Additive. Rollback: src/db/rollback/0038_crew_jobs_dispatch.down.sql (manual).
UPDATE "seo_flow_schedules"
SET "description" = 'Crew jobs: daily clean-up and gauges. The jobs themselves start on their own times (the one dispatcher).', "updated_at" = now(), "updated_by" = 'migration 0038'
WHERE "name" = 'news-dispatch' AND "builtin" AND "description" = 'Starts each news job that is due (their times are set in Admin → News) and the daily news housekeeping.';
