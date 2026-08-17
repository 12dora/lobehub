-- Custom SQL migration: structured engine issue + self-heal state on
-- platform_network_proxy_instance_status. Heartbeat rows are ephemeral —
-- dropping last_error loses nothing (it held raw exception text).
--
-- Idempotent / convergent: ADD COLUMN IF NOT EXISTS + DROP COLUMN IF EXISTS.
-- Hand-written because drizzle-kit generate would also rewrite
-- docs/development/database-schema.dbml (outside this batch's file set).
-- Snapshot ancestry is copied from 0018 + the column swap.

ALTER TABLE "platform_network_proxy_instance_status" ADD COLUMN IF NOT EXISTS "last_issue" jsonb;
--> statement-breakpoint
ALTER TABLE "platform_network_proxy_instance_status" ADD COLUMN IF NOT EXISTS "healing" jsonb;
--> statement-breakpoint
ALTER TABLE "platform_network_proxy_instance_status" DROP COLUMN IF EXISTS "last_error";
