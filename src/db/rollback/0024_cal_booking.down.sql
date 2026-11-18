-- Manual rollback of 0024_cal_booking.sql (never applied automatically; deletes the stored bookings, not Cal.com's).
DROP TABLE IF EXISTS "cal_booking";--> statement-breakpoint
DELETE FROM "schema_migrations" WHERE "name" = '0024_cal_booking.sql';
