-- Custom SQL migration: structured engine issue + self-heal state on
-- platform_network_proxy_instance_status.
--
-- last_error is kept (nullable, unused by new writers) for rolling upgrades:
-- old processes still SELECT / UPSERT that column. Drop it in a later migration.
--
-- Idempotent / convergent: ADD COLUMN IF NOT EXISTS only.
-- Hand-written because drizzle-kit generate would also rewrite
-- docs/development/database-schema.dbml (outside this batch's file set).
-- Snapshot ancestry is copied from 0018 + the new columns.

ALTER TABLE "platform_network_proxy_instance_status" ADD COLUMN IF NOT EXISTS "last_issue" jsonb;
--> statement-breakpoint
ALTER TABLE "platform_network_proxy_instance_status" ADD COLUMN IF NOT EXISTS "healing" jsonb;
--> statement-breakpoint
-- kept for rolling upgrade; drop in a later migration
ALTER TABLE "platform_network_proxy_instance_status" ADD COLUMN IF NOT EXISTS "last_error" text;
--> statement-breakpoint
COMMENT ON COLUMN "platform_network_proxy_instance_status"."last_error" IS 'kept for rolling upgrade; drop in a later migration';
