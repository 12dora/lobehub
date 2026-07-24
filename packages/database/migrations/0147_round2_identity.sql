-- Round-2 identity partition: platform_auth_settings CAS revision + invariants.
-- Idempotent so partial re-applies are safe.

-- Monotonic CAS revision (default 0 for existing rows).
ALTER TABLE "platform_auth_settings" ADD COLUMN IF NOT EXISTS "revision" integer;
--> statement-breakpoint
UPDATE "platform_auth_settings" SET "revision" = 0 WHERE "revision" IS NULL;
--> statement-breakpoint
ALTER TABLE "platform_auth_settings" ALTER COLUMN "revision" SET DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "platform_auth_settings" ALTER COLUMN "revision" SET NOT NULL;
--> statement-breakpoint

-- Singleton guard: only id = 'global' is allowed.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'platform_auth_settings_id_singleton'
  ) THEN
    ALTER TABLE "platform_auth_settings"
      ADD CONSTRAINT "platform_auth_settings_id_singleton"
      CHECK ("id" = 'global');
  END IF;
END $$;
--> statement-breakpoint

-- Revision non-negative.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'platform_auth_settings_revision_check'
  ) THEN
    ALTER TABLE "platform_auth_settings"
      ADD CONSTRAINT "platform_auth_settings_revision_check"
      CHECK ("revision" >= 0);
  END IF;
END $$;
--> statement-breakpoint

-- Fail closed: allowlist enabled requires at least one domain entry.
-- Normalize any existing invalid rows before adding the constraint.
UPDATE "platform_auth_settings"
SET "email_domain_allowlist_enabled" = false
WHERE "email_domain_allowlist_enabled" = true
  AND jsonb_array_length(COALESCE("email_domain_allowlist", '[]'::jsonb)) = 0;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'platform_auth_settings_allowlist_nonempty_when_enabled'
  ) THEN
    ALTER TABLE "platform_auth_settings"
      ADD CONSTRAINT "platform_auth_settings_allowlist_nonempty_when_enabled"
      CHECK (
        (NOT "email_domain_allowlist_enabled")
        OR (jsonb_array_length("email_domain_allowlist") > 0)
      );
  END IF;
END $$;
