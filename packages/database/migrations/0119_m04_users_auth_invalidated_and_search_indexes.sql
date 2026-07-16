-- M04: per-user auth security epoch + prefix-search expression indexes.
--
-- Production / multi-instance online prebuild (run before deploy so replay is a NO-OP):
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "users_email_lower_pattern_idx"
--   ON "users" USING btree (lower("email") text_pattern_ops);
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "users_username_lower_pattern_idx"
--   ON "users" USING btree (lower("username") text_pattern_ops);
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "users_normalized_email_lower_pattern_idx"
--   ON "users" USING btree (lower("normalized_email") text_pattern_ops);
--
-- The non-CONCURRENTLY statements below remain for fresh / self-hosted / PGlite
-- migration replay (same pattern as 0116). Never DROP these indexes on replay —
-- that would create a no-index write-blocking window.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "auth_invalidated_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_email_lower_pattern_idx" ON "users" USING btree (lower("email") text_pattern_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_username_lower_pattern_idx" ON "users" USING btree (lower("username") text_pattern_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_normalized_email_lower_pattern_idx" ON "users" USING btree (lower("normalized_email") text_pattern_ops);
