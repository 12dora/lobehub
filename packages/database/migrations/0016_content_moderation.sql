-- Custom SQL migration: platform content moderation (内容审计).
--
-- Four tables: singleton settings (CAS revision), per-request records, hourly
-- aggregation for charts, and a hash-keyed decision cache. Direct-save family
-- like platform_auth_settings — no draft/publish and no platform_resource_revisions
-- row; `revision` on settings is a per-row CAS token.
--
-- Idempotent / convergent: CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS
-- only; safe to re-apply. No CONCURRENTLY (the migrator runs inside one transaction).
-- Hand-written because drizzle-kit generate would also rewrite docs/development/database-schema.dbml
-- (outside this batch's file set). Snapshot ancestry is copied from 0015 + new tables.

CREATE TABLE IF NOT EXISTS "platform_content_moderation_settings" (
  "id" text PRIMARY KEY NOT NULL,
  "config" jsonb NOT NULL,
  "revision" integer DEFAULT 0 NOT NULL,
  "updated_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "platform_content_moderation_settings_id_singleton" CHECK ("id" = 'default'),
  CONSTRAINT "platform_content_moderation_settings_revision_check" CHECK ("revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_content_moderation_records" (
  "id" text PRIMARY KEY NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "user_id" text,
  "user_snapshot" jsonb,
  "request_kind" text NOT NULL,
  "request_id" text,
  "topic_id" text,
  "message_id" text,
  "provider" text NOT NULL,
  "model" text NOT NULL,
  "effective_provider" text,
  "effective_model" text,
  "policy_action" text NOT NULL,
  "effective_action" text NOT NULL,
  "source" text NOT NULL,
  "top_category" text,
  "top_score" numeric(6, 4),
  "category_scores" jsonb NOT NULL,
  "threshold_snapshot" jsonb NOT NULL,
  "matched_rule" jsonb,
  "prompt_hash" text NOT NULL,
  "prompt_excerpt" text NOT NULL,
  "prompt_full" text,
  "classifier_latency_ms" integer,
  "error" text,
  "enforced" boolean DEFAULT false NOT NULL,
  "violation_count" integer DEFAULT 0 NOT NULL,
  "auto_banned" boolean DEFAULT false NOT NULL,
  "notified" boolean DEFAULT false NOT NULL,
  "revealed_at" timestamp with time zone,
  "revealed_by" text
);
--> statement-breakpoint
ALTER TABLE "platform_content_moderation_records"
  ADD COLUMN IF NOT EXISTS "enforced" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "platform_content_moderation_records"
    DROP CONSTRAINT IF EXISTS "platform_content_moderation_records_user_id_users_id_fk";
  ALTER TABLE "platform_content_moderation_records"
    ADD CONSTRAINT "platform_content_moderation_records_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DROP INDEX IF EXISTS "platform_content_moderation_records_created_at_idx";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_content_moderation_records_created_at_idx"
  ON "platform_content_moderation_records" USING btree ("created_at" DESC);
--> statement-breakpoint
DROP INDEX IF EXISTS "platform_content_moderation_records_user_id_created_at_idx";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_content_moderation_records_user_id_created_at_idx"
  ON "platform_content_moderation_records" USING btree ("user_id", "created_at" DESC);
--> statement-breakpoint
DROP INDEX IF EXISTS "platform_content_moderation_records_effective_action_created_at_idx";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_content_moderation_records_effective_action_created_at_idx"
  ON "platform_content_moderation_records" USING btree ("effective_action", "created_at" DESC);
--> statement-breakpoint
DROP INDEX IF EXISTS "platform_content_moderation_records_top_category_created_at_idx";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_content_moderation_records_top_category_created_at_idx"
  ON "platform_content_moderation_records" USING btree ("top_category", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_content_moderation_records_prompt_hash_idx"
  ON "platform_content_moderation_records" USING btree ("prompt_hash");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_content_moderation_hourly_stats" (
  "bucket_start" timestamp with time zone NOT NULL,
  "request_kind" text NOT NULL,
  "effective_action" text NOT NULL,
  "policy_action" text NOT NULL,
  "source" text NOT NULL,
  "top_category" text DEFAULT '' NOT NULL,
  "count" integer DEFAULT 0 NOT NULL,
  "latency_sum_ms" bigint DEFAULT 0 NOT NULL,
  "latency_count" integer DEFAULT 0 NOT NULL,
  CONSTRAINT "platform_content_moderation_hourly_stats_pk" PRIMARY KEY (
    "bucket_start",
    "request_kind",
    "effective_action",
    "policy_action",
    "source",
    "top_category"
  )
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_content_moderation_decisions" (
  "prompt_hash" text PRIMARY KEY NOT NULL,
  "categories" jsonb NOT NULL,
  "source" text NOT NULL,
  "hit_count" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_hit_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_content_moderation_decisions_expires_at_idx"
  ON "platform_content_moderation_decisions" USING btree ("expires_at");
