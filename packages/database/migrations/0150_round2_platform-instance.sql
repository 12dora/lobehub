-- Round-2 platform-instance: optimistic CAS revision on platform global credentials.
-- Idempotent / convergent so partial re-applies are safe.

ALTER TABLE "platform_global_credentials"
  ADD COLUMN IF NOT EXISTS "revision" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'platform_global_credentials_revision_check'
  ) THEN
    ALTER TABLE "platform_global_credentials"
      ADD CONSTRAINT "platform_global_credentials_revision_check"
      CHECK ("revision" >= 0);
  END IF;
END $$;
