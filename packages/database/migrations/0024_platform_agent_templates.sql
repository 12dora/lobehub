-- Custom SQL migration: platform-managed agent templates ("助理模板").
--
-- Backs the admin console module that takes over the create-agent modal example cards.
-- Direct-save family (like platform_task_templates): no draft/publish and no
-- platform_resource_revisions row — `revision` is a per-row CAS token.
--
-- Emptiness is meaningful: while the table has zero rows the product keeps serving the
-- locale-driven built-in examples. One row is enough to make the platform list
-- authoritative, and only `enabled` rows are then served to users.
--
-- Idempotent / convergent: CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS only;
-- safe to re-apply. No CONCURRENTLY (the migrator runs inside one transaction).
-- Do not seed rows here — an empty table is the unmanaged (current-product) default.

CREATE TABLE IF NOT EXISTS "platform_agent_templates" (
  "id" text PRIMARY KEY NOT NULL,
  "identifier" text NOT NULL,
  "title" text NOT NULL,
  "description" text DEFAULT '' NOT NULL,
  "avatar" text,
  "background_color" text,
  "system_role" text NOT NULL,
  "tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "source" text DEFAULT 'manual' NOT NULL,
  "revision" integer DEFAULT 0 NOT NULL,
  "updated_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "platform_agent_templates_revision_check" CHECK ("revision" >= 0),
  CONSTRAINT "platform_agent_templates_source_check" CHECK ("source" IN ('builtin', 'manual'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_agent_templates_identifier_unique" ON "platform_agent_templates" USING btree ("identifier");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_agent_templates_enabled_idx" ON "platform_agent_templates" USING btree ("enabled");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_agent_templates_sort_idx" ON "platform_agent_templates" USING btree ("sort_order");
