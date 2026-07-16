ALTER TABLE "users" ADD COLUMN "auth_invalidated_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "users_email_lower_pattern_idx" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "users_username_lower_pattern_idx" ON "users" USING btree (lower("username"));--> statement-breakpoint
CREATE INDEX "users_normalized_email_lower_pattern_idx" ON "users" USING btree (lower("normalized_email"));