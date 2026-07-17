ALTER TABLE "platform_connector_oauth_states" ADD COLUMN IF NOT EXISTS "authorization_outcome" varchar(16);--> statement-breakpoint
ALTER TABLE "platform_connector_oauth_states" ADD COLUMN IF NOT EXISTS "finished_at" timestamp with time zone;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'platform_connector_oauth_states_outcome_check'
      AND conrelid = 'platform_connector_oauth_states'::regclass
  ) THEN
    ALTER TABLE "platform_connector_oauth_states"
      ADD CONSTRAINT "platform_connector_oauth_states_outcome_check"
      CHECK (("authorization_outcome" IS NULL AND "finished_at" IS NULL)
        OR ("authorization_outcome" IN ('completed', 'failed') AND "finished_at" IS NOT NULL))
      NOT VALID;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "platform_connector_oauth_states"
  VALIDATE CONSTRAINT "platform_connector_oauth_states_outcome_check";
