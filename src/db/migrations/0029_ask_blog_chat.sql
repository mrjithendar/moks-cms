-- Ask the Blog sitewide chat (D-90, docs/seo/RAG.md "Sitewide chat").
-- standalone: a follow-up's rewrite by the seo-agent's condense step (null when the question stood alone).
-- feedback_token: random 128-bit handle handed to the widget with the answer; the reader's Helpful / Not helpful is
-- matched on it (POST /api/ask/feedback), never on the row id. feedback: 1 helpful, -1 not helpful.
-- The seo-agent checks for these columns once per process, so either side can deploy first.
-- Rollback: src/db/rollback/0029_ask_blog_chat.down.sql (manual).
ALTER TABLE "seo_ask_log" ADD COLUMN IF NOT EXISTS "standalone" text;--> statement-breakpoint
ALTER TABLE "seo_ask_log" ADD COLUMN IF NOT EXISTS "feedback_token" text;--> statement-breakpoint
ALTER TABLE "seo_ask_log" ADD COLUMN IF NOT EXISTS "feedback" smallint;--> statement-breakpoint
ALTER TABLE "seo_ask_log" ADD COLUMN IF NOT EXISTS "feedback_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "seo_ask_log_feedback_token_idx" ON "seo_ask_log" ("feedback_token") WHERE "feedback_token" IS NOT NULL;
