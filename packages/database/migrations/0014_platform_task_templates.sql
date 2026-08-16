-- Custom SQL migration: platform-managed task templates ("任务模板").
--
-- Backs the admin console module that takes over the home 为你推荐 cards and the agent-task
-- empty state. Direct-save family (like platform_sidebar_layout): no draft/publish and no
-- platform_resource_revisions row — `revision` is a per-row CAS token.
--
-- Emptiness is meaningful: while the table has zero rows the product keeps serving the remote
-- market recommendations. One row is enough to make the platform list authoritative, and only
-- `enabled` rows are then served to users.
--
-- Idempotent / convergent: CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS only;
-- safe to re-apply. No CONCURRENTLY (the migrator runs inside one transaction).

CREATE TABLE IF NOT EXISTS "platform_task_templates" (
  "id" text PRIMARY KEY NOT NULL,
  "identifier" text NOT NULL,
  "category" text NOT NULL,
  "connectors" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "cron_pattern" text NOT NULL,
  "description" text DEFAULT '' NOT NULL,
  "icon" text,
  "instruction" text NOT NULL,
  "interests" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "title" text NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "source" text DEFAULT 'manual' NOT NULL,
  "revision" integer DEFAULT 0 NOT NULL,
  "updated_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "platform_task_templates_revision_check" CHECK ("revision" >= 0),
  CONSTRAINT "platform_task_templates_source_check" CHECK ("source" IN ('market', 'manual'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_task_templates_identifier_unique" ON "platform_task_templates" USING btree ("identifier");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_task_templates_enabled_idx" ON "platform_task_templates" USING btree ("enabled");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_task_templates_sort_idx" ON "platform_task_templates" USING btree ("sort_order");
