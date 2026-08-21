-- Custom SQL migration: per-domain marker that a platform template catalog has been seeded.
--
-- The catalog is managed in every state once this row exists. Built-in examples are loaded
-- as real rows by application bootstrap (not here): an empty `platform_*_templates` table
-- plus a marker means the operator deleted everything and users must see nothing — never
-- re-seed. Do not insert template rows in this migration.
--
-- Idempotent / convergent: CREATE TABLE IF NOT EXISTS only; safe to re-apply.
-- No CONCURRENTLY (the migrator runs inside one transaction).

CREATE TABLE IF NOT EXISTS "platform_template_catalog_state" (
  "domain" text PRIMARY KEY NOT NULL,
  "seeded_at" timestamp with time zone DEFAULT now() NOT NULL,
  "seeded_locale" text NOT NULL,
  "seeded_by" text,
  CONSTRAINT "platform_template_catalog_state_domain_check" CHECK ("domain" IN ('agent_templates', 'task_templates'))
);
