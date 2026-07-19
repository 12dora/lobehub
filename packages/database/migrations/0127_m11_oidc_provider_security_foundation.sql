CREATE TABLE IF NOT EXISTS "platform_identity_provider_secrets" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"fingerprint" varchar(64) NOT NULL,
	"ref" text NOT NULL,
	"ciphertext" text NOT NULL,
	"key_id" varchar(256) NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_identity_provider_secrets_ref_check" CHECK ("platform_identity_provider_secrets"."ref" LIKE 'kms://platform-identity-providers/%'),
	CONSTRAINT "platform_identity_provider_secrets_fingerprint_check" CHECK ("platform_identity_provider_secrets"."fingerprint" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "platform_identity_provider_secrets_revision_check" CHECK ("platform_identity_provider_secrets"."revision" > 0)
);
--> statement-breakpoint
UPDATE "platform_identity_providers" SET "type" = 'generic_oidc' WHERE "type" = 'oidc';--> statement-breakpoint
UPDATE "platform_identity_providers" SET "button_label" = '使用工作账号登录' WHERE "button_label" IS NULL;--> statement-breakpoint
UPDATE "platform_identity_providers"
SET "claim_mapping" = '{"dingtalkTitle":[],"dingtalkUserId":[],"email":["email"],"name":["name","preferred_username"],"picture":["picture"],"subject":["sub"]}'::jsonb
WHERE "claim_mapping" IS NULL
   OR jsonb_typeof("claim_mapping") <> 'object'
   OR jsonb_array_length(CASE WHEN jsonb_typeof("claim_mapping"->'subject') = 'array' THEN "claim_mapping"->'subject' ELSE '[]'::jsonb END) = 0
   OR jsonb_array_length(CASE WHEN jsonb_typeof("claim_mapping"->'name') = 'array' THEN "claim_mapping"->'name' ELSE '[]'::jsonb END) = 0;--> statement-breakpoint
UPDATE "platform_identity_providers" SET "domain_allowlist" = '[]'::jsonb WHERE "domain_allowlist" IS NULL;--> statement-breakpoint
UPDATE "platform_identity_providers" SET "group_role_mapping" = '{}'::jsonb WHERE "group_role_mapping" IS NULL;--> statement-breakpoint
ALTER TABLE "platform_identity_providers" ALTER COLUMN "type" SET DEFAULT 'generic_oidc';--> statement-breakpoint
ALTER TABLE "platform_identity_providers" ALTER COLUMN "display_name" SET DATA TYPE varchar(200);--> statement-breakpoint
ALTER TABLE "platform_identity_providers" ALTER COLUMN "button_label" SET DATA TYPE varchar(200);--> statement-breakpoint
ALTER TABLE "platform_identity_providers" ALTER COLUMN "button_label" SET DEFAULT '使用工作账号登录';--> statement-breakpoint
ALTER TABLE "platform_identity_providers" ALTER COLUMN "button_label" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_identity_providers" ALTER COLUMN "client_id" SET DATA TYPE varchar(1000);--> statement-breakpoint
ALTER TABLE "platform_identity_providers" ALTER COLUMN "secret_fingerprint" SET DATA TYPE varchar(64);--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'platform_identity_providers'
      AND column_name = 'scopes'
      AND data_type <> 'jsonb'
  ) THEN
    ALTER TABLE "platform_identity_providers" ALTER COLUMN "scopes" SET DATA TYPE jsonb
      USING CASE
        WHEN "scopes" IS NULL OR btrim("scopes") = '' THEN '["openid","profile","email"]'::jsonb
        ELSE to_jsonb(regexp_split_to_array(btrim("scopes"), E'[,\\s]+'))
      END;
  END IF;
