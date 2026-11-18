-- Manual rollback of 0035_agent_skills.sql (never applied automatically). Admin-added skills are lost; the crews run
-- without skills (the seo-agent treats a missing /skills answer as "no skills").
DROP TABLE IF EXISTS "seo_agent_skills";--> statement-breakpoint
DELETE FROM "schema_migrations" WHERE "name" = '0035_agent_skills.sql';
