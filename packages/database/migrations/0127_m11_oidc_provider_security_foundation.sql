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
	CONSTRAINT "platform_identity_provider_secrets_ref_check" CHECK ("ref" LIKE 'kms://platform-identity-providers/%'),
	CONSTRAINT "platform_identity_provider_secrets_fingerprint_check" CHECK ("fingerprint" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "platform_identity_provider_secrets_revision_check" CHECK ("revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "platform_identity_providers" ALTER COLUMN "provider_key" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "platform_identity_providers" ALTER COLUMN "type" SET DEFAULT 'generic_oidc';--> statement-breakpoint
ALTER TABLE "platform_identity_providers" ALTER COLUMN "button_label" SET DEFAULT '使用工作账号登录';--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'platform_identity_providers'
      AND column_name = 'migration_required'
  ) THEN
    ALTER TABLE "platform_identity_providers"
      ADD COLUMN "migration_required" boolean DEFAULT true NOT NULL;
    ALTER TABLE "platform_identity_providers"
      ALTER COLUMN "migration_required" SET DEFAULT false;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "platform_identity_providers" ADD COLUMN IF NOT EXISTS "secret_ref" text;--> statement-breakpoint
ALTER TABLE "platform_identity_providers" ADD COLUMN IF NOT EXISTS "secret_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "platform_identity_providers" ADD COLUMN IF NOT EXISTS "enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_identity_providers" ADD COLUMN IF NOT EXISTS "activation_revision" integer;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'platform_identity_providers'
      AND column_name = 'scopes' AND data_type <> 'jsonb'
  ) THEN
    ALTER TABLE "platform_identity_providers" ALTER COLUMN "scopes" SET DATA TYPE jsonb
      USING '["openid","profile","email"]'::jsonb;
  END IF;
END $$;--> statement-breakpoint
UPDATE "platform_identity_providers"
SET "type" = 'generic_oidc',
    "button_label" = COALESCE("button_label", '使用工作账号登录'),
    "scopes" = '["openid","profile","email"]'::jsonb,
    "use_pkce" = true,
    "claim_mapping" = '{"dingtalkTitle":[],"dingtalkUserId":[],"email":["email"],"name":["name","preferred_username"],"picture":["picture"],"subject":["sub"]}'::jsonb,
    "domain_allowlist" = '[]'::jsonb,
    "group_role_mapping" = '{}'::jsonb,
    "enabled" = false,
    "status" = CASE WHEN "status" IN ('draft', 'error', 'disabled', 'archived') THEN "status" ELSE 'draft' END,
    "revision" = GREATEST("revision", 0),
    "activation_revision" = NULL,
    "secret_ref" = NULL,
    "secret_fingerprint" = NULL,
    "secret_updated_at" = NULL
