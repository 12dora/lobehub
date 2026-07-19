CREATE TABLE IF NOT EXISTS "platform_identity_provider_test_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"provider_revision" integer NOT NULL,
	"provider_secret_fingerprint" varchar(64) NOT NULL,
	"provider_secret_ref" text NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"audit_reason" text NOT NULL,
	"state_hash" varchar(64) NOT NULL,
	"nonce_hash" varchar(64) NOT NULL,
	"pkce_ciphertext" text NOT NULL,
	"pkce_key_id" varchar(256) NOT NULL,
	"redirect_uri" text NOT NULL,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"result" jsonb,
	"error_code" varchar(128),
	"expires_at" timestamp with time zone NOT NULL,
	"reserved_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_identity_provider_test_attempts_hash_check" CHECK ("platform_identity_provider_test_attempts"."state_hash" ~ '^[a-f0-9]{64}$' AND "platform_identity_provider_test_attempts"."nonce_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "platform_identity_provider_test_attempts_status_check" CHECK ("platform_identity_provider_test_attempts"."status" IN ('pending', 'processing', 'succeeded', 'failed')),
	CONSTRAINT "platform_identity_provider_test_attempts_revision_check" CHECK ("platform_identity_provider_test_attempts"."provider_revision" >= 0),
	CONSTRAINT "platform_identity_provider_test_attempts_secret_binding_check" CHECK ("platform_identity_provider_test_attempts"."provider_secret_fingerprint" ~ '^[a-f0-9]{64}$'
        AND "platform_identity_provider_test_attempts"."provider_secret_ref" LIKE 'kms://platform-identity-providers/%'),
	CONSTRAINT "platform_identity_provider_test_attempts_reason_check" CHECK (octet_length("platform_identity_provider_test_attempts"."audit_reason") BETWEEN 1 AND 4096
        AND "platform_identity_provider_test_attempts"."audit_reason" !~* '(client.?secret|api.?key|access.?token|refresh.?token|id.?token|password|authorization|bearer|credential)'),
	CONSTRAINT "platform_identity_provider_test_attempts_terminal_check" CHECK (("platform_identity_provider_test_attempts"."status" = 'pending' AND "platform_identity_provider_test_attempts"."reserved_at" IS NULL AND "platform_identity_provider_test_attempts"."completed_at" IS NULL AND "platform_identity_provider_test_attempts"."result" IS NULL AND "platform_identity_provider_test_attempts"."error_code" IS NULL)
        OR ("platform_identity_provider_test_attempts"."status" = 'processing' AND "platform_identity_provider_test_attempts"."reserved_at" IS NOT NULL AND "platform_identity_provider_test_attempts"."completed_at" IS NULL AND "platform_identity_provider_test_attempts"."result" IS NULL AND "platform_identity_provider_test_attempts"."error_code" IS NULL)
        OR ("platform_identity_provider_test_attempts"."status" = 'succeeded' AND "platform_identity_provider_test_attempts"."completed_at" IS NOT NULL AND "platform_identity_provider_test_attempts"."result" IS NOT NULL AND "platform_identity_provider_test_attempts"."error_code" IS NULL)
        OR ("platform_identity_provider_test_attempts"."status" = 'failed' AND "platform_identity_provider_test_attempts"."completed_at" IS NOT NULL AND "platform_identity_provider_test_attempts"."result" IS NULL AND "platform_identity_provider_test_attempts"."error_code" IS NOT NULL)),
	CONSTRAINT "platform_identity_provider_test_attempts_ttl_check" CHECK ("platform_identity_provider_test_attempts"."expires_at" > "platform_identity_provider_test_attempts"."created_at" AND "platform_identity_provider_test_attempts"."expires_at" <= "platform_identity_provider_test_attempts"."created_at" + interval '10 minutes')
);
--> statement-breakpoint
ALTER TABLE "platform_identity_provider_test_attempts" DROP CONSTRAINT IF EXISTS "platform_identity_provider_test_attempts_provider_id_platform_identity_providers_id_fk";--> statement-breakpoint
ALTER TABLE "platform_identity_provider_test_attempts" ADD CONSTRAINT "platform_identity_provider_test_attempts_provider_id_platform_identity_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."platform_identity_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_identity_provider_test_attempts_state_hash_unique" ON "platform_identity_provider_test_attempts" USING btree ("state_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_identity_provider_test_attempts_user_provider_idx" ON "platform_identity_provider_test_attempts" USING btree ("user_id","provider_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_identity_provider_test_attempts_expires_idx" ON "platform_identity_provider_test_attempts" USING btree ("expires_at");
