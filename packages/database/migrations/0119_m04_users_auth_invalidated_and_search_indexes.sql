-- M04: auth security epoch columns + prefix-search expression indexes.
--
-- Production online prebuild (run before deploy so replay is a NO-OP):
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "users_email_lower_pattern_idx"
--   ON "users" USING btree (lower("email") text_pattern_ops);
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "users_username_lower_pattern_idx"
--   ON "users" USING btree (lower("username") text_pattern_ops);
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "users_normalized_email_lower_pattern_idx"
--   ON "users" USING btree (lower("normalized_email") text_pattern_ops);
--
-- Non-CONCURRENTLY below for fresh/self-hosted/PGlite (pattern from 0116).
-- Never DROP these indexes on replay.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "auth_invalidated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "auth_invalidated_excluded_session_id" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_email_lower_pattern_idx" ON "users" USING btree (lower("email") text_pattern_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_username_lower_pattern_idx" ON "users" USING btree (lower("username") text_pattern_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_normalized_email_lower_pattern_idx" ON "users" USING btree (lower("normalized_email") text_pattern_ops);
