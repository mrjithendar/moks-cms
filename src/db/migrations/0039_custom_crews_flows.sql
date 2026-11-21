-- Custom crews and custom flows made in the admin (crew-jobs plan PR 6; admin-settings plan P4): AI & SEO → Crews →
-- New crew and AI & SEO → Flows → New flow. A row is one spec (its latest version); the seo-agent checks every spec
-- before it is saved (POST /custom/validate) and again before each run, and reads the enabled ones through
-- GET /internal/seo-agent/custom-crews and /custom-flows (moks-seo-agent app/crews/custom.py, app/flows/custom.py).
-- Deleting keeps the row (deleted_at): run history that names it stays readable.
-- Additive. Rollback: src/db/rollback/0039_custom_crews_flows.down.sql (manual).
CREATE TABLE IF NOT EXISTS "seo_custom_crews" (
	"key" text PRIMARY KEY NOT NULL CHECK ("key" ~ '^[a-z][a-z0-9_]{1,39}$'),
	"label" text NOT NULL CHECK (char_length("label") BETWEEN 2 AND 120),
	"spec" jsonb NOT NULL CHECK (jsonb_typeof("spec") = 'object'),
	"version" integer DEFAULT 1 NOT NULL CHECK ("version" >= 1),
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	"deleted_at" timestamp with time zone
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "seo_custom_flows" (
	"key" text PRIMARY KEY NOT NULL CHECK ("key" ~ '^[a-z][a-z0-9_]{1,39}$'),
	"label" text NOT NULL CHECK (char_length("label") BETWEEN 2 AND 120),
	"spec" jsonb NOT NULL CHECK (jsonb_typeof("spec") = 'object'),
	"version" integer DEFAULT 1 NOT NULL CHECK ("version" >= 1),
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	"deleted_at" timestamp with time zone
);
