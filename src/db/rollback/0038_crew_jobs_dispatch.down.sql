-- Manual rollback of 0038_crew_jobs_dispatch.sql (never applied automatically): the news-dispatch row's earlier text.
UPDATE "seo_flow_schedules"
SET "description" = 'Starts each news job that is due (their times are set in Admin → News) and the daily news housekeeping.', "updated_at" = now(), "updated_by" = 'rollback 0038'
WHERE "name" = 'news-dispatch' AND "builtin" AND "updated_by" = 'migration 0038';--> statement-breakpoint
DELETE FROM "schema_migrations" WHERE "name" = '0038_crew_jobs_dispatch.sql';
