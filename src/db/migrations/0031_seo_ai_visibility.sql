-- AI visibility (docs/seo/AI_VISIBILITY.md): prompts asked to AI assistants on a schedule, and their answers with the
-- sources they cited. Additive. Rollback: src/db/rollback/0031_seo_ai_visibility.down.sql (manual).
CREATE TABLE IF NOT EXISTS "seo_ai_prompts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prompt" text NOT NULL,
	-- manual | search_console | tracked_keyword
	"source" text DEFAULT 'manual' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"added_by" text,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "seo_ai_prompts_prompt_key" ON "seo_ai_prompts" (lower("prompt"));--> statement-breakpoint
-- One answer per prompt, assistant and day.
CREATE TABLE IF NOT EXISTS "seo_ai_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prompt_id" uuid NOT NULL REFERENCES "seo_ai_prompts" ("id") ON DELETE CASCADE,
	-- claude | chatgpt | perplexity | gemini | google_ai_overview
	"provider" text NOT NULL,
	"model" text,
	"run_on" date NOT NULL,
	-- the answer text, truncated to 8,000 characters
	"answer" text,
	-- [{ "url", "title", "domain" }] in the order the assistant gave them
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	-- this site is among the sources
	"cited" boolean DEFAULT false NOT NULL,
	"cited_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	-- the site's name appears in the answer text
	"mentioned" boolean DEFAULT false NOT NULL,
	-- 1-based rank of the first source on this site, null when not cited
	"cited_rank" integer,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seo_ai_answers_prompt_provider_day_key" UNIQUE ("prompt_id", "provider", "run_on")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_ai_answers_run_on_idx" ON "seo_ai_answers" ("run_on");
