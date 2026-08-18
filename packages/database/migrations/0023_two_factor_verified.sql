-- Custom SQL migration: two_factor.verified.
--
-- The `two_factor` table shipped in the squash baseline without the `verified`
-- column that better-auth's twoFactor plugin declares. The column is written on
-- `/two-factor/enable` (false until the first TOTP code is confirmed) and flipped
-- to true by `/two-factor/verify-totp`, so enrolment fails outright without it.
--
-- Default `true` matches the plugin's own schema default, which is what an
-- already-enrolled row would have meant. The table is empty in practice — the
-- plugin was never registered before this change — so the default is moot for
-- existing data and only guards a re-apply.
--
-- Idempotent / convergent: ADD COLUMN IF NOT EXISTS only; safe to re-apply.
-- Hand-written because drizzle-kit generate is broken here (schema would eat
-- test files).

ALTER TABLE "two_factor" ADD COLUMN IF NOT EXISTS "verified" boolean DEFAULT true NOT NULL;