END $$;--> statement-breakpoint
UPDATE "platform_identity_providers" SET "scopes" = '["openid","profile","email"]'::jsonb WHERE "scopes" IS NULL;--> statement-breakpoint
ALTER TABLE "platform_identity_providers" ALTER COLUMN "scopes" SET DEFAULT '["openid","profile","email"]'::jsonb;--> statement-breakpoint
ALTER TABLE "platform_identity_providers" ALTER COLUMN "scopes" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_identity_providers" ALTER COLUMN "claim_mapping" SET DEFAULT '{"dingtalkTitle":[],"dingtalkUserId":[],"email":["email"],"name":["name","preferred_username"],"picture":["picture"],"subject":["sub"]}'::jsonb;--> statement-breakpoint
ALTER TABLE "platform_identity_providers" ALTER COLUMN "claim_mapping" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_identity_providers" ALTER COLUMN "domain_allowlist" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_identity_providers" ALTER COLUMN "group_role_mapping" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_identity_providers" ADD COLUMN IF NOT EXISTS "secret_ref" text;--> statement-breakpoint
ALTER TABLE "platform_identity_providers" ADD COLUMN IF NOT EXISTS "secret_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "platform_identity_providers" ADD COLUMN IF NOT EXISTS "enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_identity_providers" ADD COLUMN IF NOT EXISTS "activation_revision" integer;--> statement-breakpoint
UPDATE "platform_identity_providers" SET "secret_fingerprint" = NULL WHERE "secret_ref" IS NULL;--> statement-breakpoint
ALTER TABLE "platform_identity_provider_secrets" DROP CONSTRAINT IF EXISTS "platform_identity_provider_secrets_ref_check";--> statement-breakpoint
ALTER TABLE "platform_identity_provider_secrets" ADD CONSTRAINT "platform_identity_provider_secrets_ref_check" CHECK ("ref" LIKE 'kms://platform-identity-providers/%');--> statement-breakpoint
ALTER TABLE "platform_identity_provider_secrets" DROP CONSTRAINT IF EXISTS "platform_identity_provider_secrets_fingerprint_check";--> statement-breakpoint
ALTER TABLE "platform_identity_provider_secrets" ADD CONSTRAINT "platform_identity_provider_secrets_fingerprint_check" CHECK ("fingerprint" ~ '^[a-f0-9]{64}$');--> statement-breakpoint
ALTER TABLE "platform_identity_provider_secrets" DROP CONSTRAINT IF EXISTS "platform_identity_provider_secrets_revision_check";--> statement-breakpoint
ALTER TABLE "platform_identity_provider_secrets" ADD CONSTRAINT "platform_identity_provider_secrets_revision_check" CHECK ("revision" > 0);--> statement-breakpoint
ALTER TABLE "platform_identity_provider_secrets" DROP CONSTRAINT IF EXISTS "platform_identity_provider_secrets_provider_id_platform_identity_providers_id_fk";--> statement-breakpoint
ALTER TABLE "platform_identity_provider_secrets" ADD CONSTRAINT "platform_identity_provider_secrets_provider_id_platform_identity_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."platform_identity_providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_identity_provider_secrets_ref_unique" ON "platform_identity_provider_secrets" USING btree ("ref");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_identity_provider_secrets_lookup_idx" ON "platform_identity_provider_secrets" USING btree ("provider_id","fingerprint","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_identity_provider_secrets_key_id_idx" ON "platform_identity_provider_secrets" USING btree ("key_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_identity_providers_enabled_status_idx" ON "platform_identity_providers" USING btree ("enabled","status");--> statement-breakpoint
ALTER TABLE "platform_identity_providers" DROP COLUMN IF EXISTS "discovery_url";--> statement-breakpoint
ALTER TABLE "platform_identity_providers" DROP COLUMN IF EXISTS "encrypted_client_secret";--> statement-breakpoint
ALTER TABLE "platform_identity_providers" DROP CONSTRAINT IF EXISTS "platform_identity_providers_key_check";--> statement-breakpoint
ALTER TABLE "platform_identity_providers" ADD CONSTRAINT "platform_identity_providers_key_check" CHECK ("platform_identity_providers"."provider_key" ~ '^[a-z0-9][a-z0-9._-]{0,127}$');--> statement-breakpoint
ALTER TABLE "platform_identity_providers" DROP CONSTRAINT IF EXISTS "platform_identity_providers_type_check";--> statement-breakpoint
ALTER TABLE "platform_identity_providers" ADD CONSTRAINT "platform_identity_providers_type_check" CHECK ("platform_identity_providers"."type" IN ('authentik', 'generic_oidc'));--> statement-breakpoint
ALTER TABLE "platform_identity_providers" DROP CONSTRAINT IF EXISTS "platform_identity_providers_status_check";--> statement-breakpoint
ALTER TABLE "platform_identity_providers" ADD CONSTRAINT "platform_identity_providers_status_check" CHECK ("platform_identity_providers"."status" IN ('draft', 'published', 'pending_restart', 'active', 'error', 'disabled', 'archived'));--> statement-breakpoint
ALTER TABLE "platform_identity_providers" DROP CONSTRAINT IF EXISTS "platform_identity_providers_revision_check";--> statement-breakpoint
ALTER TABLE "platform_identity_providers" ADD CONSTRAINT "platform_identity_providers_revision_check" CHECK ("platform_identity_providers"."revision" >= 0 AND ("platform_identity_providers"."activation_revision" IS NULL OR "platform_identity_providers"."activation_revision" > 0));--> statement-breakpoint
ALTER TABLE "platform_identity_providers" DROP CONSTRAINT IF EXISTS "platform_identity_providers_secret_state_check";--> statement-breakpoint
ALTER TABLE "platform_identity_providers" ADD CONSTRAINT "platform_identity_providers_secret_state_check" CHECK (("platform_identity_providers"."secret_ref" IS NULL AND "platform_identity_providers"."secret_fingerprint" IS NULL AND "platform_identity_providers"."secret_updated_at" IS NULL)
        OR ("platform_identity_providers"."secret_ref" IS NOT NULL
          AND "platform_identity_providers"."secret_fingerprint" ~ '^[a-f0-9]{64}$'
          AND "platform_identity_providers"."secret_updated_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "platform_identity_providers" DROP CONSTRAINT IF EXISTS "platform_identity_providers_secret_ref_check";--> statement-breakpoint
ALTER TABLE "platform_identity_providers" ADD CONSTRAINT "platform_identity_providers_secret_ref_check" CHECK ("platform_identity_providers"."secret_ref" IS NULL OR "platform_identity_providers"."secret_ref" LIKE 'kms://platform-identity-providers/%');--> statement-breakpoint
ALTER TABLE "platform_identity_providers" DROP CONSTRAINT IF EXISTS "platform_identity_providers_scopes_check";--> statement-breakpoint
ALTER TABLE "platform_identity_providers" ADD CONSTRAINT "platform_identity_providers_scopes_check" CHECK (jsonb_typeof("platform_identity_providers"."scopes") = 'array'
        AND jsonb_array_length(CASE WHEN jsonb_typeof("platform_identity_providers"."scopes") = 'array' THEN "platform_identity_providers"."scopes" ELSE '[]'::jsonb END) BETWEEN 1 AND 32
        AND "platform_identity_providers"."scopes" ? 'openid'
        AND octet_length("platform_identity_providers"."scopes"::text) <= 4096);--> statement-breakpoint
ALTER TABLE "platform_identity_providers" DROP CONSTRAINT IF EXISTS "platform_identity_providers_claim_mapping_check";--> statement-breakpoint
ALTER TABLE "platform_identity_providers" ADD CONSTRAINT "platform_identity_providers_claim_mapping_check" CHECK (jsonb_typeof("platform_identity_providers"."claim_mapping") = 'object'
        AND jsonb_typeof("platform_identity_providers"."claim_mapping"->'subject') = 'array'
        AND jsonb_array_length(CASE WHEN jsonb_typeof("platform_identity_providers"."claim_mapping"->'subject') = 'array' THEN "platform_identity_providers"."claim_mapping"->'subject' ELSE '[]'::jsonb END) > 0
        AND jsonb_typeof("platform_identity_providers"."claim_mapping"->'name') = 'array'
        AND jsonb_array_length(CASE WHEN jsonb_typeof("platform_identity_providers"."claim_mapping"->'name') = 'array' THEN "platform_identity_providers"."claim_mapping"->'name' ELSE '[]'::jsonb END) > 0
        AND octet_length("platform_identity_providers"."claim_mapping"::text) <= 8192
        AND "platform_identity_providers"."claim_mapping"::text !~* '"(secret|token|password|authorization)"[[:space:]]*:');--> statement-breakpoint
ALTER TABLE "platform_identity_providers" DROP CONSTRAINT IF EXISTS "platform_identity_providers_policy_json_check";--> statement-breakpoint
ALTER TABLE "platform_identity_providers" ADD CONSTRAINT "platform_identity_providers_policy_json_check" CHECK (jsonb_typeof("platform_identity_providers"."domain_allowlist") = 'array'
        AND jsonb_array_length(CASE WHEN jsonb_typeof("platform_identity_providers"."domain_allowlist") = 'array' THEN "platform_identity_providers"."domain_allowlist" ELSE '[]'::jsonb END) <= 256
        AND octet_length("platform_identity_providers"."domain_allowlist"::text) <= 65536
        AND jsonb_typeof("platform_identity_providers"."group_role_mapping") = 'object'
        AND octet_length("platform_identity_providers"."group_role_mapping"::text) <= 65536);
