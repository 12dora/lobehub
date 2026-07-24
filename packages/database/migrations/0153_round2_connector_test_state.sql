-- Round-2 connectors F4: durable connection-test state on platform_connectors.
-- All seven columns are nullable with no DB default (fail-closed until a probe is recorded).
-- Idempotent / PGlite-safe: plain ALTER TABLE ADD COLUMN IF NOT EXISTS only.

ALTER TABLE "platform_connectors" ADD COLUMN IF NOT EXISTS "connection_test_status" varchar(16);
--> statement-breakpoint
ALTER TABLE "platform_connectors" ADD COLUMN IF NOT EXISTS "connection_test_latency_ms" integer;
--> statement-breakpoint
ALTER TABLE "platform_connectors" ADD COLUMN IF NOT EXISTS "connection_test_error_category" varchar(32);
--> statement-breakpoint
ALTER TABLE "platform_connectors" ADD COLUMN IF NOT EXISTS "connection_test_message_code" varchar(128);
--> statement-breakpoint
ALTER TABLE "platform_connectors" ADD COLUMN IF NOT EXISTS "connection_tested_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "platform_connectors" ADD COLUMN IF NOT EXISTS "connection_tested_draft_token" varchar(64);
--> statement-breakpoint
ALTER TABLE "platform_connectors" ADD COLUMN IF NOT EXISTS "connection_tested_revision" integer;
