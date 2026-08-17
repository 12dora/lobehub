-- Installation-wide synthetic browser device profile.
--
-- Direct-save singleton with a monotonic revision. The seed and generated
-- profile are server-owned; admin APIs only expose a non-sensitive summary.
-- Idempotent (CREATE TABLE IF NOT EXISTS only; safe to re-apply). Hand-written
-- because drizzle-kit generate is broken here (the schema glob eats test files);
-- `meta/0022_snapshot.json` is the 0021 ancestry plus this table, exactly as the
-- neighbouring platform migrations do it.

CREATE TABLE IF NOT EXISTS "platform_browser_profiles" (
  "id" text PRIMARY KEY NOT NULL,
  "revision" integer DEFAULT 0 NOT NULL,
  "seed" text NOT NULL,
  "profile" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by" text,
  CONSTRAINT "platform_browser_profiles_id_check" CHECK ("id" = 'default'),
  CONSTRAINT "platform_browser_profiles_revision_check" CHECK ("revision" >= 0)
);