WHERE "migration_required";--> statement-breakpoint
ALTER TABLE "platform_identity_providers" ALTER COLUMN "button_label" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_identity_providers" ALTER COLUMN "scopes" SET DEFAULT '["openid","profile","email"]'::jsonb;--> statement-breakpoint
ALTER TABLE "platform_identity_providers" ALTER COLUMN "scopes" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_identity_providers" ALTER COLUMN "claim_mapping" SET DEFAULT '{"dingtalkTitle":[],"dingtalkUserId":[],"email":["email"],"name":["name","preferred_username"],"picture":["picture"],"subject":["sub"]}'::jsonb;--> statement-breakpoint
ALTER TABLE "platform_identity_providers" ALTER COLUMN "claim_mapping" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_identity_providers" ALTER COLUMN "domain_allowlist" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_identity_providers" ALTER COLUMN "group_role_mapping" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_identity_provider_secrets" DROP CONSTRAINT IF EXISTS "platform_identity_provider_secrets_provider_id_platform_identity_providers_id_fk";--> statement-breakpoint
ALTER TABLE "platform_identity_provider_secrets" ADD CONSTRAINT "platform_identity_provider_secrets_provider_id_platform_identity_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."platform_identity_providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_identity_provider_secrets_ref_unique" ON "platform_identity_provider_secrets" USING btree ("ref");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_identity_provider_secrets_provider_fingerprint_unique" ON "platform_identity_provider_secrets" USING btree ("provider_id","fingerprint");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_identity_provider_secrets_lookup_idx" ON "platform_identity_provider_secrets" USING btree ("provider_id","fingerprint","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_identity_provider_secrets_key_id_idx" ON "platform_identity_provider_secrets" USING btree ("key_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_identity_providers_enabled_status_idx" ON "platform_identity_providers" USING btree ("enabled","status");--> statement-breakpoint
ALTER TABLE "platform_identity_providers" DROP CONSTRAINT IF EXISTS "platform_identity_providers_key_check";--> statement-breakpoint
ALTER TABLE "platform_identity_providers" ADD CONSTRAINT "platform_identity_providers_key_check" CHECK ("migration_required" OR "provider_key" ~ '^[a-z0-9][a-z0-9._-]{0,127}$');--> statement-breakpoint
ALTER TABLE "platform_identity_providers" DROP CONSTRAINT IF EXISTS "platform_identity_providers_type_check";--> statement-breakpoint
ALTER TABLE "platform_identity_providers" ADD CONSTRAINT "platform_identity_providers_type_check" CHECK ("type" IN ('authentik', 'generic_oidc'));--> statement-breakpoint
ALTER TABLE "platform_identity_providers" DROP CONSTRAINT IF EXISTS "platform_identity_providers_status_check";--> statement-breakpoint
ALTER TABLE "platform_identity_providers" ADD CONSTRAINT "platform_identity_providers_status_check" CHECK ("status" IN ('draft', 'published', 'pending_restart', 'active', 'error', 'disabled', 'archived'));--> statement-breakpoint
ALTER TABLE "platform_identity_providers" DROP CONSTRAINT IF EXISTS "platform_identity_providers_revision_check";--> statement-breakpoint
ALTER TABLE "platform_identity_providers" ADD CONSTRAINT "platform_identity_providers_revision_check" CHECK ("revision" >= 0 AND ("activation_revision" IS NULL OR "activation_revision" > 0));--> statement-breakpoint
ALTER TABLE "platform_identity_providers" DROP CONSTRAINT IF EXISTS "platform_identity_providers_migration_state_check";--> statement-breakpoint
ALTER TABLE "platform_identity_providers" ADD CONSTRAINT "platform_identity_providers_migration_state_check" CHECK (NOT "migration_required" OR (NOT "enabled" AND "activation_revision" IS NULL AND "secret_ref" IS NULL AND "secret_fingerprint" IS NULL AND "secret_updated_at" IS NULL AND "status" IN ('draft', 'error', 'disabled', 'archived')));--> statement-breakpoint
ALTER TABLE "platform_identity_providers" DROP CONSTRAINT IF EXISTS "platform_identity_providers_secret_state_check";--> statement-breakpoint
ALTER TABLE "platform_identity_providers" ADD CONSTRAINT "platform_identity_providers_secret_state_check" CHECK (("secret_ref" IS NULL AND "secret_fingerprint" IS NULL AND "secret_updated_at" IS NULL) OR ("secret_ref" IS NOT NULL AND "secret_fingerprint" ~ '^[a-f0-9]{64}$' AND "secret_updated_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "platform_identity_providers" DROP CONSTRAINT IF EXISTS "platform_identity_providers_secret_ref_check";--> statement-breakpoint
ALTER TABLE "platform_identity_providers" ADD CONSTRAINT "platform_identity_providers_secret_ref_check" CHECK ("secret_ref" IS NULL OR "secret_ref" LIKE 'kms://platform-identity-providers/%');--> statement-breakpoint
ALTER TABLE "platform_identity_providers" DROP CONSTRAINT IF EXISTS "platform_identity_providers_scopes_check";--> statement-breakpoint
ALTER TABLE "platform_identity_providers" ADD CONSTRAINT "platform_identity_providers_scopes_check" CHECK (jsonb_typeof("scopes") = 'array' AND jsonb_array_length(CASE WHEN jsonb_typeof("scopes") = 'array' THEN "scopes" ELSE '[]'::jsonb END) BETWEEN 1 AND 32 AND "scopes" ? 'openid' AND NOT jsonb_path_exists("scopes", '$[*] ? (@.type() != "string")') AND octet_length("scopes"::text) <= 4096);--> statement-breakpoint
ALTER TABLE "platform_identity_providers" DROP CONSTRAINT IF EXISTS "platform_identity_providers_pkce_check";--> statement-breakpoint
ALTER TABLE "platform_identity_providers" ADD CONSTRAINT "platform_identity_providers_pkce_check" CHECK ("use_pkce");--> statement-breakpoint
ALTER TABLE "platform_identity_providers" DROP CONSTRAINT IF EXISTS "platform_identity_providers_claim_mapping_check";--> statement-breakpoint
ALTER TABLE "platform_identity_providers" ADD CONSTRAINT "platform_identity_providers_claim_mapping_check" CHECK (
  jsonb_typeof("claim_mapping") = 'object'
  AND "claim_mapping" = jsonb_build_object('dingtalkTitle', "claim_mapping"->'dingtalkTitle', 'dingtalkUserId', "claim_mapping"->'dingtalkUserId', 'email', "claim_mapping"->'email', 'name', "claim_mapping"->'name', 'picture', "claim_mapping"->'picture', 'subject', "claim_mapping"->'subject')
  AND jsonb_typeof("claim_mapping"->'dingtalkTitle') = 'array' AND jsonb_typeof("claim_mapping"->'dingtalkUserId') = 'array' AND jsonb_typeof("claim_mapping"->'email') = 'array' AND jsonb_typeof("claim_mapping"->'name') = 'array' AND jsonb_typeof("claim_mapping"->'picture') = 'array' AND jsonb_typeof("claim_mapping"->'subject') = 'array'
  AND jsonb_array_length(CASE WHEN jsonb_typeof("claim_mapping"->'subject') = 'array' THEN "claim_mapping"->'subject' ELSE '[]'::jsonb END) BETWEEN 1 AND 8
  AND jsonb_array_length(CASE WHEN jsonb_typeof("claim_mapping"->'name') = 'array' THEN "claim_mapping"->'name' ELSE '[]'::jsonb END) BETWEEN 1 AND 8
  AND jsonb_array_length(CASE WHEN jsonb_typeof("claim_mapping"->'dingtalkTitle') = 'array' THEN "claim_mapping"->'dingtalkTitle' ELSE '[]'::jsonb END) <= 8
  AND jsonb_array_length(CASE WHEN jsonb_typeof("claim_mapping"->'dingtalkUserId') = 'array' THEN "claim_mapping"->'dingtalkUserId' ELSE '[]'::jsonb END) <= 8
  AND jsonb_array_length(CASE WHEN jsonb_typeof("claim_mapping"->'email') = 'array' THEN "claim_mapping"->'email' ELSE '[]'::jsonb END) <= 8
  AND jsonb_array_length(CASE WHEN jsonb_typeof("claim_mapping"->'picture') = 'array' THEN "claim_mapping"->'picture' ELSE '[]'::jsonb END) <= 8
  AND NOT jsonb_path_exists("claim_mapping", '$.*[*] ? (@.type() != "string")')
  AND NOT jsonb_path_exists("claim_mapping", '$.*[*] ? (!(@ like_regex "^[A-Za-z0-9_.:-]{1,128}$"))')
  AND octet_length("claim_mapping"::text) <= 8192
  AND "claim_mapping"::text !~* '(client.?secret|api.?key|access.?token|refresh.?token|id.?token|password|authorization|bearer|credential)'
);--> statement-breakpoint
ALTER TABLE "platform_identity_providers" DROP CONSTRAINT IF EXISTS "platform_identity_providers_policy_json_check";--> statement-breakpoint
ALTER TABLE "platform_identity_providers" ADD CONSTRAINT "platform_identity_providers_policy_json_check" CHECK (jsonb_typeof("domain_allowlist") = 'array' AND jsonb_array_length(CASE WHEN jsonb_typeof("domain_allowlist") = 'array' THEN "domain_allowlist" ELSE '[]'::jsonb END) <= 256 AND octet_length("domain_allowlist"::text) <= 65536 AND jsonb_typeof("group_role_mapping") = 'object' AND octet_length("group_role_mapping"::text) <= 65536);
