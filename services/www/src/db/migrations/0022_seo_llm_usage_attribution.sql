-- LLM cost attribution (docs/seo/RAG.md "LLM accounting"). Additive only, nullable. Rollback:
-- src/db/rollback/0022_seo_llm_usage_attribution.down.sql (manual).
-- run_id: the seo-agent flow run (seo_flow_runs.run_id) or news run that made the call; agent: the crew agent's role.
-- Text, not foreign keys: rows outlive pruned runs, and news runs live in another table. The seo-agent writes them only
-- once these columns exist (it checks information_schema), so either side may be deployed first.
ALTER TABLE "seo_llm_usage" ADD COLUMN IF NOT EXISTS "run_id" text;--> statement-breakpoint
ALTER TABLE "seo_llm_usage" ADD COLUMN IF NOT EXISTS "agent" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_llm_usage_run_idx" ON "seo_llm_usage" ("run_id") WHERE "run_id" IS NOT NULL;
