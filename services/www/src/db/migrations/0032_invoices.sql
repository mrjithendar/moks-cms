-- Invoices sent to clients from Admin → Invoices (lib/invoices.ts, docs/INVOICES.md): numbered when first sent, paid
-- through a Razorpay payment link or marked paid by hand, with the PDF stored in R2. Amounts are integers in the
-- currency's smallest unit. invoice_counter hands out the numbers, one sequence per prefix and year, without gaps.
-- Additive. Rollback: src/db/rollback/0032_invoices.down.sql (manual).
CREATE TABLE IF NOT EXISTS "invoice" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "number" text,
  -- draft | sent | paid | void
  "status" text NOT NULL DEFAULT 'draft',
  -- The client's link is /invoice/<token>: 32 random bytes, the only thing that opens the invoice without signing in.
  "token" text NOT NULL,
  "client_name" text NOT NULL,
  "client_email" text NOT NULL,
  "client_company" text,
  "client_address" text,
  "client_tax_id" text,
  "currency" text NOT NULL,
  "items" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "subtotal" integer NOT NULL DEFAULT 0,
  "tax_label" text,
  "tax_rate_bp" integer NOT NULL DEFAULT 0,
  "tax_amount" integer NOT NULL DEFAULT 0,
  "total" integer NOT NULL DEFAULT 0,
  "notes" text,
  "issue_date" text,
  "due_date" text,
  "seller" jsonb,
  "payment_link_id" text,
  "payment_link_url" text,
  -- created | cancelled | expired | paid
  "payment_link_status" text,
  "payment_id" text,
  -- razorpay | manual
  "paid_via" text,
  "payment_note" text,
  "pdf_key" text,
  -- The status the stored PDF shows; it is rendered again when the invoice has moved on.
  "pdf_status" text,
  "emailed_at" timestamp with time zone,
  "sent_at" timestamp with time zone,
  "paid_at" timestamp with time zone,
  "voided_at" timestamp with time zone,
  "created_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "invoice_number_key" ON "invoice" ("number");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "invoice_token_key" ON "invoice" ("token");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "invoice_payment_link_key" ON "invoice" ("payment_link_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoice_status_idx" ON "invoice" ("status", "created_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "invoice_counter" (
  "series" text PRIMARY KEY NOT NULL,
  "last" integer NOT NULL DEFAULT 0
);
