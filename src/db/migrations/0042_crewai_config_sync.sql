-- CrewAI configuration as files (D-101, docs/seo/CREWCONFIG.md): every export to the site's repository and every import
-- of a configuration bundle (from the admin, the repository, a deployment or the API) is a row here. It is the audit
-- trail of configuration changes that come from outside the admin's pages, and it holds what drift detection and the
-- conflict rule of an import compare with:
--   baseline   "kind:id" → checksum of every item as it stood after this sync (a person's changes on the admin pages
--              since then are drift; an import overwrites such a change only when asked to). Null for plans and failures.
--   snapshot   the configuration as it was before an applied import changed anything (rollback re-imports it). Only
--              kept when the import changed something.
--   revision   the Git commit the bundle came from (a deployment, the repository), or the one an export wrote.
-- Nothing else reads or changes the configuration tables differently because of this table.
-- Rollback: src/db/rollback/0042_crewai_config_sync.down.sql (manual).
CREATE TABLE IF NOT EXISTS "crewai_config_syncs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"direction" text NOT NULL CHECK ("direction" IN ('import', 'export')),
	"mode" text NOT NULL CHECK ("mode" IN ('dry_run', 'apply')),
	"source" text NOT NULL CHECK ("source" IN ('admin', 'repository', 'deploy', 'api', 'rollback')),
	"status" text NOT NULL CHECK ("status" IN ('planned', 'applied', 'unchanged', 'failed', 'refused')),
	"policy" text CHECK ("policy" IS NULL OR "policy" IN ('skip', 'overwrite', 'fail')),
	"revision" text CHECK ("revision" IS NULL OR "revision" ~ '^[0-9a-f]{7,64}$'),
	"ref" text CHECK ("ref" IS NULL OR char_length("ref") <= 200),
	"bundle_checksum" text,
	"runtime_checksum" text,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"plan" jsonb,
	"error" text,
	"baseline" jsonb,
	"snapshot" jsonb,
	"url" text CHECK ("url" IS NULL OR char_length("url") <= 500),
	"actor" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "crewai_config_syncs_created_idx" ON "crewai_config_syncs" ("created_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "crewai_config_syncs_baseline_idx" ON "crewai_config_syncs" ("created_at" DESC) WHERE "baseline" IS NOT NULL;
