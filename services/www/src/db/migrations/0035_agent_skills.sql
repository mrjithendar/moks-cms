-- Agent skills (D-96, owner request 2026-11-18): writing and checking guidance the SEO agent's crews load into an
-- agent's system prompt (CrewAI Agent Skills). The default skills ship with the web app (src/lib/seo-agent/skills.ts,
-- inserted by ensureDefaultSkills: `builtin`); admins edit, disable and reset them, and add their own on
-- Automation & AI → Skills. The seo-agent reads the enabled ones through the callback API (GET /skills), never this
-- table directly.
--   agents: the crew agents a skill is for, as "<crew>.<agent>" or "<crew>.*" (validated by the web app).
--   tags:   when it applies: empty = every run of those agents; otherwise any one tag of the run (from the ML and
--           Search Console signals the run carries: intent:troubleshooting, source:ml, category:low_ctr, topic:<slug>…).
-- Additive. Rollback: src/db/rollback/0035_agent_skills.down.sql (manual).
CREATE TABLE IF NOT EXISTS "seo_agent_skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL UNIQUE CHECK ("name" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("name") <= 64),
	"description" text NOT NULL CHECK (char_length("description") BETWEEN 1 AND 1024),
	"instructions" text NOT NULL CHECK (char_length("instructions") BETWEEN 1 AND 8000),
	"agents" text[] NOT NULL CHECK (cardinality("agents") BETWEEN 1 AND 20),
	"tags" text[] DEFAULT '{}'::text[] NOT NULL CHECK (cardinality("tags") <= 20),
	"enabled" boolean DEFAULT true NOT NULL,
	"builtin" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text
);
