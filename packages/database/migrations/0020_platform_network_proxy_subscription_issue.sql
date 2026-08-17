-- Custom SQL migration: structured subscription-fetch issue on
-- platform_network_proxy_subscriptions.
--
-- last_error is kept (nullable, unused by new writers) for rolling upgrades:
-- old processes still SELECT that column. Drop it in a later migration.
--
-- Idempotent / convergent: ADD COLUMN IF NOT EXISTS only.
-- Hand-written because drizzle-kit generate would also rewrite
-- docs/development/database-schema.dbml (outside this batch's file set).
-- Snapshot ancestry is copied from 0019 + the new column.

ALTER TABLE "platform_network_proxy_subscriptions" ADD COLUMN IF NOT EXISTS "last_issue" jsonb;
--> statement-breakpoint
-- kept for rolling upgrade; drop in a later migration
COMMENT ON COLUMN "platform_network_proxy_subscriptions"."last_error" IS 'kept for rolling upgrade; drop in a later migration';
