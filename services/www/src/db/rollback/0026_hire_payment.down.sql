-- Manual rollback of 0026_hire_payment.sql (never applied automatically; deletes the stored payment records, not Razorpay's).
DROP TABLE IF EXISTS "hire_payment";--> statement-breakpoint
DELETE FROM "schema_migrations" WHERE "name" = '0026_hire_payment.sql';
