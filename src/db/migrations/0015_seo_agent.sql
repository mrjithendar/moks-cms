-- SEO platform v3: LangGraph runs (summary rows the seo-agent service writes), admin approvals that gate publishing,
-- new-article drafts from the editorial crew, and Ask-the-Blog question log + gaps. Purely additive.
-- Rollback: src/db/rollback/0015_seo_agent.down.sql (manual).
-- Not here, on purpose: LangGraph's checkpoint tables (created by the seo-agent's PostgresSaver.setup(), with their own
-- checkpoint_migrations table) and seo_article_chunks (created by seo-agent because its vector(N) column depends on the
-- embeddings model, and only when the pgvector extension is enabled; docs/seo/RAG.md).
CREATE TABLE IF NOT EXISTS "seo_agent_runs" (
	"thread_id" text PRIMARY KEY NOT NULL,
	"graph" text NOT NULL,
	-- running | interrupted | completed | failed | cancelled | paused_budget
	"status" text NOT NULL,
	"current_node" text,
	-- business result of a completed run: published | rejected | generation_failed | verify_failed | publish_failed | no_changes | done | links_added
	"outcome" text,
	"draft_id" uuid,
	"article_id" uuid,
	"calendar_id" uuid,
	"parent_thread_id" text,
	"input" jsonb,
	"interrupt" jsonb,
	"result" jsonb,
	"error" text,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_agent_runs_status_idx" ON "seo_agent_runs" ("status", "updated_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_agent_runs_draft_idx" ON "seo_agent_runs" ("draft_id");--> statement-breakpoint
-- optimize (v2 change set against a published post) | new_article (a full document for a CMS draft post)
ALTER TABLE "seo_drafts" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'optimize' NOT NULL;--> statement-breakpoint
ALTER TABLE "seo_drafts" ADD COLUMN IF NOT EXISTS "document" jsonb;--> statement-breakpoint
-- Set when a LangGraph run owns this draft (thread_id = draft id); null for the legacy (v2) path.
ALTER TABLE "seo_drafts" ADD COLUMN IF NOT EXISTS "thread_id" text;--> statement-breakpoint
ALTER TABLE "seo_drafts" ADD COLUMN IF NOT EXISTS "calendar_id" uuid REFERENCES "seo_editorial_calendar"("id") ON DELETE SET NULL;--> statement-breakpoint
-- The human approval gate (D-43). The admin approve route writes a row; the agent's publish callback is refused unless
-- an unused, unexpired row exists for that draft with exactly the accepted change ids, and the approver is still admin.
CREATE TABLE IF NOT EXISTS "seo_draft_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"draft_id" uuid NOT NULL REFERENCES "seo_drafts"("id") ON DELETE CASCADE,
	"approved_by" text NOT NULL,
	"approved_by_id" text NOT NULL,
	"accepted_change_ids" text[] NOT NULL,
	"publish_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_draft_approvals_draft_idx" ON "seo_draft_approvals" ("draft_id", "created_at" DESC);--> statement-breakpoint
-- Ask the Blog: questions without IP (optional salted hash, pruned after ASK_BLOG_RETENTION_DAYS).
CREATE TABLE IF NOT EXISTS "seo_ask_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"question" text NOT NULL,
	"normalized" text NOT NULL,
	"ip_hash" text,
	-- answered | fallback | refused | cached | budget | disabled | error
	"outcome" text NOT NULL,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cached" boolean DEFAULT false NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"index_version" text
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_ask_log_at_idx" ON "seo_ask_log" ("at" DESC);--> statement-breakpoint
-- Questions the site could not answer (fallback), clustered weekly → Keyword opportunities › Content gaps "Asked on site".
CREATE TABLE IF NOT EXISTS "seo_ask_gaps" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"normalized" text NOT NULL,
	"sample_question" text NOT NULL,
	"asked" integer DEFAULT 1 NOT NULL,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"cluster_id" integer,
	"cluster_label" text,
	-- open | sent (to the editorial calendar) | ignored | answered
	"status" text DEFAULT 'open' NOT NULL,
	"calendar_id" uuid REFERENCES "seo_editorial_calendar"("id") ON DELETE SET NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "seo_ask_gaps_normalized_idx" ON "seo_ask_gaps" ("normalized");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_ask_gaps_status_idx" ON "seo_ask_gaps" ("status", "last_seen" DESC);
