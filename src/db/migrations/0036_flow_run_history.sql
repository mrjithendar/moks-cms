-- Run history for the CrewAI console (/admin/crewai, owner request 2026-11-18): every SEO agent flow run gets a number,
-- a step list, a log and (while Run history → transcripts is on) its model calls' prompts and answers, so a run reads
-- like a GitHub Actions run. Written by the seo-agent (moks-seo-agent/app/run_history.py; grants in
-- moks-seo-agent/scripts/db-role.sql), read by the admin. The daily `retention` job deletes log lines and transcripts
-- older than the Run history settings; steps stay with their run.
--   seo_flow_runs.run_number  #N per flow, given on insert by a trigger (seo_flow_run_counters), so the agent's insert
--                             is unchanged. Existing runs are numbered by start time.
--   seo_flow_run_steps        one row per flow step (SeoFlow.step): running → succeeded | failed | cancelled.
--   seo_flow_run_logs         the run's log lines: the agent's own structured log records that belong to the run.
--   seo_flow_run_calls        model-call transcripts: system prompt, prompt, answer, tokens and cost.
-- Additive. Rollback: src/db/rollback/0036_flow_run_history.down.sql (manual).
ALTER TABLE "seo_flow_runs" ADD COLUMN IF NOT EXISTS "run_number" integer;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "seo_flow_run_counters" (
	"flow_name" text PRIMARY KEY NOT NULL,
	"last_number" integer NOT NULL
);--> statement-breakpoint
UPDATE "seo_flow_runs" r SET "run_number" = n."n"
FROM (SELECT "run_id", row_number() OVER (PARTITION BY "flow_name" ORDER BY "started_at", "run_id")::int AS "n" FROM "seo_flow_runs") n
WHERE r."run_id" = n."run_id" AND r."run_number" IS NULL;--> statement-breakpoint
INSERT INTO "seo_flow_run_counters" ("flow_name", "last_number")
SELECT "flow_name", max("run_number") FROM "seo_flow_runs" WHERE "run_number" IS NOT NULL GROUP BY "flow_name"
ON CONFLICT ("flow_name") DO UPDATE SET "last_number" = GREATEST("seo_flow_run_counters"."last_number", EXCLUDED."last_number");--> statement-breakpoint
-- SECURITY DEFINER: the agent's own role (scripts/db-role.sql) inserts runs but has no grant on the counters.
-- A second active run for the same flow + target is refused by seo_flow_runs_one_active, so it takes no number.
CREATE OR REPLACE FUNCTION "seo_flow_run_number"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW."run_number" IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF NEW."status" IN ('queued', 'running') AND EXISTS (
    SELECT 1 FROM "seo_flow_runs" WHERE "flow_name" = NEW."flow_name" AND "target_id" = NEW."target_id" AND "status" IN ('queued', 'running')
  ) THEN
    RETURN NEW;
  END IF;
  INSERT INTO "seo_flow_run_counters" AS c ("flow_name", "last_number") VALUES (NEW."flow_name", 1)
  ON CONFLICT ("flow_name") DO UPDATE SET "last_number" = c."last_number" + 1
  RETURNING c."last_number" INTO NEW."run_number";
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "seo_flow_runs_number" ON "seo_flow_runs";--> statement-breakpoint
CREATE TRIGGER "seo_flow_runs_number" BEFORE INSERT ON "seo_flow_runs" FOR EACH ROW EXECUTE FUNCTION "seo_flow_run_number"();--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_flow_runs_number_idx" ON "seo_flow_runs" ("flow_name", "run_number" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_flow_runs_started_idx" ON "seo_flow_runs" ("started_at" DESC);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "seo_flow_run_steps" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL REFERENCES "seo_flow_runs"("run_id") ON DELETE CASCADE,
	"seq" integer NOT NULL,
	"step" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL CHECK ("status" IN ('running', 'succeeded', 'failed', 'cancelled')),
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"error" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_flow_run_steps_run_idx" ON "seo_flow_run_steps" ("run_id", "seq");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "seo_flow_run_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL REFERENCES "seo_flow_runs"("run_id") ON DELETE CASCADE,
	"step" text,
	"level" text DEFAULT 'info' NOT NULL CHECK ("level" IN ('debug', 'info', 'warning', 'error')),
	"logger" text,
	"event" text,
	"message" text NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_flow_run_logs_run_idx" ON "seo_flow_run_logs" ("run_id", "id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_flow_run_logs_at_idx" ON "seo_flow_run_logs" ("at");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "seo_flow_run_calls" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL REFERENCES "seo_flow_runs"("run_id") ON DELETE CASCADE,
	"step" text,
	"agent" text,
	"purpose" text,
	"model" text,
	"outcome" text DEFAULT 'ok' NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"latency_ms" integer,
	"system" text,
	"prompt" text,
	"response" text,
	"error" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_flow_run_calls_run_idx" ON "seo_flow_run_calls" ("run_id", "id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_flow_run_calls_at_idx" ON "seo_flow_run_calls" ("at");
