-- SEO platform v4: CrewAI flow runs, review notes, and the admin MCP OAuth authorization server. Purely additive.
-- Rollback: src/db/rollback/0016_seo_v4.down.sql (manual).
-- No foreign keys into older SEO tables (seo_drafts, seo_reports), so the existing manual rollbacks of 0011/0012 keep
-- working in any order; rows are looked up by id. The report narrative and PDF key live in seo_reports.payload.
-- seo_agent_runs (v3 LangGraph) is kept read-only as history; nothing writes it any more.

-- One row per CrewAI Flow run, written by seo-agent (app/runs.py), read by the admin UI, MCP and alerts.
CREATE TABLE IF NOT EXISTS "seo_flow_runs" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"flow_name" text NOT NULL,
	-- lock target: the draft id for drafting/publish flows, "site" for site-wide jobs, the period for reports
	"target_id" text NOT NULL,
	"draft_id" uuid,
	"status" text NOT NULL CHECK ("status" IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'paused_budget')),
	"current_step" text,
	"state_json" jsonb,
	"inputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"outputs" jsonb,
	"error" text,
	"tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"triggered_by" text NOT NULL CHECK ("triggered_by" IN ('cron', 'manual', 'approval', 'flow', 'mcp')),
	"correlation_id" text,
	"actor" text
);--> statement-breakpoint
-- One active run per flow + target (the advisory lock covers the running process; this survives restarts).
CREATE UNIQUE INDEX IF NOT EXISTS "seo_flow_runs_one_active" ON "seo_flow_runs" ("flow_name", "target_id") WHERE "status" IN ('queued', 'running');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_flow_runs_flow_idx" ON "seo_flow_runs" ("flow_name", "started_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_flow_runs_draft_idx" ON "seo_flow_runs" ("draft_id", "started_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_flow_runs_status_idx" ON "seo_flow_runs" ("status", "started_at" DESC);--> statement-breakpoint

-- Notes on a draft (admin MCP add_review_note, shown in the web diff view).
CREATE TABLE IF NOT EXISTS "seo_draft_notes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"draft_id" uuid NOT NULL,
	"author" text NOT NULL,
	"note" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_draft_notes_draft_idx" ON "seo_draft_notes" ("draft_id", "created_at");--> statement-breakpoint

-- Admin MCP OAuth 2.1 (src/lib/mcp-oauth): dynamically registered public clients (PKCE, no secret).
CREATE TABLE IF NOT EXISTS "seo_mcp_clients" (
	"client_id" text PRIMARY KEY NOT NULL,
	"client_name" text NOT NULL,
	"redirect_uris" text[] NOT NULL,
	"software_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
-- A grant = one admin's consent for one client: scopes and resource. Revoking it kills every token at once.
CREATE TABLE IF NOT EXISTS "seo_mcp_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL REFERENCES "seo_mcp_clients"("client_id") ON DELETE CASCADE,
	"user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
	"scopes" text[] NOT NULL,
	"resource" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_mcp_grants_user_idx" ON "seo_mcp_grants" ("user_id", "revoked_at");--> statement-breakpoint
-- Authorization codes (single use, 60 s) with the PKCE challenge; stored hashed.
CREATE TABLE IF NOT EXISTS "seo_mcp_codes" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"grant_id" uuid NOT NULL REFERENCES "seo_mcp_grants"("id") ON DELETE CASCADE,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);--> statement-breakpoint
-- Access tokens (short-lived) and refresh tokens (rotated; a reused one revokes the grant). SHA-256 hashes only.
CREATE TABLE IF NOT EXISTS "seo_mcp_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL CHECK ("kind" IN ('access', 'refresh')),
	"grant_id" uuid NOT NULL REFERENCES "seo_mcp_grants"("id") ON DELETE CASCADE,
	"client_id" text NOT NULL,
	"scopes" text[] NOT NULL,
	"resource" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_mcp_tokens_grant_idx" ON "seo_mcp_tokens" ("grant_id");
