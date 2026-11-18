-- Members-only articles (lib/members.ts): signed-out readers get the first part of the article and a sign-in prompt.
-- preview_percent overrides the site default (Admin → Advanced settings → Members-only articles) for one post.
-- Rollback: src/db/rollback/0028_members_only.down.sql (manual).
ALTER TABLE "post" ADD COLUMN IF NOT EXISTS "members_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "post" ADD COLUMN IF NOT EXISTS "preview_percent" integer;
