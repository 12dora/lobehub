-- Custom SQL migration: platform infrastructure settings (对象存储 / 邮件服务).
--
-- Two rows keyed id IN ('object_storage','mail'), each with its own CAS
-- `revision`. Secrets live as ciphertext fields inside `config` jsonb
-- (never plaintext). Direct-save family like platform_network_proxy_settings
-- — no draft/publish and no platform_resource_revisions row.
--
-- Idempotent / convergent: CREATE TABLE IF NOT EXISTS only; safe to re-apply.
-- Hand-written because drizzle-kit generate would also rewrite
-- docs/development/database-schema.dbml (outside this batch's file set).
-- Snapshot ancestry is copied from 0017 + the new table.

CREATE TABLE IF NOT EXISTS "platform_infra_settings" (
  "id" text PRIMARY KEY NOT NULL,
  "config" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "revision" integer DEFAULT 0 NOT NULL,
  "updated_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "platform_infra_settings_id_check" CHECK ("id" IN ('object_storage', 'mail')),
  CONSTRAINT "platform_infra_settings_revision_check" CHECK ("revision" >= 0)
);
