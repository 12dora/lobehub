-- Custom SQL migration: platform network proxy (网络代理).
--
-- Three tables: singleton settings (CAS revision + engine generation + desired
-- artifacts), subscriptions (URL / manual payloads, sealed secrets), and
-- per-instance engine status (FK → platform_instance_heartbeats). Direct-save
-- family like platform_content_moderation_settings — no draft/publish and no
-- platform_resource_revisions row; `revision` on settings is a per-row CAS token.
--
-- Idempotent / convergent: CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS
-- only; safe to re-apply. No CONCURRENTLY (the migrator runs inside one transaction).
-- Hand-written because drizzle-kit generate would also rewrite docs/development/database-schema.dbml
-- (outside this batch's file set). Snapshot ancestry is copied from 0016 + new tables.

CREATE TABLE IF NOT EXISTS "platform_network_proxy_settings" (
  "id" text PRIMARY KEY NOT NULL,
  "config" jsonb NOT NULL,
  "revision" integer DEFAULT 0 NOT NULL,
  "engine_generation" integer DEFAULT 0 NOT NULL,
  "desired_artifacts" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "updated_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "platform_network_proxy_settings_id_singleton" CHECK ("id" = 'default'),
  CONSTRAINT "platform_network_proxy_settings_revision_check" CHECK ("revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_network_proxy_subscriptions" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "kind" text NOT NULL,
  "url_ciphertext" text,
  "url_host" text,
  "payload_ciphertext" text,
  "enabled" boolean DEFAULT true NOT NULL,
  "update_interval_sec" integer,
  "user_agent" text,
  "filter" text,
  "exclude_filter" text,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "refresh_requested_at" timestamp with time zone,
  "last_update_at" timestamp with time zone,
  "last_error" text,
  "node_count" integer,
  "traffic_upload" bigint,
  "traffic_download" bigint,
  "traffic_total" bigint,
  "traffic_expire_at" timestamp with time zone,
  "created_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_network_proxy_subscriptions_enabled_sort_idx"
  ON "platform_network_proxy_subscriptions" USING btree ("enabled", "sort_order");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_network_proxy_instance_status" (
  "instance_id" text PRIMARY KEY NOT NULL,
  "engine_state" text NOT NULL,
  "engine_version" text,
  "platform" text NOT NULL,
  "arch" text NOT NULL,
  "artifact_state" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "applied_revision" integer,
  "applied_engine_generation" integer,
  "active_node" text,
  "alive_node_count" integer,
  "proxied_count" integer DEFAULT 0 NOT NULL,
  "fallback_count" integer DEFAULT 0 NOT NULL,
  "last_error" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "platform_network_proxy_instance_status"
    DROP CONSTRAINT IF EXISTS "platform_network_proxy_instance_status_instance_id_platform_instance_heartbeats_instance_id_fk";
  ALTER TABLE "platform_network_proxy_instance_status"
    ADD CONSTRAINT "platform_network_proxy_instance_status_instance_id_platform_instance_heartbeats_instance_id_fk"
    FOREIGN KEY ("instance_id") REFERENCES "public"."platform_instance_heartbeats"("instance_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
