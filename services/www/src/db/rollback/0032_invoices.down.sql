-- Manual rollback of 0032_invoices.sql (never applied automatically; deletes every invoice and the number sequences,
-- not the PDFs in R2 under jithendar/www/invoices/ and not the payment links in Razorpay).
DROP TABLE IF EXISTS "invoice";--> statement-breakpoint
DROP TABLE IF EXISTS "invoice_counter";--> statement-breakpoint
DELETE FROM "schema_migrations" WHERE "name" = '0032_invoices.sql';
