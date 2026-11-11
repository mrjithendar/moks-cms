-- Cal.com bookings received by the webhook (/api/cal/webhook), shown in Admin → Bookings. One row per booking uid;
-- later events (rescheduled, cancelled, rejected) update it. Rollback: src/db/rollback/0024_cal_booking.down.sql (manual).
CREATE TABLE IF NOT EXISTS "cal_booking" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "uid" text NOT NULL,
  "status" text NOT NULL,
  "title" text NOT NULL DEFAULT '',
  "event_type" text,
  "start_time" timestamp with time zone,
  "end_time" timestamp with time zone,
  "attendee_name" text,
  "attendee_email" text,
  "attendee_time_zone" text,
  "location" text,
  "notes" text,
  "cancellation_reason" text,
  "rescheduled_from" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cal_booking_uid_key" ON "cal_booking" ("uid");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cal_booking_start_idx" ON "cal_booking" ("start_time");
