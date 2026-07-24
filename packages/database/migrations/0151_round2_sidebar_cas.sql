-- Round-2 sidebar partition: platform_sidebar_layout CAS revision + invariants.
-- Idempotent so partial re-applies are safe. Mirrors 0147_round2_identity.

-- Monotonic CAS revision (default 0 for existing rows).
ALTER TABLE "platform_sidebar_layout" ADD COLUMN IF NOT EXISTS "revision" integer;
--> statement-breakpoint
UPDATE "platform_sidebar_layout" SET "revision" = 0 WHERE "revision" IS NULL;
--> statement-breakpoint
ALTER TABLE "platform_sidebar_layout" ALTER COLUMN "revision" SET DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "platform_sidebar_layout" ALTER COLUMN "revision" SET NOT NULL;
--> statement-breakpoint

-- Singleton guard: only id = 'global' is allowed.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'platform_sidebar_layout_id_singleton'
  ) THEN
    ALTER TABLE "platform_sidebar_layout"
      ADD CONSTRAINT "platform_sidebar_layout_id_singleton"
      CHECK ("id" = 'global');
  END IF;
END $$;
--> statement-breakpoint

-- Mode allowlist (declared in schema; apply on existing DBs).
-- Normalize any existing invalid rows before adding the constraint.
UPDATE "platform_sidebar_layout"
SET "mode" = 'user'
WHERE "mode" IS NULL
   OR "mode" NOT IN ('user', 'platform');
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'platform_sidebar_layout_mode_check'
  ) THEN
    ALTER TABLE "platform_sidebar_layout"
      ADD CONSTRAINT "platform_sidebar_layout_mode_check"
      CHECK ("mode" IN ('user', 'platform'));
  END IF;
END $$;
--> statement-breakpoint

-- Revision non-negative.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'platform_sidebar_layout_revision_check'
  ) THEN
    ALTER TABLE "platform_sidebar_layout"
      ADD CONSTRAINT "platform_sidebar_layout_revision_check"
      CHECK ("revision" >= 0);
  END IF;
END $$;
