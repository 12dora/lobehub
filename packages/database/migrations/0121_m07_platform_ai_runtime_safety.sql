CREATE TABLE IF NOT EXISTS "platform_ai_provider_secrets" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"ciphertext" text NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "platform_ai_providers" ADD COLUMN IF NOT EXISTS "connection_test_status" varchar(16);--> statement-breakpoint
ALTER TABLE "platform_ai_providers" ADD COLUMN IF NOT EXISTS "connection_test_latency_ms" integer;--> statement-breakpoint
ALTER TABLE "platform_ai_providers" ADD COLUMN IF NOT EXISTS "connection_test_error_category" varchar(32);--> statement-breakpoint
ALTER TABLE "platform_ai_providers" ADD COLUMN IF NOT EXISTS "connection_test_sanitized_message" varchar(500);--> statement-breakpoint
ALTER TABLE "platform_ai_providers" ADD COLUMN IF NOT EXISTS "connection_tested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "platform_ai_providers" ADD COLUMN IF NOT EXISTS "connection_tested_draft_token" varchar(64);--> statement-breakpoint
ALTER TABLE "platform_ai_providers" ADD COLUMN IF NOT EXISTS "connection_tested_revision" integer;--> statement-breakpoint
ALTER TABLE "platform_ai_providers" ADD COLUMN IF NOT EXISTS "connection_test_attempt_id" text;--> statement-breakpoint
ALTER TABLE "platform_ai_provider_secrets" DROP CONSTRAINT IF EXISTS "platform_ai_provider_secrets_provider_id_platform_ai_providers_id_fk";--> statement-breakpoint
ALTER TABLE "platform_ai_provider_secrets" ADD CONSTRAINT "platform_ai_provider_secrets_provider_id_platform_ai_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."platform_ai_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_ai_provider_secrets_provider_fingerprint_unique" ON "platform_ai_provider_secrets" USING btree ("provider_id","fingerprint");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_ai_provider_secrets_provider_id_idx" ON "platform_ai_provider_secrets" USING btree ("provider_id");
