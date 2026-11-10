-- Manual rollback of 0016_seo_v4.sql (never applied automatically; deletes v4 flow-run history, draft notes and every
-- MCP client, grant and token). Run newest first. R2 report PDFs are left in the bucket (prefix jithendar/www/reports/).
DROP TABLE IF EXISTS "seo_mcp_tokens";--> statement-breakpoint
DROP TABLE IF EXISTS "seo_mcp_codes";--> statement-breakpoint
DROP TABLE IF EXISTS "seo_mcp_grants";--> statement-breakpoint
DROP TABLE IF EXISTS "seo_mcp_clients";--> statement-breakpoint
DROP TABLE IF EXISTS "seo_draft_notes";--> statement-breakpoint
DROP TABLE IF EXISTS "seo_flow_runs";--> statement-breakpoint
DELETE FROM "schema_migrations" WHERE "name" = '0016_seo_v4.sql';
