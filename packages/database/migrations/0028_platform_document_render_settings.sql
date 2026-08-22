-- Platform document-render runtime settings (singleton). Direct-save with a monotonic
-- revision. Absent row means environment variables own every field.
-- Idempotent (CREATE TABLE IF NOT EXISTS only; safe to re-apply). Hand-written
-- because drizzle-kit generate is broken here (the schema glob eats test files);
-- `meta/0028_snapshot.json` is the 0027 ancestry plus this table.

CREATE TABLE IF NOT EXISTS "platform_document_render_settings" (
  "id" text PRIMARY KEY NOT NULL,
  "config" jsonb DEFAULT '{"enabled":false}'::jsonb NOT NULL,
  "revision" integer DEFAULT 0 NOT NULL,
  "updated_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "platform_document_render_settings_id_singleton" CHECK ("id" = 'global'),
  CONSTRAINT "platform_document_render_settings_revision_check" CHECK ("revision" >= 0)
);
