-- Hire me enquiries (/hire-me) land in the same inbox as contact messages. Additive only, nullable. Rollback:
-- src/db/rollback/0023_contact_enquiry.down.sql (manual).
-- kind: consulting | freelance | speaking | mentoring | other (NULL = a plain contact-form message).
-- details: {company, budget, timeline} as entered (validated in src/lib/contact.ts, at most 300 characters each).
ALTER TABLE "contact_message" ADD COLUMN IF NOT EXISTS "kind" text;--> statement-breakpoint
ALTER TABLE "contact_message" ADD COLUMN IF NOT EXISTS "details" jsonb;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contact_kind_idx" ON "contact_message" ("kind", "created_at") WHERE "kind" IS NOT NULL;
