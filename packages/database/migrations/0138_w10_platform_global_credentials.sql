CREATE TABLE IF NOT EXISTS "platform_global_credential_secrets" (
	"id" text PRIMARY KEY NOT NULL,
	"credential_id" integer NOT NULL,
	"fingerprint" varchar(64) NOT NULL,
	"ref" text NOT NULL,
	"ciphertext" text NOT NULL,
	"key_id" varchar(256) NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_global_credential_secrets_ref_check" CHECK ("platform_global_credential_secrets"."ref" LIKE 'kms://platform-global-credentials/%'),
	CONSTRAINT "platform_global_credential_secrets_fingerprint_check" CHECK ("platform_global_credential_secrets"."fingerprint" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "platform_global_credential_secrets_revision_check" CHECK ("platform_global_credential_secrets"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_global_credential_uploads" (
	"file_hash_id" varchar(64) PRIMARY KEY NOT NULL,
	"file_name" varchar(255) NOT NULL,
	"file_type" varchar(128) NOT NULL,
	"file_size" integer NOT NULL,
	"fingerprint" varchar(64) NOT NULL,
	"ref" text NOT NULL,
	"ciphertext" text NOT NULL,
	"key_id" varchar(256) NOT NULL,
	"created_by" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_global_credential_uploads_fingerprint_check" CHECK ("platform_global_credential_uploads"."fingerprint" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "platform_global_credential_uploads_file_size_check" CHECK ("platform_global_credential_uploads"."file_size" > 0 AND "platform_global_credential_uploads"."file_size" <= 262144),
	CONSTRAINT "platform_global_credential_uploads_ref_check" CHECK ("platform_global_credential_uploads"."ref" LIKE 'kms://platform-global-credentials/upload/%')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_global_credentials" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" varchar(100) NOT NULL,
	"name" varchar(255) NOT NULL,
	"type" varchar(32) NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_global_credentials_type_check" CHECK ("platform_global_credentials"."type" IN ('kv-env', 'kv-header', 'file')),
	CONSTRAINT "platform_global_credentials_key_check" CHECK ("platform_global_credentials"."key" ~ '^[\w-]+$' AND char_length("platform_global_credentials"."key") >= 1)
);
--> statement-breakpoint
-- Catalog-guard CHECK constraints so partially provisioned tables (CREATE TABLE IF NOT EXISTS
-- that skipped inline CHECKs on first partial apply) converge on re-apply.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'platform_global_credential_secrets_ref_check'
  ) THEN
    ALTER TABLE "platform_global_credential_secrets"
      ADD CONSTRAINT "platform_global_credential_secrets_ref_check"
      CHECK ("ref" LIKE 'kms://platform-global-credentials/%');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'platform_global_credential_secrets_fingerprint_check'
  ) THEN
    ALTER TABLE "platform_global_credential_secrets"
      ADD CONSTRAINT "platform_global_credential_secrets_fingerprint_check"
      CHECK ("fingerprint" ~ '^[a-f0-9]{64}$');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'platform_global_credential_secrets_revision_check'
  ) THEN
    ALTER TABLE "platform_global_credential_secrets"
      ADD CONSTRAINT "platform_global_credential_secrets_revision_check"
      CHECK ("revision" > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'platform_global_credential_uploads_fingerprint_check'
  ) THEN
    ALTER TABLE "platform_global_credential_uploads"
      ADD CONSTRAINT "platform_global_credential_uploads_fingerprint_check"
      CHECK ("fingerprint" ~ '^[a-f0-9]{64}$');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'platform_global_credential_uploads_file_size_check'
  ) THEN
    ALTER TABLE "platform_global_credential_uploads"
      ADD CONSTRAINT "platform_global_credential_uploads_file_size_check"
      CHECK ("file_size" > 0 AND "file_size" <= 262144);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'platform_global_credential_uploads_ref_check'
  ) THEN
    ALTER TABLE "platform_global_credential_uploads"
      ADD CONSTRAINT "platform_global_credential_uploads_ref_check"
      CHECK ("ref" LIKE 'kms://platform-global-credentials/upload/%');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'platform_global_credentials_type_check'
  ) THEN
    ALTER TABLE "platform_global_credentials"
      ADD CONSTRAINT "platform_global_credentials_type_check"
      CHECK ("type" IN ('kv-env', 'kv-header', 'file'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'platform_global_credentials_key_check'
  ) THEN
    ALTER TABLE "platform_global_credentials"
      ADD CONSTRAINT "platform_global_credentials_key_check"
      CHECK ("key" ~ '^[\w-]+$' AND char_length("key") >= 1);
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "platform_global_credential_secrets" DROP CONSTRAINT IF EXISTS "platform_global_credential_secrets_credential_id_platform_global_credentials_id_fk";--> statement-breakpoint
ALTER TABLE "platform_global_credential_secrets" ADD CONSTRAINT "platform_global_credential_secrets_credential_id_platform_global_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."platform_global_credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_global_credential_secrets_ref_unique" ON "platform_global_credential_secrets" USING btree ("ref");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_global_credential_secrets_lookup_idx" ON "platform_global_credential_secrets" USING btree ("credential_id","fingerprint","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_global_credential_secrets_key_id_idx" ON "platform_global_credential_secrets" USING btree ("key_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_global_credential_uploads_expires_at_idx" ON "platform_global_credential_uploads" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_global_credentials_key_unique" ON "platform_global_credentials" USING btree ("key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_global_credentials_type_idx" ON "platform_global_credentials" USING btree ("type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_global_credentials_enabled_idx" ON "platform_global_credentials" USING btree ("enabled");
