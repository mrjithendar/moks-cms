-- Sign-in with email and password now requires a verified address whenever the site can send email (src/lib/auth.ts).
-- Accounts that existed before that rule were never asked to verify (and could not be while mail was off): mark them
-- verified once, so nobody already registered, the admin included, is locked out by the change. New accounts verify.
-- Rollback: none needed (the flag only relaxes a check that did not exist before this migration).
UPDATE "user" SET "email_verified" = true WHERE "email_verified" = false;
