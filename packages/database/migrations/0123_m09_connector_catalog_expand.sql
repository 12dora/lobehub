CREATE TABLE IF NOT EXISTS "platform_connector_oauth_states" (
	"id" text PRIMARY KEY NOT NULL,
	"state_id" varchar(32) NOT NULL,
	"state_hash" varchar(64) NOT NULL,
	"binding_id" text NOT NULL,
	"user_id" text NOT NULL,
	"connector_id" text NOT NULL,
	"revision_resource_type" varchar(64) DEFAULT 'connector' NOT NULL,
	"published_revision" integer NOT NULL,
	"pkce_verifier_ref" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"return_to" text,
	"scopes" varchar(200)[] DEFAULT ARRAY[]::varchar[] NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_connector_oauth_states_terminal_check" CHECK ("platform_connector_oauth_states"."consumed_at" IS NULL OR "platform_connector_oauth_states"."revoked_at" IS NULL),
	CONSTRAINT "platform_connector_oauth_states_pkce_ref_check" CHECK ("platform_connector_oauth_states"."pkce_verifier_ref" LIKE 'vault://%' OR "platform_connector_oauth_states"."pkce_verifier_ref" LIKE 'kms://%'),
	CONSTRAINT "platform_connector_oauth_states_hash_check" CHECK ("platform_connector_oauth_states"."state_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "platform_connector_oauth_states_revision_check" CHECK ("platform_connector_oauth_states"."published_revision" > 0 AND "platform_connector_oauth_states"."revision_resource_type" = 'connector'),
	CONSTRAINT "platform_connector_oauth_states_ttl_check" CHECK ("platform_connector_oauth_states"."expires_at" > "platform_connector_oauth_states"."created_at"
        AND "platform_connector_oauth_states"."expires_at" <= "platform_connector_oauth_states"."created_at" + interval '10 minutes')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_connector_secrets" (
	"id" text PRIMARY KEY NOT NULL,
	"connector_id" text NOT NULL,
	"slot" varchar(32) NOT NULL,
	"fingerprint" varchar(64) NOT NULL,
	"ref" text NOT NULL,
	"ciphertext" text NOT NULL,
	"key_id" varchar(256) NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_connector_secrets_slot_check" CHECK ("platform_connector_secrets"."slot" IN ('oauthBindingToken', 'oauthClientSecret', 'oauthPkceVerifier', 'sharedSecret')),
	CONSTRAINT "platform_connector_secrets_ref_check" CHECK ("platform_connector_secrets"."ref" LIKE 'kms://platform-connectors/%'),
	CONSTRAINT "platform_connector_secrets_fingerprint_check" CHECK ("platform_connector_secrets"."fingerprint" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "platform_connector_secrets_revision_check" CHECK ("platform_connector_secrets"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "platform_connector_tools" ADD COLUMN IF NOT EXISTS "display_name" varchar(200);--> statement-breakpoint
UPDATE "platform_connector_tools"
SET "display_name" = LEFT("tool_key", 200)
WHERE "display_name" IS NULL;--> statement-breakpoint
ALTER TABLE "platform_connector_tools" ALTER COLUMN "display_name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_connector_tools" ADD COLUMN IF NOT EXISTS "description" text;--> statement-breakpoint
ALTER TABLE "platform_connector_tools" ADD COLUMN IF NOT EXISTS "input_schema" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_connector_tools" ADD COLUMN IF NOT EXISTS "output_schema" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_connector_tools" ADD COLUMN IF NOT EXISTS "enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_connector_tools" ADD COLUMN IF NOT EXISTS "platform_policy" varchar(16) DEFAULT 'deny' NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_connector_tools" ADD COLUMN IF NOT EXISTS "risk_level" varchar(16) DEFAULT 'high' NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_connector_tools" ADD COLUMN IF NOT EXISTS "requires_confirmation" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_connector_tools" ADD COLUMN IF NOT EXISTS "sort" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_connectors" ADD COLUMN IF NOT EXISTS "display_name" varchar(200);--> statement-breakpoint
UPDATE "platform_connectors"
SET "display_name" = LEFT("name", 200)
WHERE "display_name" IS NULL;--> statement-breakpoint
ALTER TABLE "platform_connectors" ALTER COLUMN "display_name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_connectors" ADD COLUMN IF NOT EXISTS "endpoint" text;--> statement-breakpoint
ALTER TABLE "platform_connectors" ADD COLUMN IF NOT EXISTS "transport" varchar(16) DEFAULT 'http' NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_connectors" ADD COLUMN IF NOT EXISTS "oauth_config" jsonb;--> statement-breakpoint
ALTER TABLE "platform_connectors" ADD COLUMN IF NOT EXISTS "shared_secret_ref" text;--> statement-breakpoint
ALTER TABLE "platform_connectors" ADD COLUMN IF NOT EXISTS "shared_secret_fingerprint" varchar(256);--> statement-breakpoint
ALTER TABLE "platform_connectors" ADD COLUMN IF NOT EXISTS "shared_secret_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "platform_connectors" ADD COLUMN IF NOT EXISTS "oauth_client_secret_ref" text;--> statement-breakpoint
ALTER TABLE "platform_connectors" ADD COLUMN IF NOT EXISTS "oauth_client_secret_fingerprint" varchar(256);--> statement-breakpoint
ALTER TABLE "platform_connectors" ADD COLUMN IF NOT EXISTS "oauth_client_secret_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "platform_connectors" ADD COLUMN IF NOT EXISTS "sort" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_connectors" ADD COLUMN IF NOT EXISTS "published_resource_type" varchar(64) DEFAULT 'connector' NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_connectors" ADD COLUMN IF NOT EXISTS "published_revision" integer;--> statement-breakpoint
ALTER TABLE "platform_connectors" ADD COLUMN IF NOT EXISTS "published_checksum" varchar(64);--> statement-breakpoint
ALTER TABLE "platform_connectors" ADD COLUMN IF NOT EXISTS "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "platform_user_connector_bindings" ADD COLUMN IF NOT EXISTS "revision_resource_type" varchar(64) DEFAULT 'connector' NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_user_connector_bindings" ADD COLUMN IF NOT EXISTS "published_revision" integer;--> statement-breakpoint
ALTER TABLE "platform_user_connector_bindings" ADD COLUMN IF NOT EXISTS "binding_status" varchar(32) DEFAULT 'disconnected' NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_user_connector_bindings" ADD COLUMN IF NOT EXISTS "oauth_token_ref" text;--> statement-breakpoint
ALTER TABLE "platform_user_connector_bindings" ADD COLUMN IF NOT EXISTS "token_fingerprint" varchar(256);--> statement-breakpoint
ALTER TABLE "platform_user_connector_bindings" ADD COLUMN IF NOT EXISTS "scopes" varchar(200)[] DEFAULT ARRAY[]::varchar[] NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_user_connector_bindings" ADD COLUMN IF NOT EXISTS "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "platform_user_connector_bindings" ADD COLUMN IF NOT EXISTS "last_error_category" varchar(32);--> statement-breakpoint
ALTER TABLE "platform_user_connector_bindings" ADD COLUMN IF NOT EXISTS "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_user_connector_bindings_oauth_state_owner_unique" ON "platform_user_connector_bindings" USING btree ("id","user_id","connector_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_resource_revisions_type_id_revision_checksum_unique" ON "platform_resource_revisions" USING btree ("resource_type","resource_id","revision","checksum");--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "platform_connector_oauth_states" ADD CONSTRAINT "platform_connector_oauth_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "platform_connector_oauth_states" ADD CONSTRAINT "platform_connector_oauth_states_connector_id_platform_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."platform_connectors"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "platform_connector_oauth_states" ADD CONSTRAINT "platform_connector_oauth_states_binding_owner_fk" FOREIGN KEY ("binding_id","user_id","connector_id") REFERENCES "public"."platform_user_connector_bindings"("id","user_id","connector_id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "platform_connector_oauth_states" ADD CONSTRAINT "platform_connector_oauth_states_revision_fk" FOREIGN KEY ("revision_resource_type","connector_id","published_revision") REFERENCES "public"."platform_resource_revisions"("resource_type","resource_id","revision") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "platform_connector_secrets" ADD CONSTRAINT "platform_connector_secrets_connector_id_platform_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."platform_connectors"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_connector_oauth_states_state_id_unique" ON "platform_connector_oauth_states" USING btree ("state_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_connector_oauth_states_state_hash_unique" ON "platform_connector_oauth_states" USING btree ("state_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_connector_oauth_states_binding_created_idx" ON "platform_connector_oauth_states" USING btree ("binding_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_connector_oauth_states_user_connector_idx" ON "platform_connector_oauth_states" USING btree ("user_id","connector_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_connector_oauth_states_expires_idx" ON "platform_connector_oauth_states" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_connector_secrets_ref_unique" ON "platform_connector_secrets" USING btree ("ref");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_connector_secrets_lookup_idx" ON "platform_connector_secrets" USING btree ("connector_id","slot","fingerprint","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_connector_secrets_key_id_idx" ON "platform_connector_secrets" USING btree ("key_id");--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "platform_connectors" ADD CONSTRAINT "platform_connectors_published_revision_fk" FOREIGN KEY ("published_resource_type","id","published_revision","published_checksum") REFERENCES "public"."platform_resource_revisions"("resource_type","resource_id","revision","checksum") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "platform_user_connector_bindings" ADD CONSTRAINT "platform_user_connector_bindings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "platform_user_connector_bindings" ADD CONSTRAINT "platform_user_connector_bindings_revision_fk" FOREIGN KEY ("revision_resource_type","connector_id","published_revision") REFERENCES "public"."platform_resource_revisions"("resource_type","resource_id","revision") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_connector_tools_connector_sort_key_id_idx" ON "platform_connector_tools" USING btree ("connector_id","sort","tool_key","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_connectors_status_key_id_idx" ON "platform_connectors" USING btree ("status","connector_key","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_connectors_enabled_sort_id_idx" ON "platform_connectors" USING btree ("enabled","sort","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_user_connector_bindings_user_id_id_idx" ON "platform_user_connector_bindings" USING btree ("user_id","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_user_connector_bindings_connector_id_id_idx" ON "platform_user_connector_bindings" USING btree ("connector_id","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_user_connector_bindings_status_expires_idx" ON "platform_user_connector_bindings" USING btree ("binding_status","expires_at");--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "platform_connector_tools" ADD CONSTRAINT "platform_connector_tools_policy_check" CHECK ("platform_connector_tools"."platform_policy" IN ('allow', 'deny'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "platform_connector_tools" ADD CONSTRAINT "platform_connector_tools_risk_check" CHECK ("platform_connector_tools"."risk_level" IN ('low', 'medium', 'high', 'critical'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "platform_connector_tools" ADD CONSTRAINT "platform_connector_tools_schema_check" CHECK (jsonb_typeof("platform_connector_tools"."input_schema") = 'object'
        AND jsonb_typeof("platform_connector_tools"."output_schema") = 'object'
        AND octet_length("platform_connector_tools"."input_schema"::text) <= 65536
        AND octet_length("platform_connector_tools"."output_schema"::text) <= 65536);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "platform_connector_tools" ADD CONSTRAINT "platform_connector_tools_confirmation_check" CHECK ("platform_connector_tools"."risk_level" NOT IN ('high', 'critical') OR "platform_connector_tools"."requires_confirmation" = true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "platform_connectors" ADD CONSTRAINT "platform_connectors_transport_http_check" CHECK ("platform_connectors"."endpoint" IS NULL OR "platform_connectors"."transport" = 'http');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "platform_connectors" ADD CONSTRAINT "platform_connectors_credential_mode_check" CHECK ("platform_connectors"."credential_mode" IN ('none', 'shared_service_account', 'per_user_oauth'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "platform_connectors" ADD CONSTRAINT "platform_connectors_credential_slot_check" CHECK ("platform_connectors"."endpoint" IS NULL OR (
        ("platform_connectors"."credential_mode" = 'none'
          AND "platform_connectors"."shared_secret_ref" IS NULL
          AND "platform_connectors"."shared_secret_fingerprint" IS NULL
          AND "platform_connectors"."shared_secret_updated_at" IS NULL
          AND "platform_connectors"."oauth_client_secret_ref" IS NULL
          AND "platform_connectors"."oauth_client_secret_fingerprint" IS NULL
          AND "platform_connectors"."oauth_client_secret_updated_at" IS NULL
          AND "platform_connectors"."oauth_config" IS NULL)
        OR ("platform_connectors"."credential_mode" = 'shared_service_account'
          AND "platform_connectors"."oauth_client_secret_ref" IS NULL
          AND "platform_connectors"."oauth_client_secret_fingerprint" IS NULL
          AND "platform_connectors"."oauth_client_secret_updated_at" IS NULL
          AND "platform_connectors"."oauth_config" IS NULL
          AND (("platform_connectors"."shared_secret_ref" IS NULL
              AND "platform_connectors"."shared_secret_fingerprint" IS NULL
              AND "platform_connectors"."shared_secret_updated_at" IS NULL)
            OR ("platform_connectors"."shared_secret_ref" IS NOT NULL
              AND "platform_connectors"."shared_secret_fingerprint" IS NOT NULL
              AND "platform_connectors"."shared_secret_updated_at" IS NOT NULL)))
        OR ("platform_connectors"."credential_mode" = 'per_user_oauth'
          AND "platform_connectors"."shared_secret_ref" IS NULL
          AND "platform_connectors"."shared_secret_fingerprint" IS NULL
          AND "platform_connectors"."shared_secret_updated_at" IS NULL
          AND "platform_connectors"."oauth_config" IS NOT NULL
          AND (("platform_connectors"."oauth_client_secret_ref" IS NULL
              AND "platform_connectors"."oauth_client_secret_fingerprint" IS NULL
              AND "platform_connectors"."oauth_client_secret_updated_at" IS NULL)
            OR ("platform_connectors"."oauth_client_secret_ref" IS NOT NULL
              AND "platform_connectors"."oauth_client_secret_fingerprint" IS NOT NULL
              AND "platform_connectors"."oauth_client_secret_updated_at" IS NOT NULL)))
      ));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "platform_connectors" ADD CONSTRAINT "platform_connectors_published_pointer_check" CHECK ("platform_connectors"."endpoint" IS NULL OR ((
        ("platform_connectors"."published_revision" IS NULL
          AND "platform_connectors"."published_checksum" IS NULL
          AND "platform_connectors"."published_at" IS NULL)
        OR ("platform_connectors"."published_revision" > 0
          AND "platform_connectors"."published_checksum" ~ '^[a-f0-9]{64}$'
          AND "platform_connectors"."published_at" IS NOT NULL)
        ) AND ("platform_connectors"."status" <> 'published' OR "platform_connectors"."published_revision" IS NOT NULL)));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "platform_connectors" ADD CONSTRAINT "platform_connectors_revision_check" CHECK ("platform_connectors"."revision" >= 0 AND "platform_connectors"."published_resource_type" = 'connector');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "platform_connectors" ADD CONSTRAINT "platform_connectors_secret_ref_check" CHECK (("platform_connectors"."shared_secret_ref" IS NULL OR "platform_connectors"."shared_secret_ref" LIKE 'vault://%' OR "platform_connectors"."shared_secret_ref" LIKE 'kms://%')
        AND ("platform_connectors"."oauth_client_secret_ref" IS NULL OR "platform_connectors"."oauth_client_secret_ref" LIKE 'vault://%' OR "platform_connectors"."oauth_client_secret_ref" LIKE 'kms://%'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "platform_connectors" ADD CONSTRAINT "platform_connectors_oauth_config_check" CHECK ("platform_connectors"."oauth_config" IS NULL
        OR (jsonb_typeof("platform_connectors"."oauth_config") = 'object'
          AND octet_length("platform_connectors"."oauth_config"::text) <= 16384
          AND "platform_connectors"."oauth_config"::text !~* '"(client_?secret|secret|access_?token|refresh_?token|token|password|authorization)"[[:space:]]*:'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "platform_connectors" ADD CONSTRAINT "platform_connectors_published_shared_secret_check" CHECK ("platform_connectors"."endpoint" IS NULL
        OR "platform_connectors"."status" <> 'published'
        OR "platform_connectors"."credential_mode" <> 'shared_service_account'
        OR ("platform_connectors"."shared_secret_ref" IS NOT NULL
          AND "platform_connectors"."shared_secret_fingerprint" IS NOT NULL
          AND "platform_connectors"."shared_secret_updated_at" IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "platform_user_connector_bindings" ADD CONSTRAINT "platform_user_connector_bindings_status_check" CHECK ("platform_user_connector_bindings"."binding_status" IN ('disconnected', 'pending', 'connected', 'expired', 'revoked', 'error'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "platform_user_connector_bindings" ADD CONSTRAINT "platform_user_connector_bindings_revision_check" CHECK ("platform_user_connector_bindings"."published_revision" IS NULL OR ("platform_user_connector_bindings"."published_revision" > 0
        AND "platform_user_connector_bindings"."revision" >= 0
        AND "platform_user_connector_bindings"."revision_resource_type" = 'connector'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "platform_user_connector_bindings" ADD CONSTRAINT "platform_user_connector_bindings_token_ref_check" CHECK (("platform_user_connector_bindings"."oauth_token_ref" IS NULL AND "platform_user_connector_bindings"."token_fingerprint" IS NULL)
        OR ("platform_user_connector_bindings"."oauth_token_ref" IS NOT NULL AND "platform_user_connector_bindings"."token_fingerprint" IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "platform_user_connector_bindings" ADD CONSTRAINT "platform_user_connector_bindings_state_fields_check" CHECK (("platform_user_connector_bindings"."binding_status" = 'connected'
          AND "platform_user_connector_bindings"."oauth_token_ref" IS NOT NULL
          AND "platform_user_connector_bindings"."token_fingerprint" IS NOT NULL
          AND "platform_user_connector_bindings"."connected_at" IS NOT NULL
          AND "platform_user_connector_bindings"."revoked_at" IS NULL)
        OR ("platform_user_connector_bindings"."binding_status" = 'revoked'
          AND "platform_user_connector_bindings"."oauth_token_ref" IS NULL
          AND "platform_user_connector_bindings"."token_fingerprint" IS NULL
          AND cardinality("platform_user_connector_bindings"."scopes") = 0
          AND "platform_user_connector_bindings"."revoked_at" IS NOT NULL)
        OR ("platform_user_connector_bindings"."binding_status" IN ('disconnected', 'pending')
          AND "platform_user_connector_bindings"."oauth_token_ref" IS NULL
          AND "platform_user_connector_bindings"."token_fingerprint" IS NULL
          AND cardinality("platform_user_connector_bindings"."scopes") = 0
          AND "platform_user_connector_bindings"."revoked_at" IS NULL)
        OR ("platform_user_connector_bindings"."binding_status" IN ('expired', 'error') AND "platform_user_connector_bindings"."revoked_at" IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "platform_user_connector_bindings" ADD CONSTRAINT "platform_user_connector_bindings_revoked_check" CHECK (("platform_user_connector_bindings"."binding_status" = 'revoked' AND "platform_user_connector_bindings"."revoked_at" IS NOT NULL)
        OR ("platform_user_connector_bindings"."binding_status" <> 'revoked' AND "platform_user_connector_bindings"."revoked_at" IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "platform_user_connector_bindings" ADD CONSTRAINT "platform_user_connector_bindings_token_ref_format_check" CHECK ("platform_user_connector_bindings"."oauth_token_ref" IS NULL OR "platform_user_connector_bindings"."oauth_token_ref" LIKE 'vault://%' OR "platform_user_connector_bindings"."oauth_token_ref" LIKE 'kms://%');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
