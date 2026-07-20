ALTER TABLE "platform_identity_providers" DROP CONSTRAINT IF EXISTS "platform_identity_providers_secret_state_check";--> statement-breakpoint
ALTER TABLE "platform_identity_providers" ADD CONSTRAINT "platform_identity_providers_secret_state_check" CHECK ((
  "secret_ref" IS NULL
  AND "secret_fingerprint" IS NULL
  AND "secret_updated_at" IS NULL
) OR (
  "secret_ref" IS NOT NULL
  AND "secret_fingerprint" IS NOT NULL
  AND "secret_fingerprint" ~ '^[a-f0-9]{64}$'
  AND "secret_updated_at" IS NOT NULL
));
