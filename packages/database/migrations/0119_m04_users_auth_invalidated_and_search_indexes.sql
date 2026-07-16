-- M04: per-user auth security epoch + prefix-search expression indexes.
-- Idempotent. text_pattern_ops enables lower(field) LIKE 'prefix%' index scans.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "auth_invalidated_at" timestamp with time zone;--> statement-breakpoint
DROP INDEX IF EXISTS "users_email_lower_pattern_idx";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_email_lower_pattern_idx" ON "users" USING btree (lower("email") text_pattern_ops);--> statement-breakpoint
DROP INDEX IF EXISTS "users_username_lower_pattern_idx";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_username_lower_pattern_idx" ON "users" USING btree (lower("username") text_pattern_ops);--> statement-breakpoint
DROP INDEX IF EXISTS "users_normalized_email_lower_pattern_idx";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_normalized_email_lower_pattern_idx" ON "users" USING btree (lower("normalized_email") text_pattern_ops);
