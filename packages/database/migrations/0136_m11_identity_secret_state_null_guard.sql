-- 0136: Strengthen platform_identity_providers secret_state_check.
--
-- Pre-0136 CHECK treated `NULL ~ regex` as UNKNOWN, which PostgreSQL CHECK accepts.
-- That allowed invalid triples such as:
--   secret_ref IS NOT NULL AND secret_fingerprint IS NULL AND secret_updated_at IS NOT NULL
--
-- Deterministic fail-closed quarantine (before the stronger CHECK is installed):
--   For every row that would fail the strengthened triple form:
--     - Clear secret_ref / secret_fingerprint / secret_updated_at to the empty triple
--       (never fabricate a fingerprint; never keep an unprovable active secret handle)
--     - Force enabled=false and activation_revision=NULL so the provider cannot stay live
--     - Set migration_required=true so ops must re-bind a real secret
--     - Coerce non-safe lifecycle statuses to 'error' (draft/error/disabled/archived kept)
--   Non-secret configuration (provider_key, display_name, issuer, scopes, claim mapping, …)
--   is preserved. History rows in platform_identity_provider_secrets are left intact for audit.
--
-- Then replace secret_state_check with explicit IS NOT NULL guards.

UPDATE "platform_identity_providers"
SET
  "secret_ref" = NULL,
  "secret_fingerprint" = NULL,
  "secret_updated_at" = NULL,
  "enabled" = false,
  "activation_revision" = NULL,
  "migration_required" = true,
  "status" = CASE
    WHEN "status" IN ('draft', 'error', 'disabled', 'archived') THEN "status"
    ELSE 'error'
  END
WHERE NOT (
  (
    "secret_ref" IS NULL
    AND "secret_fingerprint" IS NULL
    AND "secret_updated_at" IS NULL
  )
  OR (
    "secret_ref" IS NOT NULL
    AND "secret_fingerprint" IS NOT NULL
    AND "secret_fingerprint" ~ '^[a-f0-9]{64}$'
    AND "secret_updated_at" IS NOT NULL
  )
);--> statement-breakpoint
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
