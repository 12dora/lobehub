ALTER TABLE "platform_ai_provider_secrets" ADD COLUMN IF NOT EXISTS "key_id" varchar(256);--> statement-breakpoint
ALTER TABLE "platform_ai_providers" ADD COLUMN IF NOT EXISTS "secret_key_id" varchar(256);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_ai_provider_secrets_key_id_idx" ON "platform_ai_provider_secrets" USING btree ("key_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_ai_providers_secret_key_id_idx" ON "platform_ai_providers" USING btree ("secret_key_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_identity_provider_test_attempts_pkce_key_id_idx" ON "platform_identity_provider_test_attempts" USING btree ("pkce_key_id");
