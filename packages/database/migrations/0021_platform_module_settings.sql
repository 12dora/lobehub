-- Custom SQL migration: platform module settings (deployment on/off switches).
--
-- Single row keyed id = 'global', with jsonb `modules` (partial override map;
-- missing keys stay ON), CAS `revision`, and `setup_completed_at` for the
-- first-run wizard. Direct-save family like platform_auth_settings —
-- no draft/publish and no platform_resource_revisions row.
--
-- Idempotent / convergent: CREATE TABLE IF NOT EXISTS only; safe to re-apply.
-- Hand-written because drizzle-kit generate is broken here (schema would eat
-- test files). Snapshot ancestry is copied from 0018 + the new table
-- (0019 does not exist on this branch; 0020 was claimed on main).

CREATE TABLE IF NOT EXISTS "platform_module_settings" (
  "id" text PRIMARY KEY NOT NULL,
  "modules" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "setup_completed_at" timestamp with time zone,
  "revision" integer DEFAULT 1 NOT NULL,
  "updated_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "platform_module_settings_id_singleton" CHECK ("id" = 'global'),
  CONSTRAINT "platform_module_settings_revision_check" CHECK ("revision" >= 1)
);
