-- Paid calls from /hire-me via Razorpay (lib/razorpay.ts), shown in Admin → Payments. One row per Razorpay order.
-- Rollback: src/db/rollback/0026_hire_payment.down.sql (manual).
CREATE TABLE IF NOT EXISTS "hire_payment" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "order_id" text NOT NULL,
  "payment_id" text,
  "status" text NOT NULL DEFAULT 'created',
  "minutes" integer NOT NULL,
  "amount" integer NOT NULL,
  "currency" text NOT NULL,
  "country" text,
  "name" text NOT NULL,
  "email" text NOT NULL,
  "topic" text,
  "failure_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "paid_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hire_payment_order_key" ON "hire_payment" ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hire_payment_status_idx" ON "hire_payment" ("status", "created_at");
