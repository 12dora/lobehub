-- Upgrade bridge for databases whose Drizzle journal ends at the pinned v2.2.10 baseline (0116).
-- This is the idempotent 0117-0155 evolution preserved from the pre-squash chain.
-- Fresh installs already have the final schema from 0000; these statements converge as no-ops.

-- Historical 0117_add_platform_tables
CREATE TABLE IF NOT EXISTS "platform_resource_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"resource_type" varchar(64) NOT NULL,
	"resource_id" text NOT NULL,
	"revision" integer NOT NULL,
	"status" varchar(32) NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"checksum" text NOT NULL,
	"secret_fingerprint" text,
	"comment" text,
	"created_by" text,
	"published_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_audit_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_user_id" text,
	"action" text NOT NULL,
	"target_type" varchar(64) NOT NULL,
	"target_id" text,
	"result" varchar(32) NOT NULL,
	"reason" text,
	"request_id" text,
	"ip_hash" text,
	"user_agent" text,
	"before_diff" jsonb,
	"after_diff" jsonb,
	"config_revision" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"type" varchar(128) NOT NULL,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"idempotency_key" text NOT NULL,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"progress_total" integer,
	"progress_done" integer DEFAULT 0 NOT NULL,
	"cursor" jsonb,
	"result_summary" jsonb,
	"last_error" jsonb,
	"attempt" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"requested_by" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_setting_policies" (
	"path" text PRIMARY KEY NOT NULL,
	"mode" varchar(32) DEFAULT 'user' NOT NULL,
	"value" jsonb,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"status" varchar(32) DEFAULT 'draft' NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_setting_overrides" (
	"user_id" text NOT NULL,
	"path" text NOT NULL,
	"value" jsonb,
	"source" varchar(32) DEFAULT 'user' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_setting_overrides_pkey" PRIMARY KEY("user_id","path")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_managed_resource_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"resource" text NOT NULL,
	"enforcement" varchar(32) DEFAULT 'observe' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"status" varchar(32) DEFAULT 'draft' NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_ai_models" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"model_key" varchar(150) NOT NULL,
	"display_name" varchar(200),
	"description" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"type" varchar(20) DEFAULT 'chat' NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"pricing" jsonb,
	"parameters" jsonb DEFAULT '{}'::jsonb,
	"config" jsonb,
	"abilities" jsonb DEFAULT '{}'::jsonb,
	"context_window_tokens" integer,
	"settings" jsonb DEFAULT '{}'::jsonb,
	"status" varchar(32) DEFAULT 'draft' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"updated_by" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_ai_providers" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_key" varchar(64) NOT NULL,
	"display_name" text NOT NULL,
	"description" text,
	"logo" text,
	"source" varchar(32) DEFAULT 'custom' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"fetch_on_client" boolean DEFAULT false NOT NULL,
	"check_model" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"encrypted_key_vaults" text,
	"secret_key_version" integer,
	"secret_updated_at" timestamp with time zone,
	"secret_fingerprint" text,
	"sort" integer DEFAULT 0 NOT NULL,
	"status" varchar(32) DEFAULT 'draft' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_skill_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"skill_id" text NOT NULL,
	"version" text NOT NULL,
	"manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"content_ref" text,
	"zip_hash" text,
	"validation_result" jsonb,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_skills" (
	"id" text PRIMARY KEY NOT NULL,
	"skill_key" varchar(128) NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"source" varchar(32) DEFAULT 'uploaded' NOT NULL,
	"distribution" varchar(32) DEFAULT 'optional' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"current_version" text,
	"status" varchar(32) DEFAULT 'draft' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"manifest" jsonb DEFAULT '{}'::jsonb,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_connector_tools" (
	"id" text PRIMARY KEY NOT NULL,
	"connector_id" text NOT NULL,
	"tool_key" varchar(128) NOT NULL,
	"manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"permission_policy" varchar(32) DEFAULT 'needs_approval' NOT NULL,
	"allow_user_stricter_policy" boolean DEFAULT true NOT NULL,
	"limit_config" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_connectors" (
	"id" text PRIMARY KEY NOT NULL,
	"connector_key" varchar(128) NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"source_type" varchar(32) DEFAULT 'custom' NOT NULL,
	"connection_type" varchar(32) DEFAULT 'http' NOT NULL,
	"mcp_server_url" text,
	"mcp_stdio_config" jsonb,
	"credential_mode" varchar(64) DEFAULT 'per_user_oauth' NOT NULL,
	"oidc_config" jsonb,
	"encrypted_shared_credentials" text,
	"secret_fingerprint" text,
	"is_required" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"status" varchar(32) DEFAULT 'draft' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_user_connector_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"connector_id" text NOT NULL,
	"auth_status" varchar(32) DEFAULT 'disconnected' NOT NULL,
	"encrypted_credentials" text,
	"expires_at" timestamp with time zone,
	"last_error" text,
	"connected_at" timestamp with time zone,
	"status" varchar(32) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_agent_assignments" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"target_type" varchar(32) NOT NULL,
	"target_id" text NOT NULL,
	"materialized_agent_id" text,
	"installed_version" text,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"user_overlay" jsonb,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_agent_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"version" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dependency_check" jsonb,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_agents" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_key" varchar(128) NOT NULL,
	"system_key" varchar(128),
	"slug" varchar(128),
	"title" text NOT NULL,
	"description" text,
	"avatar" text,
	"background_color" text,
	"tags" jsonb DEFAULT '[]'::jsonb,
	"provider" text,
	"model" text,
	"system_role" text,
	"params" jsonb DEFAULT '{}'::jsonb,
	"plugins" jsonb DEFAULT '[]'::jsonb,
	"chat_config" jsonb DEFAULT '{}'::jsonb,
	"agency_config" jsonb DEFAULT '{}'::jsonb,
	"opening_message" text,
	"opening_questions" jsonb DEFAULT '[]'::jsonb,
	"distribution" varchar(32) DEFAULT 'optional' NOT NULL,
	"edit_policy" varchar(32) DEFAULT 'user_override' NOT NULL,
	"delete_policy" varchar(32) DEFAULT 'hideable' NOT NULL,
	"pin_policy" varchar(32) DEFAULT 'user' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"current_version" text,
	"status" varchar(32) DEFAULT 'draft' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_identity_providers" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_key" varchar(128) NOT NULL,
	"type" varchar(32) DEFAULT 'oidc' NOT NULL,
	"display_name" text NOT NULL,
	"button_label" text,
	"icon" text,
	"issuer" text,
	"discovery_url" text,
	"client_id" text,
	"encrypted_client_secret" text,
	"secret_fingerprint" text,
	"scopes" text,
	"use_pkce" boolean DEFAULT true NOT NULL,
	"claim_mapping" jsonb DEFAULT '{}'::jsonb,
	"domain_allowlist" jsonb DEFAULT '[]'::jsonb,
	"auto_provision" boolean DEFAULT true NOT NULL,
	"group_role_mapping" jsonb DEFAULT '{}'::jsonb,
	"status" varchar(32) DEFAULT 'draft' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_branding" (
	"id" text PRIMARY KEY NOT NULL,
	"display_name" text,
	"short_name" text,
	"legal_name" text,
	"logo_url" text,
	"icon_url" text,
	"favicon_url" text,
	"og_image_url" text,
	"support_url" text,
	"home_url" text,
	"privacy_url" text,
	"terms_url" text,
	"email_sender_name" text,
	"email_from" text,
	"page_title_template" text,
	"default_agent_display_name" text,
	"theme_defaults" jsonb DEFAULT '{}'::jsonb,
	"desktop" jsonb DEFAULT '{}'::jsonb,
	"status" varchar(32) DEFAULT 'draft' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "platform_ai_models" DROP CONSTRAINT IF EXISTS "platform_ai_models_provider_id_platform_ai_providers_id_fk";
--> statement-breakpoint
ALTER TABLE "platform_ai_models" ADD CONSTRAINT "platform_ai_models_provider_id_platform_ai_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."platform_ai_providers"("id") ON DELETE restrict ON UPDATE no action--> statement-breakpoint
ALTER TABLE "platform_skill_versions" DROP CONSTRAINT IF EXISTS "platform_skill_versions_skill_id_platform_skills_id_fk";
--> statement-breakpoint
ALTER TABLE "platform_skill_versions" ADD CONSTRAINT "platform_skill_versions_skill_id_platform_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."platform_skills"("id") ON DELETE restrict ON UPDATE no action--> statement-breakpoint
ALTER TABLE "platform_connector_tools" DROP CONSTRAINT IF EXISTS "platform_connector_tools_connector_id_platform_connectors_id_fk";
--> statement-breakpoint
ALTER TABLE "platform_connector_tools" ADD CONSTRAINT "platform_connector_tools_connector_id_platform_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."platform_connectors"("id") ON DELETE restrict ON UPDATE no action--> statement-breakpoint
ALTER TABLE "platform_user_connector_bindings" DROP CONSTRAINT IF EXISTS "platform_user_connector_bindings_connector_id_platform_connectors_id_fk";
--> statement-breakpoint
ALTER TABLE "platform_user_connector_bindings" ADD CONSTRAINT "platform_user_connector_bindings_connector_id_platform_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."platform_connectors"("id") ON DELETE restrict ON UPDATE no action--> statement-breakpoint
ALTER TABLE "platform_agent_assignments" DROP CONSTRAINT IF EXISTS "platform_agent_assignments_agent_id_platform_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "platform_agent_assignments" ADD CONSTRAINT "platform_agent_assignments_agent_id_platform_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."platform_agents"("id") ON DELETE restrict ON UPDATE no action--> statement-breakpoint
ALTER TABLE "platform_agent_versions" DROP CONSTRAINT IF EXISTS "platform_agent_versions_agent_id_platform_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "platform_agent_versions" ADD CONSTRAINT "platform_agent_versions_agent_id_platform_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."platform_agents"("id") ON DELETE restrict ON UPDATE no action--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_resource_revisions_type_id_revision_unique" ON "platform_resource_revisions" USING btree ("resource_type","resource_id","revision");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_resource_revisions_created_at_idx" ON "platform_resource_revisions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_resource_revisions_type_id_idx" ON "platform_resource_revisions" USING btree ("resource_type","resource_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_resource_revisions_status_idx" ON "platform_resource_revisions" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_audit_logs_created_at_idx" ON "platform_audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_audit_logs_actor_user_id_idx" ON "platform_audit_logs" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_audit_logs_target_type_id_idx" ON "platform_audit_logs" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_audit_logs_action_idx" ON "platform_audit_logs" USING btree ("action");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_audit_logs_request_id_idx" ON "platform_audit_logs" USING btree ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_jobs_type_idempotency_key_unique" ON "platform_jobs" USING btree ("type","idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_jobs_status_lease_until_idx" ON "platform_jobs" USING btree ("status","lease_until");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_jobs_type_status_idx" ON "platform_jobs" USING btree ("type","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_jobs_created_at_idx" ON "platform_jobs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_jobs_requested_by_idx" ON "platform_jobs" USING btree ("requested_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_setting_policies_status_idx" ON "platform_setting_policies" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_setting_policies_path_status_idx" ON "platform_setting_policies" USING btree ("path","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_setting_overrides_user_id_idx" ON "user_setting_overrides" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_managed_resource_policies_resource_unique" ON "platform_managed_resource_policies" USING btree ("resource");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_managed_resource_policies_status_idx" ON "platform_managed_resource_policies" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_ai_models_provider_id_model_key_unique" ON "platform_ai_models" USING btree ("provider_id","model_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_ai_models_enabled_sort_idx" ON "platform_ai_models" USING btree ("enabled","sort");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_ai_models_status_idx" ON "platform_ai_models" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_ai_models_provider_id_idx" ON "platform_ai_models" USING btree ("provider_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_ai_providers_provider_key_unique" ON "platform_ai_providers" USING btree ("provider_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_ai_providers_status_idx" ON "platform_ai_providers" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_ai_providers_enabled_sort_idx" ON "platform_ai_providers" USING btree ("enabled","sort");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_skill_versions_skill_id_version_unique" ON "platform_skill_versions" USING btree ("skill_id","version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_skill_versions_skill_id_idx" ON "platform_skill_versions" USING btree ("skill_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_skills_skill_key_unique" ON "platform_skills" USING btree ("skill_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_skills_status_idx" ON "platform_skills" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_skills_enabled_idx" ON "platform_skills" USING btree ("enabled");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_connector_tools_connector_id_tool_key_unique" ON "platform_connector_tools" USING btree ("connector_id","tool_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_connector_tools_connector_id_idx" ON "platform_connector_tools" USING btree ("connector_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_connectors_connector_key_unique" ON "platform_connectors" USING btree ("connector_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_connectors_status_idx" ON "platform_connectors" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_user_connector_bindings_user_connector_unique" ON "platform_user_connector_bindings" USING btree ("user_id","connector_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_user_connector_bindings_user_id_idx" ON "platform_user_connector_bindings" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_user_connector_bindings_connector_id_idx" ON "platform_user_connector_bindings" USING btree ("connector_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_user_connector_bindings_status_idx" ON "platform_user_connector_bindings" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_agent_assignments_agent_target_unique" ON "platform_agent_assignments" USING btree ("agent_id","target_type","target_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_agent_assignments_agent_id_idx" ON "platform_agent_assignments" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_agent_assignments_target_idx" ON "platform_agent_assignments" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_agent_assignments_status_idx" ON "platform_agent_assignments" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_agent_versions_agent_id_version_unique" ON "platform_agent_versions" USING btree ("agent_id","version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_agent_versions_agent_id_idx" ON "platform_agent_versions" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_agents_agent_key_unique" ON "platform_agents" USING btree ("agent_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_agents_system_key_unique" ON "platform_agents" USING btree ("system_key") WHERE "platform_agents"."system_key" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_agents_status_idx" ON "platform_agents" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_agents_distribution_idx" ON "platform_agents" USING btree ("distribution");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_identity_providers_provider_key_unique" ON "platform_identity_providers" USING btree ("provider_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_identity_providers_status_idx" ON "platform_identity_providers" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_branding_status_idx" ON "platform_branding" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_branding_revision_idx" ON "platform_branding" USING btree ("revision");--> statement-breakpoint

--> statement-breakpoint

-- Historical 0118_add_platform_easyauth_snapshots
CREATE TABLE IF NOT EXISTS "platform_easyauth_grant_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"external_user_id" text NOT NULL,
	"app_key" varchar(64) DEFAULT 'aihub' NOT NULL,
	"groups" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"grants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"grant_version" integer DEFAULT 0 NOT NULL,
	"catalog_version" integer DEFAULT 0 NOT NULL,
	"snapshot_version" text DEFAULT '0' NOT NULL,
	"expires_at" timestamp with time zone,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"degraded" boolean DEFAULT false NOT NULL,
	"last_error" text,
	"access_granted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "platform_easyauth_grant_snapshots" ADD CONSTRAINT "platform_easyauth_grant_snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_easyauth_grant_snapshots_user_app_unique" ON "platform_easyauth_grant_snapshots" USING btree ("user_id","app_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_easyauth_grant_snapshots_external_idx" ON "platform_easyauth_grant_snapshots" USING btree ("external_user_id","app_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_easyauth_grant_snapshots_access_idx" ON "platform_easyauth_grant_snapshots" USING btree ("access_granted");

--> statement-breakpoint

-- Historical 0119_m04_users_auth_invalidated_and_search_indexes
-- M04: auth security epoch columns + prefix-search expression indexes.
--
-- Production online prebuild (run before deploy so replay is a NO-OP):
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "users_email_lower_pattern_idx"
--   ON "users" USING btree (lower("email") text_pattern_ops);
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "users_username_lower_pattern_idx"
--   ON "users" USING btree (lower("username") text_pattern_ops);
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "users_normalized_email_lower_pattern_idx"
--   ON "users" USING btree (lower("normalized_email") text_pattern_ops);
--
-- Non-CONCURRENTLY below for fresh/self-hosted/PGlite (pattern from 0116).
-- Never DROP these indexes on replay.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "auth_invalidated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "auth_invalidated_excluded_session_id" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_email_lower_pattern_idx" ON "users" USING btree (lower("email") text_pattern_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_username_lower_pattern_idx" ON "users" USING btree (lower("username") text_pattern_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_normalized_email_lower_pattern_idx" ON "users" USING btree (lower("normalized_email") text_pattern_ops);

--> statement-breakpoint

-- Historical 0120_m05_settings_visibility_and_bundle
-- M05: separate visibility from mode; aggregate settings bundle; override revision + path index.
CREATE TABLE IF NOT EXISTS "platform_settings_bundle" (
	"id" text PRIMARY KEY NOT NULL,
	"draft" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" varchar(32) DEFAULT 'draft' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_setting_override_revisions" (
	"user_id" text PRIMARY KEY NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "platform_setting_policies" ADD COLUMN IF NOT EXISTS "visibility" varchar(32) DEFAULT 'visible' NOT NULL;--> statement-breakpoint
-- Legacy mode='hidden' (if any) → mode=user + visibility=hidden (presentation only).
UPDATE "platform_setting_policies"
SET "visibility" = 'hidden', "mode" = 'user'
WHERE "mode" = 'hidden';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_setting_policies_visibility_idx" ON "platform_setting_policies" USING btree ("visibility");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_setting_overrides_path_idx" ON "user_setting_overrides" USING btree ("path");

--> statement-breakpoint

-- Historical 0121_m07_platform_ai_runtime_safety
CREATE TABLE IF NOT EXISTS "platform_ai_provider_secrets" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"ciphertext" text NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "platform_ai_providers" ADD COLUMN IF NOT EXISTS "connection_test_status" varchar(16);--> statement-breakpoint
ALTER TABLE "platform_ai_providers" ADD COLUMN IF NOT EXISTS "connection_test_latency_ms" integer;--> statement-breakpoint
ALTER TABLE "platform_ai_providers" ADD COLUMN IF NOT EXISTS "connection_test_error_category" varchar(32);--> statement-breakpoint
ALTER TABLE "platform_ai_providers" ADD COLUMN IF NOT EXISTS "connection_test_sanitized_message" varchar(500);--> statement-breakpoint
ALTER TABLE "platform_ai_providers" ADD COLUMN IF NOT EXISTS "connection_tested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "platform_ai_providers" ADD COLUMN IF NOT EXISTS "connection_tested_draft_token" varchar(64);--> statement-breakpoint
ALTER TABLE "platform_ai_providers" ADD COLUMN IF NOT EXISTS "connection_tested_revision" integer;--> statement-breakpoint
ALTER TABLE "platform_ai_providers" ADD COLUMN IF NOT EXISTS "connection_test_attempt_id" text;--> statement-breakpoint
ALTER TABLE "platform_ai_provider_secrets" DROP CONSTRAINT IF EXISTS "platform_ai_provider_secrets_provider_id_platform_ai_providers_id_fk";--> statement-breakpoint
ALTER TABLE "platform_ai_provider_secrets" ADD CONSTRAINT "platform_ai_provider_secrets_provider_id_platform_ai_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."platform_ai_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_ai_provider_secrets_provider_fingerprint_unique" ON "platform_ai_provider_secrets" USING btree ("provider_id","fingerprint");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_ai_provider_secrets_provider_id_idx" ON "platform_ai_provider_secrets" USING btree ("provider_id");

--> statement-breakpoint

-- Historical 0122_m08_platform_skill_versions
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'platform_skill_versions' AND column_name = 'content'
  ) AND (
    EXISTS (SELECT 1 FROM "platform_skill_versions" LIMIT 1)
    OR EXISTS (SELECT 1 FROM "platform_skills" LIMIT 1)
  ) THEN
    RAISE EXCEPTION 'M08 requires the M01 platform Skill shell tables to be empty before migration';
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'platform_skill_versions' AND column_name = 'zip_hash'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'platform_skill_versions' AND column_name = 'checksum'
  ) THEN
    ALTER TABLE "platform_skill_versions" RENAME COLUMN "zip_hash" TO "checksum";
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'platform_skills' AND column_name = 'current_version'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'platform_skills' AND column_name = 'current_version_id'
  ) THEN
    ALTER TABLE "platform_skills" RENAME COLUMN "current_version" TO "current_version_id";
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "platform_skill_versions" ALTER COLUMN "manifest" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "platform_skill_versions" ADD COLUMN IF NOT EXISTS "content" text;--> statement-breakpoint
ALTER TABLE "platform_skill_versions" ADD COLUMN IF NOT EXISTS "resources" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_skill_versions" ADD COLUMN IF NOT EXISTS "checksum" text;--> statement-breakpoint
ALTER TABLE "platform_skill_versions" ALTER COLUMN "content" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_skill_versions" ALTER COLUMN "checksum" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_skills" ADD COLUMN IF NOT EXISTS "allow_builtin_override" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_skills" ADD COLUMN IF NOT EXISTS "draft_sequence" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_skill_versions_skill_id_id_unique" ON "platform_skill_versions" USING btree ("skill_id","id");--> statement-breakpoint
ALTER TABLE "platform_skills" DROP CONSTRAINT IF EXISTS "platform_skills_current_version_same_skill_fk";--> statement-breakpoint
ALTER TABLE "platform_skills" ADD CONSTRAINT "platform_skills_current_version_same_skill_fk" FOREIGN KEY ("id","current_version_id") REFERENCES "public"."platform_skill_versions"("skill_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_skill_versions_checksum_idx" ON "platform_skill_versions" USING btree ("checksum");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_skills_distribution_idx" ON "platform_skills" USING btree ("distribution");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_skills_current_version_id_idx" ON "platform_skills" USING btree ("current_version_id");--> statement-breakpoint
ALTER TABLE "platform_skills" DROP COLUMN IF EXISTS "manifest";--> statement-breakpoint
ALTER TABLE "platform_skills" DROP CONSTRAINT IF EXISTS "platform_skills_published_version_required";--> statement-breakpoint
ALTER TABLE "platform_skills" ADD CONSTRAINT "platform_skills_published_version_required" CHECK ("status" <> 'published' OR "current_version_id" IS NOT NULL);--> statement-breakpoint
CREATE OR REPLACE FUNCTION "prevent_platform_skill_version_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'platform_skill_versions are immutable' USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "platform_skill_versions_immutable" ON "platform_skill_versions";--> statement-breakpoint
CREATE TRIGGER "platform_skill_versions_immutable"
BEFORE UPDATE OR DELETE ON "platform_skill_versions"
FOR EACH ROW EXECUTE FUNCTION "prevent_platform_skill_version_mutation"();

--> statement-breakpoint

-- Historical 0123_m09_connector_catalog_expand
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
DO $$ BEGIN
  ALTER TABLE "platform_connector_tools" ADD CONSTRAINT "platform_connector_tools_display_name_nn" CHECK ("display_name" IS NOT NULL) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
ALTER TABLE "platform_connector_tools" VALIDATE CONSTRAINT "platform_connector_tools_display_name_nn";--> statement-breakpoint
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
DO $$ BEGIN
  ALTER TABLE "platform_connectors" ADD CONSTRAINT "platform_connectors_display_name_nn" CHECK ("display_name" IS NOT NULL) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
ALTER TABLE "platform_connectors" VALIDATE CONSTRAINT "platform_connectors_display_name_nn";--> statement-breakpoint
ALTER TABLE "platform_connectors" ALTER COLUMN "display_name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_connectors" ADD COLUMN IF NOT EXISTS "endpoint" text;--> statement-breakpoint
ALTER TABLE "platform_connectors" ADD COLUMN IF NOT EXISTS "migration_required" boolean DEFAULT true NOT NULL;--> statement-breakpoint
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

-- Only legacy HTTP rows without any historical secret-bearing fields are safe to adopt automatically.
-- OIDC/encrypted values remain in their legacy columns and are never copied into M09 metadata.
UPDATE "platform_connectors"
SET "endpoint" = NULLIF(BTRIM("mcp_server_url"), '')
WHERE "migration_required" = true
  AND "endpoint" IS NULL
  AND "connection_type" = 'http'
  AND NULLIF(BTRIM("mcp_server_url"), '') IS NOT NULL;--> statement-breakpoint
UPDATE "platform_connectors"
SET "migration_required" = false
WHERE "migration_required" = true
  AND "connection_type" = 'http'
  AND "endpoint" IS NOT NULL
  AND "credential_mode" = 'none'
  AND "oidc_config" IS NULL
  AND "encrypted_shared_credentials" IS NULL
  AND "secret_fingerprint" IS NULL
  AND "status" <> 'published';--> statement-breakpoint

ALTER TABLE "platform_user_connector_bindings" ADD COLUMN IF NOT EXISTS "revision_resource_type" varchar(64) DEFAULT 'connector' NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_user_connector_bindings" ADD COLUMN IF NOT EXISTS "published_revision" integer;--> statement-breakpoint
ALTER TABLE "platform_user_connector_bindings" ADD COLUMN IF NOT EXISTS "binding_status" varchar(32) DEFAULT 'disconnected' NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_user_connector_bindings" ADD COLUMN IF NOT EXISTS "oauth_token_ref" text;--> statement-breakpoint
ALTER TABLE "platform_user_connector_bindings" ADD COLUMN IF NOT EXISTS "token_fingerprint" varchar(256);--> statement-breakpoint
ALTER TABLE "platform_user_connector_bindings" ADD COLUMN IF NOT EXISTS "scopes" varchar(200)[] DEFAULT ARRAY[]::varchar[] NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_user_connector_bindings" ADD COLUMN IF NOT EXISTS "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "platform_user_connector_bindings" ADD COLUMN IF NOT EXISTS "last_error_category" varchar(32);--> statement-breakpoint
ALTER TABLE "platform_user_connector_bindings" ADD COLUMN IF NOT EXISTS "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Production predeploy (outside the transactional migrator):
-- CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "platform_user_connector_bindings_oauth_state_owner_unique" ON "platform_user_connector_bindings" ("id","user_id","connector_id");
-- The transactional statement is a no-op when the prebuilt index already exists. On a populated
-- table it is permitted only for <=10,000 rows or an explicitly approved maintenance window.
DO $$ DECLARE bounded_count integer; BEGIN
  IF to_regclass('public.platform_user_connector_bindings_oauth_state_owner_unique') IS NULL THEN
    SELECT count(*) INTO bounded_count FROM (SELECT 1 FROM "platform_user_connector_bindings" LIMIT 10001) rows;
    IF bounded_count > 10000 AND coalesce(current_setting('aihub.m09_maintenance_window', true), 'off') <> 'on' THEN
      RAISE EXCEPTION 'M09_PREDEPLOY_INDEX_REQUIRED:platform_user_connector_bindings_oauth_state_owner_unique';
    END IF;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_user_connector_bindings_oauth_state_owner_unique" ON "platform_user_connector_bindings" USING btree ("id","user_id","connector_id");--> statement-breakpoint
-- Production predeploy (outside the transactional migrator):
-- CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "platform_resource_revisions_type_id_revision_checksum_unique" ON "platform_resource_revisions" ("resource_type","resource_id","revision","checksum");
DO $$ DECLARE bounded_count integer; BEGIN
  IF to_regclass('public.platform_resource_revisions_type_id_revision_checksum_unique') IS NULL THEN
    SELECT count(*) INTO bounded_count FROM (SELECT 1 FROM "platform_resource_revisions" LIMIT 10001) rows;
    IF bounded_count > 10000 AND coalesce(current_setting('aihub.m09_maintenance_window', true), 'off') <> 'on' THEN
      RAISE EXCEPTION 'M09_PREDEPLOY_INDEX_REQUIRED:platform_resource_revisions_type_id_revision_checksum_unique';
    END IF;
  END IF;
END $$;--> statement-breakpoint
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
  ALTER TABLE "platform_connectors" ADD CONSTRAINT "platform_connectors_published_revision_fk" FOREIGN KEY ("published_resource_type","id","published_revision","published_checksum") REFERENCES "public"."platform_resource_revisions"("resource_type","resource_id","revision","checksum") ON DELETE restrict ON UPDATE no action NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$
BEGIN
  -- Existing orphan bindings may contain credentials. Preserve them; M15 must inventory and
  -- resolve them before running VALIDATE CONSTRAINT in a later contract migration.
  ALTER TABLE "platform_user_connector_bindings" ADD CONSTRAINT "platform_user_connector_bindings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "platform_user_connector_bindings" ADD CONSTRAINT "platform_user_connector_bindings_revision_fk" FOREIGN KEY ("revision_resource_type","connector_id","published_revision") REFERENCES "public"."platform_resource_revisions"("resource_type","resource_id","revision") ON DELETE restrict ON UPDATE no action NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
-- Existing-table CHECK constraints are NOT VALID to avoid an inline historical scan while still
-- enforcing every new write. M15 must clean isolated legacy rows, then validate them separately.
DO $$
BEGIN
  ALTER TABLE "platform_connector_tools" ADD CONSTRAINT "platform_connector_tools_policy_check" CHECK ("platform_connector_tools"."platform_policy" IN ('allow', 'deny')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "platform_connector_tools" ADD CONSTRAINT "platform_connector_tools_risk_check" CHECK ("platform_connector_tools"."risk_level" IN ('low', 'medium', 'high', 'critical')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "platform_connector_tools" ADD CONSTRAINT "platform_connector_tools_schema_check" CHECK (jsonb_typeof("platform_connector_tools"."input_schema") = 'object'
        AND jsonb_typeof("platform_connector_tools"."output_schema") = 'object'
        AND octet_length("platform_connector_tools"."input_schema"::text) <= 65536
        AND octet_length("platform_connector_tools"."output_schema"::text) <= 65536) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "platform_connector_tools" ADD CONSTRAINT "platform_connector_tools_confirmation_check" CHECK ("platform_connector_tools"."risk_level" NOT IN ('high', 'critical') OR "platform_connector_tools"."requires_confirmation" = true) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "platform_connectors" ADD CONSTRAINT "platform_connectors_transport_http_check" CHECK ("platform_connectors"."migration_required" OR ("platform_connectors"."endpoint" IS NOT NULL AND "platform_connectors"."transport" = 'http')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "platform_connectors" ADD CONSTRAINT "platform_connectors_credential_mode_check" CHECK ("platform_connectors"."migration_required" OR "platform_connectors"."credential_mode" IN ('none', 'shared_service_account', 'per_user_oauth')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "platform_connectors" ADD CONSTRAINT "platform_connectors_credential_slot_check" CHECK ("platform_connectors"."migration_required" OR (
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
      )) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "platform_connectors" ADD CONSTRAINT "platform_connectors_published_pointer_check" CHECK ("platform_connectors"."migration_required" OR ((
        ("platform_connectors"."published_revision" IS NULL
          AND "platform_connectors"."published_checksum" IS NULL
          AND "platform_connectors"."published_at" IS NULL)
        OR ("platform_connectors"."published_revision" > 0
          AND "platform_connectors"."published_checksum" ~ '^[a-f0-9]{64}$'
          AND "platform_connectors"."published_at" IS NOT NULL)
        ) AND ("platform_connectors"."status" <> 'published' OR "platform_connectors"."published_revision" IS NOT NULL))) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "platform_connectors" ADD CONSTRAINT "platform_connectors_revision_check" CHECK ("platform_connectors"."revision" >= 0 AND "platform_connectors"."published_resource_type" = 'connector') NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "platform_connectors" ADD CONSTRAINT "platform_connectors_secret_ref_check" CHECK (("platform_connectors"."shared_secret_ref" IS NULL OR "platform_connectors"."shared_secret_ref" LIKE 'vault://%' OR "platform_connectors"."shared_secret_ref" LIKE 'kms://%')
        AND ("platform_connectors"."oauth_client_secret_ref" IS NULL OR "platform_connectors"."oauth_client_secret_ref" LIKE 'vault://%' OR "platform_connectors"."oauth_client_secret_ref" LIKE 'kms://%')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "platform_connectors" ADD CONSTRAINT "platform_connectors_oauth_config_check" CHECK ("platform_connectors"."oauth_config" IS NULL
        OR (jsonb_typeof("platform_connectors"."oauth_config") = 'object'
          AND octet_length("platform_connectors"."oauth_config"::text) <= 16384
          AND "platform_connectors"."oauth_config"::text !~* '"(client_?secret|secret|access_?token|refresh_?token|token|password|authorization)"[[:space:]]*:')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "platform_connectors" ADD CONSTRAINT "platform_connectors_published_shared_secret_check" CHECK ("platform_connectors"."migration_required"
        OR "platform_connectors"."status" <> 'published'
        OR "platform_connectors"."credential_mode" <> 'shared_service_account'
        OR ("platform_connectors"."shared_secret_ref" IS NOT NULL
          AND "platform_connectors"."shared_secret_fingerprint" IS NOT NULL
          AND "platform_connectors"."shared_secret_updated_at" IS NOT NULL)) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "platform_user_connector_bindings" ADD CONSTRAINT "platform_user_connector_bindings_status_check" CHECK ("platform_user_connector_bindings"."binding_status" IN ('disconnected', 'pending', 'connected', 'expired', 'revoked', 'error')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "platform_user_connector_bindings" ADD CONSTRAINT "platform_user_connector_bindings_revision_check" CHECK ("platform_user_connector_bindings"."published_revision" IS NULL OR ("platform_user_connector_bindings"."published_revision" > 0
        AND "platform_user_connector_bindings"."revision" >= 0
        AND "platform_user_connector_bindings"."revision_resource_type" = 'connector')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "platform_user_connector_bindings" ADD CONSTRAINT "platform_user_connector_bindings_token_ref_check" CHECK (("platform_user_connector_bindings"."oauth_token_ref" IS NULL AND "platform_user_connector_bindings"."token_fingerprint" IS NULL)
        OR ("platform_user_connector_bindings"."oauth_token_ref" IS NOT NULL AND "platform_user_connector_bindings"."token_fingerprint" IS NOT NULL)) NOT VALID;
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
        OR ("platform_user_connector_bindings"."binding_status" IN ('expired', 'error') AND "platform_user_connector_bindings"."revoked_at" IS NULL)) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "platform_user_connector_bindings" ADD CONSTRAINT "platform_user_connector_bindings_revoked_check" CHECK (("platform_user_connector_bindings"."binding_status" = 'revoked' AND "platform_user_connector_bindings"."revoked_at" IS NOT NULL)
        OR ("platform_user_connector_bindings"."binding_status" <> 'revoked' AND "platform_user_connector_bindings"."revoked_at" IS NULL)) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "platform_user_connector_bindings" ADD CONSTRAINT "platform_user_connector_bindings_token_ref_format_check" CHECK ("platform_user_connector_bindings"."oauth_token_ref" IS NULL OR "platform_user_connector_bindings"."oauth_token_ref" LIKE 'vault://%' OR "platform_user_connector_bindings"."oauth_token_ref" LIKE 'kms://%') NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint

-- Historical 0124_m09_oauth_attempt_outcome
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

--> statement-breakpoint

-- Historical 0125_m10_platform_agent_contract_expand
CREATE TABLE IF NOT EXISTS "platform_user_agent_materializations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"platform_agent_id" text NOT NULL,
	"platform_agent_version_id" text NOT NULL,
	"platform_agent_version_checksum" varchar(64) NOT NULL,
	"materialized_agent_id" text,
	"hidden" boolean DEFAULT false NOT NULL,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"last_error_category" varchar(64),
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_user_agent_materializations_checksum_check" CHECK ("platform_agent_version_checksum" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "platform_user_agent_materializations_status_check" CHECK ("status" IN ('pending', 'materialized', 'error')),
	CONSTRAINT "platform_user_agent_materializations_local_status_check" CHECK (("status" = 'materialized' AND "materialized_agent_id" IS NOT NULL) OR "status" <> 'materialized'),
	CONSTRAINT "platform_user_agent_materializations_error_category_value_check" CHECK ("last_error_category" IS NULL OR "last_error_category" IN ('local_agent_missing', 'materialization_failed', 'version_conflict')),
	CONSTRAINT "platform_user_agent_materializations_error_category_check" CHECK (("status" = 'error' AND "last_error_category" IS NOT NULL) OR ("status" <> 'error' AND "last_error_category" IS NULL))
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'platform_agents' AND column_name = 'migration_required'
  ) THEN
    -- Every pre-M10 row is retained, but cannot become effective until an administrator
    -- creates and validates an exact M10 version. This avoids silently activating loose M01 config.
    ALTER TABLE "platform_agents" ADD COLUMN "migration_required" boolean DEFAULT true NOT NULL;
    ALTER TABLE "platform_agents" ALTER COLUMN "migration_required" SET DEFAULT false;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "platform_agents" ADD COLUMN IF NOT EXISTS "current_version_id" text;
--> statement-breakpoint
ALTER TABLE "platform_agents" ADD COLUMN IF NOT EXISTS "draft_sequence" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "platform_agents" ADD COLUMN IF NOT EXISTS "published_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "platform_agent_versions" ADD COLUMN IF NOT EXISTS "dependency_snapshot" jsonb;
--> statement-breakpoint
ALTER TABLE "platform_agent_versions" ADD COLUMN IF NOT EXISTS "checksum" varchar(64);
--> statement-breakpoint
ALTER TABLE "platform_agent_assignments" ADD COLUMN IF NOT EXISTS "mode" varchar(32) DEFAULT 'optional' NOT NULL;
--> statement-breakpoint
ALTER TABLE "platform_agent_assignments" ADD COLUMN IF NOT EXISTS "version_policy" varchar(32) DEFAULT 'latest_published' NOT NULL;
--> statement-breakpoint
ALTER TABLE "platform_agent_assignments" ADD COLUMN IF NOT EXISTS "pinned_version_id" text;
--> statement-breakpoint
ALTER TABLE "platform_agent_assignments" ADD COLUMN IF NOT EXISTS "enabled" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
-- Preserve every legacy identity/config/version row. A legacy published shell without an exact
-- pointer is deliberately downgraded to Draft and marked migration_required rather than activated.
UPDATE "platform_agents" AS agent
SET "current_version_id" = version."id"
FROM "platform_agent_versions" AS version
WHERE agent."migration_required" = true
  AND agent."current_version_id" IS NULL
  AND agent."current_version" IS NOT NULL
  AND version."agent_id" = agent."id"
  AND version."version" = agent."current_version";
--> statement-breakpoint
UPDATE "platform_agents"
SET "status" = 'draft',
    "published_at" = NULL,
    "is_default" = COALESCE("system_key" = 'default-inbox', false)
WHERE "migration_required" = true;
--> statement-breakpoint
UPDATE "platform_agent_assignments" AS assignment
SET "mode" = agent."distribution"
FROM "platform_agents" AS agent
WHERE assignment."agent_id" = agent."id"
  AND agent."migration_required" = true
  AND agent."distribution" IN ('mandatory', 'default', 'optional');
--> statement-breakpoint
UPDATE "platform_agent_assignments"
SET "target_id" = '__global__'
WHERE "target_type" = 'global';
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "platform_agent_assignments" assignment
    LEFT JOIN "rbac_roles" role
      ON assignment."target_type" = 'global_role'
      AND role."id" = assignment."target_id"
      AND role."workspace_id" IS NULL
    LEFT JOIN "users" target_user
      ON assignment."target_type" = 'user'
      AND target_user."id" = assignment."target_id"
    WHERE (assignment."target_type" = 'global_role' AND role."id" IS NULL)
       OR (assignment."target_type" = 'user' AND target_user."id" IS NULL)
       OR assignment."target_type" NOT IN ('global', 'global_role', 'user')
  ) THEN
    RAISE EXCEPTION 'M10 cannot migrate invalid Agent assignment targets';
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_agent_versions_agent_id_id_unique" ON "platform_agent_versions" USING btree ("agent_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_agent_versions_agent_id_id_checksum_unique" ON "platform_agent_versions" USING btree ("agent_id","id","checksum");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_agents_current_version_id_idx" ON "platform_agents" USING btree ("current_version_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_user_agent_materializations_user_agent_unique" ON "platform_user_agent_materializations" USING btree ("user_id","platform_agent_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_user_agent_materializations_local_agent_unique" ON "platform_user_agent_materializations" USING btree ("materialized_agent_id") WHERE "materialized_agent_id" is not null;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_user_agent_materializations_user_id_idx" ON "platform_user_agent_materializations" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_user_agent_materializations_platform_agent_id_idx" ON "platform_user_agent_materializations" USING btree ("platform_agent_id");
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'platform_agent_assignments_pinned_version_same_agent_fk') THEN
    ALTER TABLE "platform_agent_assignments" ADD CONSTRAINT "platform_agent_assignments_pinned_version_same_agent_fk"
      FOREIGN KEY ("agent_id","pinned_version_id") REFERENCES "platform_agent_versions"("agent_id","id")
      ON DELETE restrict NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'platform_agents_current_version_same_agent_fk') THEN
    ALTER TABLE "platform_agents" ADD CONSTRAINT "platform_agents_current_version_same_agent_fk"
      FOREIGN KEY ("id","current_version_id") REFERENCES "platform_agent_versions"("agent_id","id")
      ON DELETE restrict NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "platform_agent_assignments" VALIDATE CONSTRAINT "platform_agent_assignments_pinned_version_same_agent_fk";
--> statement-breakpoint
ALTER TABLE "platform_agents" VALIDATE CONSTRAINT "platform_agents_current_version_same_agent_fk";
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'platform_agent_assignments_target_check') THEN
    ALTER TABLE "platform_agent_assignments" ADD CONSTRAINT "platform_agent_assignments_target_check"
      CHECK (("target_type" = 'global' AND "target_id" = '__global__') OR ("target_type" IN ('global_role', 'user') AND length("target_id") > 0 AND "target_id" <> '__global__')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'platform_agent_assignments_mode_check') THEN
    ALTER TABLE "platform_agent_assignments" ADD CONSTRAINT "platform_agent_assignments_mode_check"
      CHECK ("mode" IN ('mandatory', 'default', 'optional')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'platform_agent_assignments_version_policy_check') THEN
    ALTER TABLE "platform_agent_assignments" ADD CONSTRAINT "platform_agent_assignments_version_policy_check"
      CHECK (("version_policy" = 'latest_published' AND "pinned_version_id" IS NULL) OR ("version_policy" = 'pinned' AND "pinned_version_id" IS NOT NULL)) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'platform_agent_versions_checksum_check') THEN
    ALTER TABLE "platform_agent_versions" ADD CONSTRAINT "platform_agent_versions_checksum_check"
      CHECK ("checksum" ~ '^[a-f0-9]{64}$') NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'platform_agent_versions_exact_snapshot_pair_check') THEN
    ALTER TABLE "platform_agent_versions" ADD CONSTRAINT "platform_agent_versions_exact_snapshot_pair_check"
      CHECK (("checksum" IS NULL AND "dependency_snapshot" IS NULL) OR ("checksum" IS NOT NULL AND "dependency_snapshot" IS NOT NULL)) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'platform_agents_default_inbox_consistency_check') THEN
    ALTER TABLE "platform_agents" ADD CONSTRAINT "platform_agents_default_inbox_consistency_check"
      CHECK (("is_default" AND "system_key" = 'default-inbox') OR (NOT "is_default" AND "system_key" IS DISTINCT FROM 'default-inbox')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'platform_agents_published_pointer_check') THEN
    ALTER TABLE "platform_agents" ADD CONSTRAINT "platform_agents_published_pointer_check"
      CHECK ("status" <> 'published' OR (NOT "migration_required" AND "current_version_id" IS NOT NULL AND "published_at" IS NOT NULL)) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'platform_agents_revision_check') THEN
    ALTER TABLE "platform_agents" ADD CONSTRAINT "platform_agents_revision_check"
      CHECK ("revision" >= 0 AND "draft_sequence" >= 0) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "platform_agent_assignments" VALIDATE CONSTRAINT "platform_agent_assignments_target_check";
--> statement-breakpoint
ALTER TABLE "platform_agent_assignments" VALIDATE CONSTRAINT "platform_agent_assignments_mode_check";
--> statement-breakpoint
ALTER TABLE "platform_agent_assignments" VALIDATE CONSTRAINT "platform_agent_assignments_version_policy_check";
--> statement-breakpoint
ALTER TABLE "platform_agent_versions" VALIDATE CONSTRAINT "platform_agent_versions_checksum_check";
--> statement-breakpoint
ALTER TABLE "platform_agent_versions" VALIDATE CONSTRAINT "platform_agent_versions_exact_snapshot_pair_check";
--> statement-breakpoint
ALTER TABLE "platform_agents" VALIDATE CONSTRAINT "platform_agents_default_inbox_consistency_check";
--> statement-breakpoint
ALTER TABLE "platform_agents" VALIDATE CONSTRAINT "platform_agents_published_pointer_check";
--> statement-breakpoint
ALTER TABLE "platform_agents" VALIDATE CONSTRAINT "platform_agents_revision_check";
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'platform_user_agent_materializations_user_id_users_id_fk') THEN
    ALTER TABLE "platform_user_agent_materializations" ADD CONSTRAINT "platform_user_agent_materializations_user_id_users_id_fk"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'platform_user_agent_materializations_platform_agent_id_platform_agents_id_fk') THEN
    ALTER TABLE "platform_user_agent_materializations" ADD CONSTRAINT "platform_user_agent_materializations_platform_agent_id_platform_agents_id_fk"
      FOREIGN KEY ("platform_agent_id") REFERENCES "platform_agents"("id") ON DELETE restrict;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'platform_user_agent_materializations_materialized_agent_id_agents_id_fk') THEN
    ALTER TABLE "platform_user_agent_materializations" ADD CONSTRAINT "platform_user_agent_materializations_materialized_agent_id_agents_id_fk"
      FOREIGN KEY ("materialized_agent_id") REFERENCES "agents"("id") ON DELETE restrict;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'platform_user_agent_materializations_exact_version_fk') THEN
    ALTER TABLE "platform_user_agent_materializations" ADD CONSTRAINT "platform_user_agent_materializations_exact_version_fk"
      FOREIGN KEY ("platform_agent_id","platform_agent_version_id","platform_agent_version_checksum")
      REFERENCES "platform_agent_versions"("agent_id","id","checksum") ON DELETE restrict;
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "enforce_platform_agent_assignment_target"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."target_type" = 'global_role' THEN
    PERFORM 1 FROM "rbac_roles"
    WHERE "id" = NEW."target_id" AND "workspace_id" IS NULL
    FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'platform Agent assignments require an existing global RBAC role' USING ERRCODE = '23503';
    END IF;
  END IF;
  IF NEW."target_type" = 'user' THEN
    PERFORM 1 FROM "users" WHERE "id" = NEW."target_id" FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'platform Agent assignments require an existing user' USING ERRCODE = '23503';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'platform_agent_assignments_target_guard') THEN
    CREATE TRIGGER "platform_agent_assignments_target_guard"
      BEFORE INSERT OR UPDATE OF "target_type", "target_id" ON "platform_agent_assignments"
      FOR EACH ROW EXECUTE FUNCTION "enforce_platform_agent_assignment_target"();
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "protect_platform_agent_global_role_scope"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (
      SELECT 1 FROM "platform_agent_assignments"
      WHERE "target_type" = 'global_role' AND "target_id" = OLD."id"
    ) THEN
      RAISE EXCEPTION 'assigned global RBAC roles cannot be removed' USING ERRCODE = '23503';
    END IF;
    RETURN OLD;
  END IF;
  -- workspace_id is not a key column, so UPDATE would otherwise take a lock that
  -- does not conflict with the assignment trigger's FOR KEY SHARE lookup.
  PERFORM 1 FROM "rbac_roles" WHERE "id" = OLD."id" FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM "platform_agent_assignments"
    WHERE "target_type" = 'global_role' AND "target_id" = OLD."id"
  ) AND (NEW."id" IS DISTINCT FROM OLD."id" OR NEW."workspace_id" IS NOT NULL) THEN
    RAISE EXCEPTION 'assigned global RBAC roles cannot be moved to a workspace' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'rbac_roles_platform_agent_assignment_guard') THEN
    CREATE TRIGGER "rbac_roles_platform_agent_assignment_guard"
      BEFORE DELETE OR UPDATE OF "id", "workspace_id" ON "rbac_roles"
      FOR EACH ROW EXECUTE FUNCTION "protect_platform_agent_global_role_scope"();
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "protect_platform_agent_user_target"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (
      SELECT 1 FROM "platform_agent_assignments"
      WHERE "target_type" = 'user' AND "target_id" = OLD."id"
    ) THEN
      RAISE EXCEPTION 'users with a platform Agent assignment cannot be removed' USING ERRCODE = '23503';
    END IF;
    RETURN OLD;
  END IF;
  PERFORM 1 FROM "users" WHERE "id" = OLD."id" FOR UPDATE;
  IF NEW."id" IS DISTINCT FROM OLD."id" AND EXISTS (
    SELECT 1 FROM "platform_agent_assignments"
    WHERE "target_type" = 'user' AND "target_id" = OLD."id"
  ) THEN
    RAISE EXCEPTION 'a platform Agent assignment target user id cannot change' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'users_platform_agent_assignment_guard') THEN
    CREATE TRIGGER "users_platform_agent_assignment_guard"
      BEFORE DELETE OR UPDATE OF "id" ON "users"
      FOR EACH ROW EXECUTE FUNCTION "protect_platform_agent_user_target"();
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "enforce_platform_user_agent_materialization_owner"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND OLD."materialized_agent_id" IS NOT NULL
    AND NEW."materialized_agent_id" IS DISTINCT FROM OLD."materialized_agent_id"
  THEN
    RAISE EXCEPTION 'a materialized Agent identity cannot be replaced or cleared' USING ERRCODE = '55000';
  END IF;
  IF NEW."materialized_agent_id" IS NOT NULL THEN
    PERFORM 1 FROM "agents"
    WHERE "id" = NEW."materialized_agent_id" AND "user_id" = NEW."user_id"
    FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'materialized Agent must belong to the materialization user' USING ERRCODE = '23503';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'platform_user_agent_materializations_owner_guard') THEN
    CREATE TRIGGER "platform_user_agent_materializations_owner_guard"
      BEFORE INSERT OR UPDATE OF "user_id", "materialized_agent_id" ON "platform_user_agent_materializations"
      FOR EACH ROW EXECUTE FUNCTION "enforce_platform_user_agent_materialization_owner"();
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "protect_materialized_agent_owner"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- user_id is not part of the Agent key, so explicitly serialize owner changes
  -- with the materialization trigger's FOR KEY SHARE lookup.
  PERFORM 1 FROM "agents" WHERE "id" = OLD."id" FOR UPDATE;
  IF NEW."user_id" IS DISTINCT FROM OLD."user_id" AND EXISTS (
    SELECT 1 FROM "platform_user_agent_materializations" WHERE "materialized_agent_id" = OLD."id"
  ) THEN
    RAISE EXCEPTION 'a materialized Agent owner cannot be changed' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'agents_materialization_owner_guard') THEN
    CREATE TRIGGER "agents_materialization_owner_guard"
      BEFORE UPDATE OF "user_id" ON "agents"
      FOR EACH ROW EXECUTE FUNCTION "protect_materialized_agent_owner"();
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "require_exact_platform_agent_version_insert"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."checksum" IS NULL OR NEW."dependency_snapshot" IS NULL THEN
    RAISE EXCEPTION 'new platform Agent versions require an exact dependency snapshot and checksum' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'platform_agent_versions_exact_insert_guard') THEN
    CREATE TRIGGER "platform_agent_versions_exact_insert_guard"
      BEFORE INSERT ON "platform_agent_versions"
      FOR EACH ROW EXECUTE FUNCTION "require_exact_platform_agent_version_insert"();
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "require_exact_platform_agent_published_pointer"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" = 'published' THEN
    IF NEW."migration_required" OR NEW."current_version_id" IS NULL OR NEW."published_at" IS NULL THEN
      RAISE EXCEPTION 'published platform Agents require an exact current version' USING ERRCODE = '23514';
    END IF;
    PERFORM 1 FROM "platform_agent_versions"
    WHERE "agent_id" = NEW."id"
      AND "id" = NEW."current_version_id"
      AND "checksum" IS NOT NULL
      AND "dependency_snapshot" IS NOT NULL
    FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'published platform Agents require an exact current version' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'platform_agents_exact_published_pointer_guard') THEN
    CREATE TRIGGER "platform_agents_exact_published_pointer_guard"
      BEFORE INSERT OR UPDATE OF "status", "current_version_id", "published_at", "migration_required"
      ON "platform_agents"
      FOR EACH ROW EXECUTE FUNCTION "require_exact_platform_agent_published_pointer"();
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "prevent_platform_agent_version_mutation"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'platform_agent_versions are immutable' USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'platform_agent_versions_immutable') THEN
    CREATE TRIGGER "platform_agent_versions_immutable"
      BEFORE UPDATE OR DELETE ON "platform_agent_versions"
      FOR EACH ROW EXECUTE FUNCTION "prevent_platform_agent_version_mutation"();
  END IF;
END $$;

--> statement-breakpoint

-- Historical 0126_m10_rollout_job_indexes
-- Production predeploy MUST run scripts/migrateServerDB/predeployM10RolloutIndexes.ts first. It
-- creates both indexes CONCURRENTLY in autocommit mode. These idempotent statements are the safe
-- migration fallback for fresh/small databases and become no-ops after predeploy.
CREATE INDEX IF NOT EXISTS "platform_jobs_rollout_agent_id_id_idx" ON "platform_jobs" USING btree (("input"->'snapshot'->>'agentId'),"id") WHERE "platform_jobs"."type" = 'platform.agent.rollout.v1';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_jobs_rollout_transition_parent_status_user_idx" ON "platform_jobs" USING btree (("input"->>'parentJobId'),"status",("input"->>'userId')) WHERE "platform_jobs"."type" = 'platform.agent.rollout.transition.v1';

--> statement-breakpoint

-- Historical 0127_m11_oidc_provider_security_foundation
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

--> statement-breakpoint

-- Historical 0128_m11_identity_provider_test_attempts
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

--> statement-breakpoint

-- Historical 0129_m12_platform_branding_lifecycle
CREATE TABLE IF NOT EXISTS "platform_branding_assets" (
	"id" text PRIMARY KEY NOT NULL,
	"object_key" text NOT NULL,
	"mime_type" varchar(64) NOT NULL,
	"size" integer NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"kind" varchar(32) NOT NULL,
	"status" varchar(32) NOT NULL,
	"created_by" text,
	"request_actor_id" text NOT NULL,
	"operation" varchar(64) NOT NULL,
	"request_id" uuid NOT NULL,
	"request_fingerprint" varchar(64) NOT NULL,
	"draft_pinned" boolean DEFAULT false NOT NULL,
	"first_published_revision" integer,
	"upload_owner" uuid,
	"upload_lease_until" timestamp with time zone,
	"cleanup_owner" uuid,
	"cleanup_lease_until" timestamp with time zone,
	"cleanup_attempts" integer DEFAULT 0 NOT NULL,
	"cleanup_after" timestamp with time zone NOT NULL,
	"last_cleanup_error" varchar(128),
	"object_deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_branding_assets_size_positive" CHECK ("platform_branding_assets"."size" > 0),
	CONSTRAINT "platform_branding_assets_width_positive" CHECK ("platform_branding_assets"."width" > 0),
	CONSTRAINT "platform_branding_assets_height_positive" CHECK ("platform_branding_assets"."height" > 0),
	CONSTRAINT "platform_branding_assets_cleanup_attempts_nonnegative" CHECK ("platform_branding_assets"."cleanup_attempts" >= 0),
	CONSTRAINT "platform_branding_assets_first_revision_positive" CHECK ("platform_branding_assets"."first_published_revision" IS NULL OR "platform_branding_assets"."first_published_revision" > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_branding_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" text NOT NULL,
	"operation" varchar(64) NOT NULL,
	"resource" varchar(128) NOT NULL,
	"request_id" uuid NOT NULL,
	"fingerprint" varchar(64) NOT NULL,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"result" jsonb,
	"error_category" varchar(64),
	"lease_owner" uuid,
	"lease_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_branding_operations_terminal_shape" CHECK (("platform_branding_operations"."status" = 'pending' AND "platform_branding_operations"."result" IS NULL AND "platform_branding_operations"."error_category" IS NULL AND "platform_branding_operations"."lease_owner" IS NOT NULL AND "platform_branding_operations"."lease_until" IS NOT NULL)
        OR ("platform_branding_operations"."status" = 'succeeded' AND "platform_branding_operations"."result" IS NOT NULL AND "platform_branding_operations"."error_category" IS NULL AND "platform_branding_operations"."lease_owner" IS NULL AND "platform_branding_operations"."lease_until" IS NULL)
        OR ("platform_branding_operations"."status" = 'failed' AND "platform_branding_operations"."result" IS NULL AND "platform_branding_operations"."error_category" IS NOT NULL AND "platform_branding_operations"."lease_owner" IS NULL AND "platform_branding_operations"."lease_until" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "platform_branding_assets" DROP CONSTRAINT IF EXISTS "platform_branding_assets_created_by_users_id_fk";--> statement-breakpoint
ALTER TABLE "platform_branding_assets" ADD CONSTRAINT "platform_branding_assets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_branding_assets_object_key_unique" ON "platform_branding_assets" USING btree ("object_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_branding_assets_request_lane_unique" ON "platform_branding_assets" USING btree ("request_actor_id","operation","request_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_branding_assets_cleanup_idx" ON "platform_branding_assets" USING btree ("status","cleanup_after");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_branding_assets_created_by_idx" ON "platform_branding_assets" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_branding_assets_published_revision_idx" ON "platform_branding_assets" USING btree ("first_published_revision");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_branding_operations_request_lane_unique" ON "platform_branding_operations" USING btree ("actor_id","operation","resource","request_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_branding_operations_pending_lease_idx" ON "platform_branding_operations" USING btree ("status","lease_until");

--> statement-breakpoint

-- Historical 0130_m11_identity_provider_instances
CREATE TABLE IF NOT EXISTS "platform_identity_provider_instances" (
	"instance_id" varchar(64) PRIMARY KEY NOT NULL,
	"startup_generation" text,
	"startup_source" varchar(32) NOT NULL,
	"active_identity_revision" varchar(64),
	"health" varchar(32) NOT NULL,
	"degraded_category" varchar(128),
	"loaded_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"last_heartbeat" timestamp with time zone NOT NULL,
	"hostname_hash" varchar(64) NOT NULL,
	CONSTRAINT "platform_identity_provider_instances_id_check" CHECK ("platform_identity_provider_instances"."instance_id" ~ '^oidci_[a-f0-9]{48}$'),
	CONSTRAINT "platform_identity_provider_instances_source_check" CHECK ("platform_identity_provider_instances"."startup_source" IN ('break_glass', 'database', 'environment', 'lkg')),
	CONSTRAINT "platform_identity_provider_instances_health_check" CHECK ("platform_identity_provider_instances"."health" IN ('degraded', 'healthy')),
	CONSTRAINT "platform_identity_provider_instances_digest_check" CHECK ("platform_identity_provider_instances"."hostname_hash" ~ '^[a-f0-9]{64}$'
        AND ("platform_identity_provider_instances"."active_identity_revision" IS NULL OR "platform_identity_provider_instances"."active_identity_revision" ~ '^[a-f0-9]{64}$')),
	CONSTRAINT "platform_identity_provider_instances_health_category_check" CHECK (("platform_identity_provider_instances"."health" = 'healthy' AND "platform_identity_provider_instances"."degraded_category" IS NULL)
        OR ("platform_identity_provider_instances"."health" = 'degraded'
          AND "platform_identity_provider_instances"."degraded_category" ~ '^[a-z0-9_]{1,128}$')),
	CONSTRAINT "platform_identity_provider_instances_time_check" CHECK ("platform_identity_provider_instances"."loaded_at" >= "platform_identity_provider_instances"."started_at" AND "platform_identity_provider_instances"."last_heartbeat" >= "platform_identity_provider_instances"."started_at")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_identity_provider_restart_requests" (
	"request_id" uuid PRIMARY KEY NOT NULL,
	"actor_id" text NOT NULL,
	"target_instance_id" varchar(64) NOT NULL,
	"payload_hash" varchar(64) NOT NULL,
	"expected_identity_revision" varchar(64) NOT NULL,
	"status" varchar(32) DEFAULT 'prepared' NOT NULL,
	"intent_token_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"owner_fence" varchar(64) NOT NULL,
	"result_category" varchar(128),
	"accepted_at" timestamp with time zone,
	"signaled_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_identity_provider_restart_requests_digest_check" CHECK ("platform_identity_provider_restart_requests"."payload_hash" ~ '^[a-f0-9]{64}$'
        AND "platform_identity_provider_restart_requests"."expected_identity_revision" ~ '^[a-f0-9]{64}$'
        AND "platform_identity_provider_restart_requests"."intent_token_hash" ~ '^[a-f0-9]{64}$'
        AND "platform_identity_provider_restart_requests"."owner_fence" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "platform_identity_provider_restart_requests_status_check" CHECK ("platform_identity_provider_restart_requests"."status" IN ('prepared', 'accepted', 'signaled', 'failed')),
	CONSTRAINT "platform_identity_provider_restart_requests_result_check" CHECK ("platform_identity_provider_restart_requests"."result_category" IS NULL OR "platform_identity_provider_restart_requests"."result_category" ~ '^[a-z0-9_]{1,128}$'),
	CONSTRAINT "platform_identity_provider_restart_requests_lifecycle_check" CHECK (("platform_identity_provider_restart_requests"."status" = 'prepared'
          AND "platform_identity_provider_restart_requests"."accepted_at" IS NULL AND "platform_identity_provider_restart_requests"."signaled_at" IS NULL AND "platform_identity_provider_restart_requests"."failed_at" IS NULL
          AND "platform_identity_provider_restart_requests"."result_category" IS NULL)
        OR ("platform_identity_provider_restart_requests"."status" = 'accepted'
          AND "platform_identity_provider_restart_requests"."accepted_at" IS NOT NULL AND "platform_identity_provider_restart_requests"."signaled_at" IS NULL AND "platform_identity_provider_restart_requests"."failed_at" IS NULL
          AND "platform_identity_provider_restart_requests"."result_category" IS NULL)
        OR ("platform_identity_provider_restart_requests"."status" = 'signaled'
          AND "platform_identity_provider_restart_requests"."accepted_at" IS NOT NULL AND "platform_identity_provider_restart_requests"."signaled_at" IS NOT NULL AND "platform_identity_provider_restart_requests"."failed_at" IS NULL
          AND "platform_identity_provider_restart_requests"."result_category" = 'signal_scheduled')
        OR ("platform_identity_provider_restart_requests"."status" = 'failed'
          AND "platform_identity_provider_restart_requests"."accepted_at" IS NOT NULL AND "platform_identity_provider_restart_requests"."signaled_at" IS NULL AND "platform_identity_provider_restart_requests"."failed_at" IS NOT NULL
          AND "platform_identity_provider_restart_requests"."result_category" IS NOT NULL)),
	CONSTRAINT "platform_identity_provider_restart_requests_time_check" CHECK ("platform_identity_provider_restart_requests"."expires_at" > "platform_identity_provider_restart_requests"."created_at"
        AND "platform_identity_provider_restart_requests"."expires_at" <= "platform_identity_provider_restart_requests"."created_at" + interval '10 minutes'
        AND ("platform_identity_provider_restart_requests"."accepted_at" IS NULL OR "platform_identity_provider_restart_requests"."accepted_at" >= "platform_identity_provider_restart_requests"."created_at")
        AND ("platform_identity_provider_restart_requests"."signaled_at" IS NULL OR "platform_identity_provider_restart_requests"."signaled_at" >= "platform_identity_provider_restart_requests"."accepted_at")
        AND ("platform_identity_provider_restart_requests"."failed_at" IS NULL OR "platform_identity_provider_restart_requests"."failed_at" >= "platform_identity_provider_restart_requests"."created_at"))
);
--> statement-breakpoint
ALTER TABLE "platform_identity_provider_restart_requests" DROP CONSTRAINT IF EXISTS "platform_identity_provider_restart_requests_target_instance_id_platform_identity_provider_instances_instance_id_fk";--> statement-breakpoint
ALTER TABLE "platform_identity_provider_restart_requests" ADD CONSTRAINT "platform_identity_provider_restart_requests_target_instance_id_platform_identity_provider_instances_instance_id_fk" FOREIGN KEY ("target_instance_id") REFERENCES "public"."platform_identity_provider_instances"("instance_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_identity_provider_instances_heartbeat_idx" ON "platform_identity_provider_instances" USING btree ("last_heartbeat");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_identity_provider_instances_revision_idx" ON "platform_identity_provider_instances" USING btree ("active_identity_revision","last_heartbeat");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_identity_provider_restart_requests_token_unique" ON "platform_identity_provider_restart_requests" USING btree ("intent_token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_identity_provider_restart_requests_instance_status_idx" ON "platform_identity_provider_restart_requests" USING btree ("target_instance_id","status","created_at");

--> statement-breakpoint

-- Historical 0131_m11_user_dingtalk_claims
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "dingtalk_title" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "dingtalk_user_id" text;

--> statement-breakpoint

-- Historical 0132_m13_platform_secret_rotation
ALTER TABLE "platform_ai_provider_secrets" ADD COLUMN IF NOT EXISTS "key_id" varchar(256);--> statement-breakpoint
ALTER TABLE "platform_ai_providers" ADD COLUMN IF NOT EXISTS "secret_key_id" varchar(256);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_ai_provider_secrets_key_id_idx" ON "platform_ai_provider_secrets" USING btree ("key_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_ai_providers_secret_key_id_idx" ON "platform_ai_providers" USING btree ("secret_key_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_identity_provider_test_attempts_pkce_key_id_idx" ON "platform_identity_provider_test_attempts" USING btree ("pkce_key_id");

--> statement-breakpoint

-- Historical 0133_m13_secret_rewrap_failure_index
CREATE INDEX IF NOT EXISTS "platform_jobs_secret_rewrap_failure_parent_domain_row_idx" ON "platform_jobs" USING btree (("input"->>'parentJobId'),("input"->>'domain'),("input"->>'rowId')) WHERE "platform_jobs"."type" = 'platform.secret.rewrap.failure.v1' AND "platform_jobs"."status" = 'failed';

--> statement-breakpoint

-- Historical 0134_m13_secret_rewrap_single_active
CREATE UNIQUE INDEX IF NOT EXISTS "platform_jobs_secret_rewrap_single_active_unique" ON "platform_jobs" USING btree ("type") WHERE "platform_jobs"."type" = 'platform.secret.rewrap.v1' AND "platform_jobs"."status" IN ('pending', 'reserved', 'running');

--> statement-breakpoint

-- Historical 0135_m14_platform_instance_revisions
CREATE TABLE IF NOT EXISTS "platform_instance_heartbeats" (
	"instance_id" varchar(64) PRIMARY KEY NOT NULL,
	"last_heartbeat_at" timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
	"started_at" timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
	CONSTRAINT "platform_instance_heartbeats_id_check" CHECK ("platform_instance_heartbeats"."instance_id" ~ '^pinst_[a-f0-9]{48}$'),
	CONSTRAINT "platform_instance_heartbeats_time_check" CHECK ("platform_instance_heartbeats"."last_heartbeat_at" >= "platform_instance_heartbeats"."started_at")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_instance_revision_states" (
	"domain" varchar(32) NOT NULL,
	"instance_id" varchar(64) NOT NULL,
	"error_category" varchar(64),
	"health" varchar(32) DEFAULT 'unavailable' NOT NULL,
	"load_mode" varchar(32) DEFAULT 'request_scoped' NOT NULL,
	"loaded_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"loaded_revision" integer,
	"loaded_revision_id" varchar(128),
	"source" varchar(32) DEFAULT 'unavailable' NOT NULL,
	CONSTRAINT "platform_instance_revision_states_pkey" PRIMARY KEY("instance_id","domain"),
	CONSTRAINT "platform_instance_revision_states_domain_check" CHECK ("platform_instance_revision_states"."domain" IN ('agent_catalog', 'ai_catalog', 'branding', 'connector_catalog', 'identity', 'managed_policy', 'settings', 'skill_catalog')),
	CONSTRAINT "platform_instance_revision_states_load_mode_check" CHECK ("platform_instance_revision_states"."load_mode" IN ('process_cached', 'request_scoped', 'restart_activated')),
	CONSTRAINT "platform_instance_revision_states_source_check" CHECK ("platform_instance_revision_states"."source" IN ('cache', 'database', 'environment', 'lkg', 'unavailable')),
	CONSTRAINT "platform_instance_revision_states_health_check" CHECK ("platform_instance_revision_states"."health" IN ('degraded', 'healthy', 'unavailable')),
	CONSTRAINT "platform_instance_revision_states_error_check" CHECK ("platform_instance_revision_states"."error_category" IS NULL OR "platform_instance_revision_states"."error_category" IN ('cache_unavailable', 'configuration_invalid', 'database_unavailable', 'lkg_invalid', 'lkg_unavailable', 'load_failed', 'secret_unavailable', 'startup_unavailable')),
	CONSTRAINT "platform_instance_revision_states_outcome_check" CHECK (("platform_instance_revision_states"."health" = 'healthy' AND "platform_instance_revision_states"."source" <> 'unavailable' AND "platform_instance_revision_states"."error_category" IS NULL)
        OR ("platform_instance_revision_states"."health" = 'degraded' AND "platform_instance_revision_states"."source" <> 'unavailable' AND "platform_instance_revision_states"."error_category" IS NOT NULL)
        OR ("platform_instance_revision_states"."health" = 'unavailable' AND "platform_instance_revision_states"."source" = 'unavailable'
          AND "platform_instance_revision_states"."error_category" IS NOT NULL
          AND "platform_instance_revision_states"."loaded_revision" IS NULL AND "platform_instance_revision_states"."loaded_revision_id" IS NULL)),
	CONSTRAINT "platform_instance_revision_states_revision_check" CHECK (("platform_instance_revision_states"."loaded_revision" IS NULL OR "platform_instance_revision_states"."loaded_revision" >= 0)
        AND ("platform_instance_revision_states"."loaded_revision_id" IS NULL OR "platform_instance_revision_states"."loaded_revision_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')),
	CONSTRAINT "platform_instance_revision_states_loaded_identity_check" CHECK ("platform_instance_revision_states"."health" = 'unavailable' OR "platform_instance_revision_states"."load_mode" = 'request_scoped'
        OR "platform_instance_revision_states"."loaded_revision" IS NOT NULL OR "platform_instance_revision_states"."loaded_revision_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "platform_instance_revision_states" DROP CONSTRAINT IF EXISTS "platform_instance_revision_states_instance_id_platform_instance_heartbeats_instance_id_fk";--> statement-breakpoint
ALTER TABLE "platform_instance_revision_states" ADD CONSTRAINT "platform_instance_revision_states_instance_id_platform_instance_heartbeats_instance_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."platform_instance_heartbeats"("instance_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_instance_heartbeats_freshness_idx" ON "platform_instance_heartbeats" USING btree ("last_heartbeat_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_instance_revision_states_domain_loaded_idx" ON "platform_instance_revision_states" USING btree ("domain","loaded_at");

--> statement-breakpoint

-- Historical 0136_m11_identity_secret_state_null_guard
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

--> statement-breakpoint

-- Historical 0137_m13_admin_mutation_rate_windows
-- 0137: Multi-instance administrative mutation rate windows (PostgreSQL sole authority).
-- scope_digest is a SHA-256 hex of actor+procedure; raw identifiers never persist.
-- window_ms is the authoritative active-window duration (replica config adopts only on rollover).
CREATE TABLE IF NOT EXISTS "platform_admin_mutation_rate_windows" (
	"scope_digest" text PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_ms" integer NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_admin_mutation_rate_windows_window_start_idx" ON "platform_admin_mutation_rate_windows" USING btree ("window_start");

--> statement-breakpoint

-- Historical 0138_w10_platform_global_credentials
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

--> statement-breakpoint

-- Historical 0139_platform_connector_governance
CREATE TABLE IF NOT EXISTS "platform_connector_governance" (
	"id" text PRIMARY KEY NOT NULL,
	"resource" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_connector_governance_resource_unique" ON "platform_connector_governance" USING btree ("resource");

--> statement-breakpoint

-- Historical 0140_platform_agent_version_delete_guard
-- Custom SQL migration file, put your code below! --

-- Relax the platform_agent_versions immutability trigger to permit DELETE **only** inside a
-- transaction that explicitly opts in via a transaction-local GUC. This is the escape hatch used
-- by the admin "hard delete agent" path (admin.agents.delete): the FK graph around a platform
-- agent is a circular RESTRICT (agents.current_version_id ↔ agent_versions.agent_id), so the
-- version rows must be deletable to remove the agent — but only under the guarded delete flow.
-- UPDATE stays fully immutable; a DELETE without the opt-in GUC is still rejected.
CREATE OR REPLACE FUNCTION "prevent_platform_agent_version_mutation"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('lobe.allow_platform_agent_version_delete', true) = 'on'
  THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'platform_agent_versions are immutable' USING ERRCODE = '55000';
END;
$$;

--> statement-breakpoint

-- Compatibility convergence: the historical 2.2.10 chain and the squashed
-- fresh-install baseline must finish with the same PostgreSQL catalog.

-- Historical global_files.creator was nullable. Recover ownership from durable
-- references first, discard only truly unreferenced orphan blobs, and fail
-- closed if an owned row still cannot be attributed.
UPDATE "global_files" AS global_file
SET "creator" = owner."user_id"
FROM (
  SELECT "file_hash" AS "hash_id", min("user_id") AS "user_id"
  FROM "files"
  WHERE "file_hash" IS NOT NULL
  GROUP BY "file_hash"
) AS owner
WHERE global_file."creator" IS NULL
  AND global_file."hash_id" = owner."hash_id";
--> statement-breakpoint
UPDATE "global_files" AS global_file
SET "creator" = owner."user_id"
FROM (
  SELECT "zip_file_hash" AS "hash_id", min("user_id") AS "user_id"
  FROM "agent_skills"
  WHERE "zip_file_hash" IS NOT NULL
  GROUP BY "zip_file_hash"
) AS owner
WHERE global_file."creator" IS NULL
  AND global_file."hash_id" = owner."hash_id";
--> statement-breakpoint
DELETE FROM "global_files" AS global_file
WHERE global_file."creator" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "files" AS file WHERE file."file_hash" = global_file."hash_id"
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "agent_skills" AS skill
    WHERE skill."zip_file_hash" = global_file."hash_id"
  );
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "global_files" WHERE "creator" IS NULL) THEN
    RAISE EXCEPTION 'MIGRATION_GLOBAL_FILE_OWNER_UNRESOLVED';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "global_files" ALTER COLUMN "creator" SET NOT NULL;
--> statement-breakpoint

-- Normalize only legacy rows that cannot satisfy the connector contract. New
-- writes have been protected since the NOT VALID constraints were installed.
UPDATE "platform_connector_tools"
SET "platform_policy" = 'deny'
WHERE "platform_policy" NOT IN ('allow', 'deny');
--> statement-breakpoint
UPDATE "platform_connector_tools"
SET "risk_level" = 'high',
    "requires_confirmation" = true
WHERE "risk_level" NOT IN ('low', 'medium', 'high', 'critical');
--> statement-breakpoint
UPDATE "platform_connector_tools"
SET "input_schema" = '{}'::jsonb
WHERE jsonb_typeof("input_schema") IS DISTINCT FROM 'object'
   OR octet_length("input_schema"::text) > 65536;
--> statement-breakpoint
UPDATE "platform_connector_tools"
SET "output_schema" = '{}'::jsonb
WHERE jsonb_typeof("output_schema") IS DISTINCT FROM 'object'
   OR octet_length("output_schema"::text) > 65536;
--> statement-breakpoint
UPDATE "platform_connector_tools"
SET "requires_confirmation" = true
WHERE "risk_level" IN ('high', 'critical')
  AND NOT "requires_confirmation";
--> statement-breakpoint

UPDATE "platform_connectors"
SET "revision" = greatest("revision", 0),
    "published_resource_type" = 'connector'
WHERE "revision" < 0 OR "published_resource_type" <> 'connector';
--> statement-breakpoint
UPDATE "platform_connectors"
SET "migration_required" = true,
    "shared_secret_ref" = NULL,
    "shared_secret_fingerprint" = NULL,
    "shared_secret_updated_at" = NULL
WHERE "shared_secret_ref" IS NOT NULL
  AND "shared_secret_ref" NOT LIKE 'vault://%'
  AND "shared_secret_ref" NOT LIKE 'kms://%';
--> statement-breakpoint
UPDATE "platform_connectors"
SET "migration_required" = true,
    "oauth_client_secret_ref" = NULL,
    "oauth_client_secret_fingerprint" = NULL,
    "oauth_client_secret_updated_at" = NULL
WHERE "oauth_client_secret_ref" IS NOT NULL
  AND "oauth_client_secret_ref" NOT LIKE 'vault://%'
  AND "oauth_client_secret_ref" NOT LIKE 'kms://%';
--> statement-breakpoint
UPDATE "platform_connectors"
SET "migration_required" = true,
    "oauth_config" = NULL
WHERE "oauth_config" IS NOT NULL
  AND (
    jsonb_typeof("oauth_config") IS DISTINCT FROM 'object'
    OR octet_length("oauth_config"::text) > 16384
    OR "oauth_config"::text ~* '"(client_?secret|secret|access_?token|refresh_?token|token|password|authorization)"[[:space:]]*:'
  );
--> statement-breakpoint
UPDATE "platform_connectors" AS connector
SET "migration_required" = true,
    "status" = 'draft',
    "published_revision" = NULL,
    "published_checksum" = NULL,
    "published_at" = NULL
WHERE connector."published_revision" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "platform_resource_revisions" AS revision
    WHERE revision."resource_type" = connector."published_resource_type"
      AND revision."resource_id" = connector."id"
      AND revision."revision" = connector."published_revision"
      AND revision."checksum" = connector."published_checksum"
  );
--> statement-breakpoint

-- Orphan bindings cannot have a valid owner and may contain credential
-- references, so remove the unusable binding rather than reassigning it.
DELETE FROM "platform_user_connector_bindings" AS binding
WHERE NOT EXISTS (
  SELECT 1 FROM "users" AS owner WHERE owner."id" = binding."user_id"
);
--> statement-breakpoint
UPDATE "platform_user_connector_bindings" AS binding
SET "published_revision" = NULL,
    "binding_status" = 'disconnected',
    "oauth_token_ref" = NULL,
    "token_fingerprint" = NULL,
    "scopes" = ARRAY[]::varchar[],
    "connected_at" = NULL,
    "revoked_at" = NULL,
    "last_error_category" = 'revision_missing'
WHERE binding."published_revision" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "platform_resource_revisions" AS revision
    WHERE revision."resource_type" = binding."revision_resource_type"
      AND revision."resource_id" = binding."connector_id"
      AND revision."revision" = binding."published_revision"
  );
--> statement-breakpoint

ALTER TABLE "platform_connectors" VALIDATE CONSTRAINT "platform_connectors_published_revision_fk";
--> statement-breakpoint
ALTER TABLE "platform_user_connector_bindings" VALIDATE CONSTRAINT "platform_user_connector_bindings_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "platform_user_connector_bindings" VALIDATE CONSTRAINT "platform_user_connector_bindings_revision_fk";
--> statement-breakpoint
ALTER TABLE "platform_connector_tools" VALIDATE CONSTRAINT "platform_connector_tools_policy_check";
--> statement-breakpoint
ALTER TABLE "platform_connector_tools" VALIDATE CONSTRAINT "platform_connector_tools_risk_check";
--> statement-breakpoint
ALTER TABLE "platform_connector_tools" VALIDATE CONSTRAINT "platform_connector_tools_schema_check";
--> statement-breakpoint
ALTER TABLE "platform_connector_tools" VALIDATE CONSTRAINT "platform_connector_tools_confirmation_check";
--> statement-breakpoint
ALTER TABLE "platform_connectors" VALIDATE CONSTRAINT "platform_connectors_transport_http_check";
--> statement-breakpoint
ALTER TABLE "platform_connectors" VALIDATE CONSTRAINT "platform_connectors_credential_mode_check";
--> statement-breakpoint
ALTER TABLE "platform_connectors" VALIDATE CONSTRAINT "platform_connectors_credential_slot_check";
--> statement-breakpoint
ALTER TABLE "platform_connectors" VALIDATE CONSTRAINT "platform_connectors_published_pointer_check";
--> statement-breakpoint
ALTER TABLE "platform_connectors" VALIDATE CONSTRAINT "platform_connectors_revision_check";
--> statement-breakpoint
ALTER TABLE "platform_connectors" VALIDATE CONSTRAINT "platform_connectors_secret_ref_check";
--> statement-breakpoint
ALTER TABLE "platform_connectors" VALIDATE CONSTRAINT "platform_connectors_oauth_config_check";
--> statement-breakpoint
ALTER TABLE "platform_connectors" VALIDATE CONSTRAINT "platform_connectors_published_shared_secret_check";
--> statement-breakpoint
ALTER TABLE "platform_user_connector_bindings" VALIDATE CONSTRAINT "platform_user_connector_bindings_status_check";
--> statement-breakpoint
ALTER TABLE "platform_user_connector_bindings" VALIDATE CONSTRAINT "platform_user_connector_bindings_revision_check";
--> statement-breakpoint
ALTER TABLE "platform_user_connector_bindings" VALIDATE CONSTRAINT "platform_user_connector_bindings_token_ref_check";
--> statement-breakpoint
ALTER TABLE "platform_user_connector_bindings" VALIDATE CONSTRAINT "platform_user_connector_bindings_state_fields_check";
--> statement-breakpoint
ALTER TABLE "platform_user_connector_bindings" VALIDATE CONSTRAINT "platform_user_connector_bindings_revoked_check";
--> statement-breakpoint
ALTER TABLE "platform_user_connector_bindings" VALIDATE CONSTRAINT "platform_user_connector_bindings_token_ref_format_check";
--> statement-breakpoint

-- Drizzle's historical rename left catalog object names behind. Recreate the
-- join-table key/FKs under their final messages_files names.
ALTER TABLE "messages_files" DROP CONSTRAINT IF EXISTS "files_to_messages_file_id_message_id_pk";
--> statement-breakpoint
ALTER TABLE "messages_files" DROP CONSTRAINT IF EXISTS "messages_files_file_id_message_id_pk";
--> statement-breakpoint
ALTER TABLE "messages_files" ADD CONSTRAINT "messages_files_file_id_message_id_pk" PRIMARY KEY ("file_id", "message_id");
--> statement-breakpoint
ALTER TABLE "messages_files" DROP CONSTRAINT IF EXISTS "files_to_messages_file_id_files_id_fk";
--> statement-breakpoint
ALTER TABLE "messages_files" DROP CONSTRAINT IF EXISTS "files_to_messages_message_id_messages_id_fk";
--> statement-breakpoint
ALTER TABLE "messages_files" DROP CONSTRAINT IF EXISTS "files_to_messages_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "messages_files" DROP CONSTRAINT IF EXISTS "files_to_messages_workspace_id_workspaces_id_fk";
--> statement-breakpoint
ALTER TABLE "messages_files" DROP CONSTRAINT IF EXISTS "messages_files_file_id_files_id_fk";
--> statement-breakpoint
ALTER TABLE "messages_files" DROP CONSTRAINT IF EXISTS "messages_files_message_id_messages_id_fk";
--> statement-breakpoint
ALTER TABLE "messages_files" DROP CONSTRAINT IF EXISTS "messages_files_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "messages_files" DROP CONSTRAINT IF EXISTS "messages_files_workspace_id_workspaces_id_fk";
--> statement-breakpoint
ALTER TABLE "messages_files" ADD CONSTRAINT "messages_files_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "messages_files" ADD CONSTRAINT "messages_files_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "messages_files" ADD CONSTRAINT "messages_files_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "messages_files" ADD CONSTRAINT "messages_files_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

-- The historical custom nanoid helper emitted redundant UNIQUE(id)
-- constraints on columns that already have primary keys.
ALTER TABLE "rag_eval_dataset_records" DROP CONSTRAINT IF EXISTS "rag_eval_dataset_records_dataset_id_rag_eval_datasets_id_fk";
--> statement-breakpoint
ALTER TABLE "rag_eval_evaluations" DROP CONSTRAINT IF EXISTS "rag_eval_evaluations_dataset_id_rag_eval_datasets_id_fk";
--> statement-breakpoint
ALTER TABLE "rag_eval_evaluation_records" DROP CONSTRAINT IF EXISTS "rag_eval_evaluation_records_dataset_record_id_rag_eval_dataset_";
--> statement-breakpoint
ALTER TABLE "rag_eval_evaluation_records" DROP CONSTRAINT IF EXISTS "rag_eval_evaluation_records_evaluation_id_rag_eval_evaluations_";
--> statement-breakpoint
ALTER TABLE "rbac_role_permissions" DROP CONSTRAINT IF EXISTS "rbac_role_permissions_role_id_rbac_roles_id_fk";
--> statement-breakpoint
ALTER TABLE "rbac_role_permissions" DROP CONSTRAINT IF EXISTS "rbac_role_permissions_permission_id_rbac_permissions_id_fk";
--> statement-breakpoint
ALTER TABLE "rbac_user_roles" DROP CONSTRAINT IF EXISTS "rbac_user_roles_role_id_rbac_roles_id_fk";
--> statement-breakpoint
ALTER TABLE "api_keys" DROP CONSTRAINT IF EXISTS "api_keys_id_nanoid_unique";
--> statement-breakpoint
ALTER TABLE "rag_eval_dataset_records" DROP CONSTRAINT IF EXISTS "rag_eval_dataset_records_id_nanoid_unique";
--> statement-breakpoint
ALTER TABLE "rag_eval_datasets" DROP CONSTRAINT IF EXISTS "rag_eval_datasets_id_nanoid_unique";
--> statement-breakpoint
ALTER TABLE "rag_eval_evaluation_records" DROP CONSTRAINT IF EXISTS "rag_eval_evaluation_records_id_nanoid_unique";
--> statement-breakpoint
ALTER TABLE "rag_eval_evaluations" DROP CONSTRAINT IF EXISTS "rag_eval_evaluations_id_nanoid_unique";
--> statement-breakpoint
ALTER TABLE "rbac_permissions" DROP CONSTRAINT IF EXISTS "rbac_permissions_id_nanoid_unique";
--> statement-breakpoint
ALTER TABLE "rbac_roles" DROP CONSTRAINT IF EXISTS "rbac_roles_id_nanoid_unique";
--> statement-breakpoint

ALTER TABLE "rag_eval_dataset_records"
  ADD CONSTRAINT "rag_eval_dataset_records_dataset_id_rag_eval_datasets_id_fk"
  FOREIGN KEY ("dataset_id") REFERENCES "public"."rag_eval_datasets"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rag_eval_evaluations"
  ADD CONSTRAINT "rag_eval_evaluations_dataset_id_rag_eval_datasets_id_fk"
  FOREIGN KEY ("dataset_id") REFERENCES "public"."rag_eval_datasets"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rag_eval_evaluation_records"
  ADD CONSTRAINT "rag_eval_evaluation_records_dataset_record_id_rag_eval_dataset_"
  FOREIGN KEY ("dataset_record_id") REFERENCES "public"."rag_eval_dataset_records"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rag_eval_evaluation_records"
  ADD CONSTRAINT "rag_eval_evaluation_records_evaluation_id_rag_eval_evaluations_"
  FOREIGN KEY ("evaluation_id") REFERENCES "public"."rag_eval_evaluations"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rbac_role_permissions"
  ADD CONSTRAINT "rbac_role_permissions_role_id_rbac_roles_id_fk"
  FOREIGN KEY ("role_id") REFERENCES "public"."rbac_roles"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rbac_role_permissions"
  ADD CONSTRAINT "rbac_role_permissions_permission_id_rbac_permissions_id_fk"
  FOREIGN KEY ("permission_id") REFERENCES "public"."rbac_permissions"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rbac_user_roles"
  ADD CONSTRAINT "rbac_user_roles_role_id_rbac_roles_id_fk"
  FOREIGN KEY ("role_id") REFERENCES "public"."rbac_roles"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

DROP INDEX IF EXISTS "users_normalized_email_unique_idx";
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.users'::regclass
      AND conname = 'users_normalized_email_unique'
  ) THEN
    ALTER TABLE "users"
      ADD CONSTRAINT "users_normalized_email_unique" UNIQUE ("normalized_email");
  END IF;
END $$;
--> statement-breakpoint

-- Historical 0141_platform_audit_admin_foundation
CREATE TABLE IF NOT EXISTS "platform_audit_exports" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" varchar(32) NOT NULL,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"filter_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"job_id" text,
	"includes_message_bodies" boolean DEFAULT false NOT NULL,
	"artifact_checksum" text,
	"storage_key" text,
	"artifact_bytes" bigint,
	"row_count" integer,
	"expires_at" timestamp with time zone,
	"error" jsonb,
	"requested_by" text NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_audit_exports_kind_check" CHECK ("platform_audit_exports"."kind" IN ('operation_logs', 'conversations', 'user_timeline')),
	CONSTRAINT "platform_audit_exports_status_check" CHECK ("platform_audit_exports"."status" IN ('pending', 'running', 'completed', 'failed', 'cancelled', 'expired')),
	CONSTRAINT "platform_audit_exports_row_count_check" CHECK ("platform_audit_exports"."row_count" IS NULL OR "platform_audit_exports"."row_count" >= 0),
	CONSTRAINT "platform_audit_exports_artifact_bytes_check" CHECK ("platform_audit_exports"."artifact_bytes" IS NULL OR "platform_audit_exports"."artifact_bytes" >= 0),
	CONSTRAINT "platform_audit_exports_completed_artifact_check" CHECK ("platform_audit_exports"."status" <> 'completed' OR (
        "platform_audit_exports"."storage_key" IS NOT NULL
        AND "platform_audit_exports"."artifact_checksum" IS NOT NULL
        AND "platform_audit_exports"."expires_at" IS NOT NULL
      ))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_audit_legal_holds" (
	"id" text PRIMARY KEY NOT NULL,
	"scope_type" varchar(32) NOT NULL,
	"scope_id" text,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"reason" text NOT NULL,
	"created_by" text NOT NULL,
	"released_by" text,
	"release_reason" text,
	"released_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_audit_legal_holds_scope_type_check" CHECK ("platform_audit_legal_holds"."scope_type" IN ('user', 'session', 'topic', 'workspace', 'global')),
	CONSTRAINT "platform_audit_legal_holds_status_check" CHECK ("platform_audit_legal_holds"."status" IN ('active', 'released')),
	CONSTRAINT "platform_audit_legal_holds_scope_id_shape_check" CHECK (("platform_audit_legal_holds"."scope_type" = 'global' AND "platform_audit_legal_holds"."scope_id" IS NULL)
        OR ("platform_audit_legal_holds"."scope_type" <> 'global' AND "platform_audit_legal_holds"."scope_id" IS NOT NULL)),
	CONSTRAINT "platform_audit_legal_holds_release_shape_check" CHECK ("platform_audit_legal_holds"."status" <> 'released' OR (
        "platform_audit_legal_holds"."released_by" IS NOT NULL
        AND "platform_audit_legal_holds"."release_reason" IS NOT NULL
        AND btrim("platform_audit_legal_holds"."release_reason") <> ''
        AND "platform_audit_legal_holds"."released_at" IS NOT NULL
      ))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_audit_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"operation_log_retention_days" integer DEFAULT 365 NOT NULL,
	"conversation_retention_days" integer DEFAULT 180 NOT NULL,
	"export_artifact_retention_days" integer DEFAULT 7 NOT NULL,
	"content_access_mode" varchar(32) DEFAULT 'metadata_only' NOT NULL,
	"message_body_in_export" boolean DEFAULT false NOT NULL,
	"max_export_rows" integer DEFAULT 50000 NOT NULL,
	"max_list_window_days" integer DEFAULT 90 NOT NULL,
	"redaction_profile" varchar(32) DEFAULT 'strict' NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_audit_policies_revision_check" CHECK ("platform_audit_policies"."revision" >= 0),
	CONSTRAINT "platform_audit_policies_operation_log_retention_days_check" CHECK ("platform_audit_policies"."operation_log_retention_days" >= 1 AND "platform_audit_policies"."operation_log_retention_days" <= 3650),
	CONSTRAINT "platform_audit_policies_conversation_retention_days_check" CHECK ("platform_audit_policies"."conversation_retention_days" >= 1 AND "platform_audit_policies"."conversation_retention_days" <= 3650),
	CONSTRAINT "platform_audit_policies_export_artifact_retention_days_check" CHECK ("platform_audit_policies"."export_artifact_retention_days" >= 1 AND "platform_audit_policies"."export_artifact_retention_days" <= 365),
	CONSTRAINT "platform_audit_policies_max_export_rows_check" CHECK ("platform_audit_policies"."max_export_rows" >= 1 AND "platform_audit_policies"."max_export_rows" <= 1000000),
	CONSTRAINT "platform_audit_policies_max_list_window_days_check" CHECK ("platform_audit_policies"."max_list_window_days" >= 1 AND "platform_audit_policies"."max_list_window_days" <= 365),
	CONSTRAINT "platform_audit_policies_content_access_mode_check" CHECK ("platform_audit_policies"."content_access_mode" IN ('disabled', 'metadata_only', 'content_allowed')),
	CONSTRAINT "platform_audit_policies_redaction_profile_check" CHECK ("platform_audit_policies"."redaction_profile" IN ('strict', 'standard'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_audit_retention_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"mode" varchar(16) NOT NULL,
	"scope" varchar(32) NOT NULL,
	"cutoff_at" timestamp with time zone NOT NULL,
	"policy_revision" integer NOT NULL,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"progress_done" integer DEFAULT 0 NOT NULL,
	"progress_total" integer,
	"job_id" text,
	"error" jsonb,
	"requested_by" text NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_audit_retention_runs_mode_check" CHECK ("platform_audit_retention_runs"."mode" IN ('dry_run', 'execute')),
	CONSTRAINT "platform_audit_retention_runs_scope_check" CHECK ("platform_audit_retention_runs"."scope" IN ('operation_logs', 'conversations', 'export_artifacts')),
	CONSTRAINT "platform_audit_retention_runs_status_check" CHECK ("platform_audit_retention_runs"."status" IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "platform_audit_retention_runs_policy_revision_check" CHECK ("platform_audit_retention_runs"."policy_revision" >= 0),
	CONSTRAINT "platform_audit_retention_runs_progress_done_check" CHECK ("platform_audit_retention_runs"."progress_done" >= 0),
	CONSTRAINT "platform_audit_retention_runs_progress_total_check" CHECK ("platform_audit_retention_runs"."progress_total" IS NULL OR "platform_audit_retention_runs"."progress_total" >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_audit_exports_status_created_at_idx" ON "platform_audit_exports" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_audit_exports_kind_created_at_idx" ON "platform_audit_exports" USING btree ("kind","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_audit_exports_requested_by_idx" ON "platform_audit_exports" USING btree ("requested_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_audit_exports_expires_at_idx" ON "platform_audit_exports" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_audit_exports_job_id_unique" ON "platform_audit_exports" USING btree ("job_id") WHERE "platform_audit_exports"."job_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_audit_legal_holds_status_scope_idx" ON "platform_audit_legal_holds" USING btree ("status","scope_type","scope_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_audit_legal_holds_scope_idx" ON "platform_audit_legal_holds" USING btree ("scope_type","scope_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_audit_legal_holds_created_by_idx" ON "platform_audit_legal_holds" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_audit_legal_holds_expires_at_idx" ON "platform_audit_legal_holds" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_audit_legal_holds_active_global_unique" ON "platform_audit_legal_holds" USING btree ("scope_type") WHERE "platform_audit_legal_holds"."status" = 'active' AND "platform_audit_legal_holds"."scope_type" = 'global';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_audit_legal_holds_active_scope_unique" ON "platform_audit_legal_holds" USING btree ("scope_type","scope_id") WHERE "platform_audit_legal_holds"."status" = 'active' AND "platform_audit_legal_holds"."scope_type" <> 'global';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_audit_retention_runs_status_created_at_idx" ON "platform_audit_retention_runs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_audit_retention_runs_scope_created_at_idx" ON "platform_audit_retention_runs" USING btree ("scope","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_audit_retention_runs_requested_by_idx" ON "platform_audit_retention_runs" USING btree ("requested_by");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_audit_retention_runs_job_id_unique" ON "platform_audit_retention_runs" USING btree ("job_id") WHERE "platform_audit_retention_runs"."job_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_audit_logs_actor_created_at_id_idx" ON "platform_audit_logs" USING btree ("actor_user_id","created_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_audit_logs_action_created_at_id_idx" ON "platform_audit_logs" USING btree ("action","created_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_audit_logs_result_created_at_id_idx" ON "platform_audit_logs" USING btree ("result","created_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_audit_logs_created_at_id_idx" ON "platform_audit_logs" USING btree ("created_at","id");

--> statement-breakpoint

-- Historical 0142_platform_auth_settings
-- Custom SQL migration file, put your code below! --

-- M15: platform authentication / registration settings (single logical row, id='global').
-- Admin-managed open-registration toggle + email-domain allowlist. Non-secret; read at
-- request time by the sign-up guard and projected into the anonymous public snapshot.
CREATE TABLE IF NOT EXISTS "platform_auth_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"email_domain_allowlist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"email_domain_allowlist_enabled" boolean DEFAULT false NOT NULL,
	"open_registration" boolean DEFAULT true NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint

-- Historical 0143_platform_sidebar_layout
-- Custom SQL migration file, put your code below! --

-- M15: platform home-sidebar layout policy (single logical row, id='global').
-- mode = 'user' (each user customizes) or 'platform' (centrally managed); layout holds
-- the platform-managed layout JSON (null until an admin configures it). Non-secret.
CREATE TABLE IF NOT EXISTS "platform_sidebar_layout" (
	"id" text PRIMARY KEY NOT NULL,
	"layout" jsonb,
	"mode" text DEFAULT 'user' NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint

-- Historical 0144_drop_platform_easyauth_snapshots
DROP TABLE IF EXISTS "platform_easyauth_grant_snapshots";

--> statement-breakpoint

-- Historical 0145_platform_db_hardening
-- Custom SQL migration: platform DB hardening (immutability, credential ownership,
-- settings FK cascade, audit conversation / usage indexes).
-- Idempotent / convergent so partial re-applies are safe.

-- ── 1. Immutable revisions + append-only audit logs ─────────────────────────

CREATE OR REPLACE FUNCTION "prevent_platform_resource_revision_mutation"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'platform_resource_revisions are immutable' USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "platform_resource_revisions_immutable" ON "platform_resource_revisions";
--> statement-breakpoint
CREATE TRIGGER "platform_resource_revisions_immutable"
BEFORE UPDATE OR DELETE ON "platform_resource_revisions"
FOR EACH ROW EXECUTE FUNCTION "prevent_platform_resource_revision_mutation"();
--> statement-breakpoint

-- Audit logs: reject UPDATE always; allow DELETE only when the retention TX
-- opts in via transaction-local GUC lobe.allow_platform_audit_log_delete=on.
CREATE OR REPLACE FUNCTION "prevent_platform_audit_log_mutation"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('lobe.allow_platform_audit_log_delete', true) = 'on'
  THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'platform_audit_logs are append-only' USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "platform_audit_logs_append_only" ON "platform_audit_logs";
--> statement-breakpoint
CREATE TRIGGER "platform_audit_logs_append_only"
BEFORE UPDATE OR DELETE ON "platform_audit_logs"
FOR EACH ROW EXECUTE FUNCTION "prevent_platform_audit_log_mutation"();
--> statement-breakpoint

-- ── 2. Credential staged uploads: opaque id PK + required owner ─────────────

-- Drop anonymous/orphan staging (short TTL; safe to discard).
DELETE FROM "platform_global_credential_uploads" WHERE "created_by" IS NULL OR btrim("created_by") = '';
--> statement-breakpoint

ALTER TABLE "platform_global_credential_uploads" ADD COLUMN IF NOT EXISTS "id" text;
--> statement-breakpoint
UPDATE "platform_global_credential_uploads"
SET "id" = 'pgcu_' || substr(md5(random()::text || "file_hash_id" || coalesce("created_by", '')), 1, 16)
WHERE "id" IS NULL;
--> statement-breakpoint
ALTER TABLE "platform_global_credential_uploads" ALTER COLUMN "id" SET NOT NULL;
--> statement-breakpoint

-- Swap primary key from content hash → opaque upload id.
ALTER TABLE "platform_global_credential_uploads" DROP CONSTRAINT IF EXISTS "platform_global_credential_uploads_pkey";
--> statement-breakpoint
ALTER TABLE "platform_global_credential_uploads" ADD PRIMARY KEY ("id");
--> statement-breakpoint

ALTER TABLE "platform_global_credential_uploads" ALTER COLUMN "created_by" SET NOT NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "platform_global_credential_uploads_owner_hash_unique"
  ON "platform_global_credential_uploads" USING btree ("created_by", "file_hash_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_global_credential_uploads_created_by_idx"
  ON "platform_global_credential_uploads" USING btree ("created_by");
--> statement-breakpoint

-- Ensure file_hash_id format check exists (catalog-guarded).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'platform_global_credential_uploads_file_hash_id_check'
  ) THEN
    ALTER TABLE "platform_global_credential_uploads"
      ADD CONSTRAINT "platform_global_credential_uploads_file_hash_id_check"
      CHECK ("file_hash_id" ~ '^[a-f0-9]{64}$');
  END IF;
END $$;
--> statement-breakpoint

-- ── 3. User setting overrides cascade on hard user delete ───────────────────

-- Drop orphans that would block FK creation.
DELETE FROM "user_setting_overrides" uso
WHERE NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = uso.user_id);
--> statement-breakpoint
DELETE FROM "user_setting_override_revisions" usr
WHERE NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = usr.user_id);
--> statement-breakpoint

ALTER TABLE "user_setting_overrides"
  DROP CONSTRAINT IF EXISTS "user_setting_overrides_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "user_setting_overrides"
  ADD CONSTRAINT "user_setting_overrides_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "user_setting_override_revisions"
  DROP CONSTRAINT IF EXISTS "user_setting_override_revisions_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "user_setting_override_revisions"
  ADD CONSTRAINT "user_setting_override_revisions_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

-- ── 4. Audit conversation / global usage indexes ────────────────────────────

CREATE INDEX IF NOT EXISTS "topics_user_id_created_at_id_idx"
  ON "topics" USING btree ("user_id", "created_at", "id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_user_id_topic_id_created_at_id_idx"
  ON "messages" USING btree ("user_id", "topic_id", "created_at", "id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_role_created_at_idx"
  ON "messages" USING btree ("role", "created_at");
--> statement-breakpoint

-- Title ILIKE '%q%' for audit conversation search (optional where pg_trgm exists).
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE NOTICE 'pg_trgm unavailable; skipping topics_title_trgm_idx';
      RETURN;
  END;
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    CREATE INDEX IF NOT EXISTS "topics_title_trgm_idx"
      ON "topics" USING gin ("title" gin_trgm_ops);
  END IF;
END $$;

--> statement-breakpoint

-- Historical 0146_platform_agent_materialization_tombstones
-- Durable provenance for local Agents that were materializations of a hard-deleted platform Agent.
-- Live materialization rows cannot outlive their platform Agent (RESTRICT FKs), but surviving
-- local `agents` rows must stay excluded from ordinary lists and mutation guards.

CREATE TABLE IF NOT EXISTS "platform_user_agent_materialization_tombstones" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"materialized_agent_id" text NOT NULL,
	"former_platform_agent_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "platform_user_agent_materialization_tombstones" ADD CONSTRAINT "platform_user_agent_materialization_tombstones_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "platform_user_agent_materialization_tombstones" ADD CONSTRAINT "platform_user_agent_materialization_tombstones_materialized_agent_id_agents_id_fk" FOREIGN KEY ("materialized_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_user_agent_mat_tombstones_local_agent_unique" ON "platform_user_agent_materialization_tombstones" USING btree ("materialized_agent_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_user_agent_mat_tombstones_user_id_idx" ON "platform_user_agent_materialization_tombstones" USING btree ("user_id");

--> statement-breakpoint

-- Historical 0147_round2_identity
-- Round-2 identity partition: platform_auth_settings CAS revision + invariants.
-- Idempotent so partial re-applies are safe.

-- Monotonic CAS revision (default 0 for existing rows).
ALTER TABLE "platform_auth_settings" ADD COLUMN IF NOT EXISTS "revision" integer;
--> statement-breakpoint
UPDATE "platform_auth_settings" SET "revision" = 0 WHERE "revision" IS NULL;
--> statement-breakpoint
ALTER TABLE "platform_auth_settings" ALTER COLUMN "revision" SET DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "platform_auth_settings" ALTER COLUMN "revision" SET NOT NULL;
--> statement-breakpoint

-- Singleton guard: only id = 'global' is allowed.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'platform_auth_settings_id_singleton'
  ) THEN
    ALTER TABLE "platform_auth_settings"
      ADD CONSTRAINT "platform_auth_settings_id_singleton"
      CHECK ("id" = 'global');
  END IF;
END $$;
--> statement-breakpoint

-- Revision non-negative.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'platform_auth_settings_revision_check'
  ) THEN
    ALTER TABLE "platform_auth_settings"
      ADD CONSTRAINT "platform_auth_settings_revision_check"
      CHECK ("revision" >= 0);
  END IF;
END $$;
--> statement-breakpoint

-- Fail closed: allowlist enabled requires at least one domain entry.
-- Normalize any existing invalid rows before adding the constraint.
UPDATE "platform_auth_settings"
SET "email_domain_allowlist_enabled" = false
WHERE "email_domain_allowlist_enabled" = true
  AND jsonb_array_length(COALESCE("email_domain_allowlist", '[]'::jsonb)) = 0;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'platform_auth_settings_allowlist_nonempty_when_enabled'
  ) THEN
    ALTER TABLE "platform_auth_settings"
      ADD CONSTRAINT "platform_auth_settings_allowlist_nonempty_when_enabled"
      CHECK (
        (NOT "email_domain_allowlist_enabled")
        OR (jsonb_array_length("email_domain_allowlist") > 0)
      );
  END IF;
END $$;

--> statement-breakpoint

-- Historical 0148_round2_db-core
-- Round-2 db-core: online index path for high-write tables + sidebar policy invariants.
-- Idempotent / convergent so partial re-applies are safe.
--
-- ── Indexes (0141 / 0145 follow-up) ──────────────────────────────────────────
-- 0141 and 0145 created these indexes without CONCURRENTLY, which blocks writes on
-- large production tables for the duration of each build.
--
-- CREATE INDEX CONCURRENTLY cannot run inside drizzle-orm's transactional migrator
-- (see pg-core dialect.migrate). Production / large deployments MUST prebuild in
-- autocommit before (or instead of relying on) the transactional fallbacks below:
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "platform_audit_logs_actor_created_at_id_idx"
--     ON "platform_audit_logs" USING btree ("actor_user_id","created_at","id");
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "platform_audit_logs_action_created_at_id_idx"
--     ON "platform_audit_logs" USING btree ("action","created_at","id");
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "platform_audit_logs_result_created_at_id_idx"
--     ON "platform_audit_logs" USING btree ("result","created_at","id");
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "platform_audit_logs_created_at_id_idx"
--     ON "platform_audit_logs" USING btree ("created_at","id");
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "topics_user_id_created_at_id_idx"
--     ON "topics" USING btree ("user_id","created_at","id");
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "messages_user_id_topic_id_created_at_id_idx"
--     ON "messages" USING btree ("user_id","topic_id","created_at","id");
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "messages_role_created_at_idx"
--     ON "messages" USING btree ("role","created_at");
--   -- optional, requires pg_trgm:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "topics_title_trgm_idx"
--     ON "topics" USING gin ("title" gin_trgm_ops);
--
-- Transactional fallbacks: IF NOT EXISTS → no-op when predeploy (or 0141/0145)
-- already created the index. Do NOT DROP valid indexes here (would regress plans).
-- Large tables that still lack an index raise so ops can run the CONCURRENTLY form.

DO $$
DECLARE
  bounded_count integer;
BEGIN
  IF to_regclass('public.platform_audit_logs_actor_created_at_id_idx') IS NULL
     AND to_regclass('public.platform_audit_logs') IS NOT NULL THEN
    SELECT count(*) INTO bounded_count FROM (SELECT 1 FROM "platform_audit_logs" LIMIT 10001) rows;
    IF bounded_count > 10000
       AND coalesce(current_setting('aihub.db_core_index_predeploy', true), 'off') <> 'on' THEN
      RAISE EXCEPTION 'DB_CORE_PREDEPLOY_INDEX_REQUIRED:platform_audit_logs_actor_created_at_id_idx';
    END IF;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_audit_logs_actor_created_at_id_idx"
  ON "platform_audit_logs" USING btree ("actor_user_id","created_at","id");
--> statement-breakpoint

DO $$
DECLARE
  bounded_count integer;
BEGIN
  IF to_regclass('public.platform_audit_logs_action_created_at_id_idx') IS NULL
     AND to_regclass('public.platform_audit_logs') IS NOT NULL THEN
    SELECT count(*) INTO bounded_count FROM (SELECT 1 FROM "platform_audit_logs" LIMIT 10001) rows;
    IF bounded_count > 10000
       AND coalesce(current_setting('aihub.db_core_index_predeploy', true), 'off') <> 'on' THEN
      RAISE EXCEPTION 'DB_CORE_PREDEPLOY_INDEX_REQUIRED:platform_audit_logs_action_created_at_id_idx';
    END IF;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_audit_logs_action_created_at_id_idx"
  ON "platform_audit_logs" USING btree ("action","created_at","id");
--> statement-breakpoint

DO $$
DECLARE
  bounded_count integer;
BEGIN
  IF to_regclass('public.platform_audit_logs_result_created_at_id_idx') IS NULL
     AND to_regclass('public.platform_audit_logs') IS NOT NULL THEN
    SELECT count(*) INTO bounded_count FROM (SELECT 1 FROM "platform_audit_logs" LIMIT 10001) rows;
    IF bounded_count > 10000
       AND coalesce(current_setting('aihub.db_core_index_predeploy', true), 'off') <> 'on' THEN
      RAISE EXCEPTION 'DB_CORE_PREDEPLOY_INDEX_REQUIRED:platform_audit_logs_result_created_at_id_idx';
    END IF;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_audit_logs_result_created_at_id_idx"
  ON "platform_audit_logs" USING btree ("result","created_at","id");
--> statement-breakpoint

DO $$
DECLARE
  bounded_count integer;
BEGIN
  IF to_regclass('public.platform_audit_logs_created_at_id_idx') IS NULL
     AND to_regclass('public.platform_audit_logs') IS NOT NULL THEN
    SELECT count(*) INTO bounded_count FROM (SELECT 1 FROM "platform_audit_logs" LIMIT 10001) rows;
    IF bounded_count > 10000
       AND coalesce(current_setting('aihub.db_core_index_predeploy', true), 'off') <> 'on' THEN
      RAISE EXCEPTION 'DB_CORE_PREDEPLOY_INDEX_REQUIRED:platform_audit_logs_created_at_id_idx';
    END IF;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_audit_logs_created_at_id_idx"
  ON "platform_audit_logs" USING btree ("created_at","id");
--> statement-breakpoint

DO $$
DECLARE
  bounded_count integer;
BEGIN
  IF to_regclass('public.topics_user_id_created_at_id_idx') IS NULL
     AND to_regclass('public.topics') IS NOT NULL THEN
    SELECT count(*) INTO bounded_count FROM (SELECT 1 FROM "topics" LIMIT 10001) rows;
    IF bounded_count > 10000
       AND coalesce(current_setting('aihub.db_core_index_predeploy', true), 'off') <> 'on' THEN
      RAISE EXCEPTION 'DB_CORE_PREDEPLOY_INDEX_REQUIRED:topics_user_id_created_at_id_idx';
    END IF;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "topics_user_id_created_at_id_idx"
  ON "topics" USING btree ("user_id","created_at","id");
--> statement-breakpoint

DO $$
DECLARE
  bounded_count integer;
BEGIN
  IF to_regclass('public.messages_user_id_topic_id_created_at_id_idx') IS NULL
     AND to_regclass('public.messages') IS NOT NULL THEN
    SELECT count(*) INTO bounded_count FROM (SELECT 1 FROM "messages" LIMIT 10001) rows;
    IF bounded_count > 10000
       AND coalesce(current_setting('aihub.db_core_index_predeploy', true), 'off') <> 'on' THEN
      RAISE EXCEPTION 'DB_CORE_PREDEPLOY_INDEX_REQUIRED:messages_user_id_topic_id_created_at_id_idx';
    END IF;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_user_id_topic_id_created_at_id_idx"
  ON "messages" USING btree ("user_id","topic_id","created_at","id");
--> statement-breakpoint

DO $$
DECLARE
  bounded_count integer;
BEGIN
  IF to_regclass('public.messages_role_created_at_idx') IS NULL
     AND to_regclass('public.messages') IS NOT NULL THEN
    SELECT count(*) INTO bounded_count FROM (SELECT 1 FROM "messages" LIMIT 10001) rows;
    IF bounded_count > 10000
       AND coalesce(current_setting('aihub.db_core_index_predeploy', true), 'off') <> 'on' THEN
      RAISE EXCEPTION 'DB_CORE_PREDEPLOY_INDEX_REQUIRED:messages_role_created_at_idx';
    END IF;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_role_created_at_idx"
  ON "messages" USING btree ("role","created_at");
--> statement-breakpoint

-- Optional title search index (pg_trgm). CONCURRENTLY form is documented above;
-- transactional path matches 0145 (extension-gated, non-CONCURRENTLY).
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE NOTICE 'pg_trgm unavailable; skipping topics_title_trgm_idx';
      RETURN;
  END;
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    CREATE INDEX IF NOT EXISTS "topics_title_trgm_idx"
      ON "topics" USING gin ("title" gin_trgm_ops);
  END IF;
END $$;
--> statement-breakpoint

-- ── Sidebar layout policy invariants (F3 / F4) ───────────────────────────────
-- Never silently DELETE unexpected singleton ids — abort so ops can inspect /
-- quarantine. Invalid modes collapse to 'user' (same read-time interpretation).

DO $$
DECLARE
  unexpected_ids text;
BEGIN
  SELECT string_agg("id", ', ' ORDER BY "id")
    INTO unexpected_ids
  FROM "platform_sidebar_layout"
  WHERE "id" <> 'global';

  IF unexpected_ids IS NOT NULL THEN
    RAISE EXCEPTION
      'DB_CORE_SIDEBAR_LAYOUT_UNEXPECTED_IDS: unexpected platform_sidebar_layout.id values (expected only ''global''): %',
      unexpected_ids;
  END IF;
END $$;
--> statement-breakpoint
UPDATE "platform_sidebar_layout"
SET "mode" = 'user'
WHERE "mode" IS DISTINCT FROM 'user' AND "mode" IS DISTINCT FROM 'platform';
--> statement-breakpoint

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

-- Auth settings singleton was added in 0147; re-assert idempotently for installs
-- that may have skipped that path. Reject unexpected ids — never DELETE them.

DO $$
DECLARE
  unexpected_ids text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'platform_auth_settings_id_singleton'
  ) THEN
    SELECT string_agg("id", ', ' ORDER BY "id")
      INTO unexpected_ids
    FROM "platform_auth_settings"
    WHERE "id" <> 'global';

    IF unexpected_ids IS NOT NULL THEN
      RAISE EXCEPTION
        'DB_CORE_AUTH_SETTINGS_UNEXPECTED_IDS: unexpected platform_auth_settings.id values (expected only ''global''): %',
        unexpected_ids;
    END IF;

    ALTER TABLE "platform_auth_settings"
      ADD CONSTRAINT "platform_auth_settings_id_singleton"
      CHECK ("id" = 'global');
  END IF;
END $$;

--> statement-breakpoint

-- Historical 0150_round2_platform-instance
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

--> statement-breakpoint

-- Historical 0151_round2_sidebar_cas
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

--> statement-breakpoint

-- Historical 0152_round2_rbac_hardening
-- =============================================================================
-- 0152_round2_rbac_hardening — GUC-trust immutability defense-in-depth (users-rbac/F1)
-- SAFE, NON-ABUSABLE, DOUBLE-GATED NO-OP SCAFFOLD.
-- =============================================================================
--
-- BACKGROUND
--   Migration 0145 installed append-only / immutability triggers. Legitimate
--   retention DELETE on platform_audit_logs is gated by a transaction-local GUC
--   (set_config('lobe.allow_platform_audit_log_delete','on',true)); a similar GUC
--   guards platform_agent_versions hard-delete (0140). WEAKNESS (verified MEDIUM,
--   post-compromise defense-in-depth): any client that can open a DB session as the
--   app role can itself SET the GUC and DELETE, because the trigger trusts the GUC
--   rather than a privilege boundary. When DATABASE_URL uses the Postgres SUPERUSER
--   (`postgres`), privilege revocation is meaningless (superuser bypasses). Real
--   isolation requires a dedicated least-privilege app role — an infra/deployment
--   change, not a pure code fix. The audit deferred this exactly because a naive
--   REVOKE breaks the app's normal delete paths.
--
-- WHY NO SECURITY DEFINER "purge" HELPER
--   An app-callable SECURITY DEFINER delete function is itself an arbitrary-delete
--   hole: whatever policy it enforces, a caller that controls its arguments (e.g. a
--   retention cutoff) can pass a far-future value and purge everything not under a
--   legal hold. There is NO app-callable privileged bypass in this migration by
--   design. On a hardened deployment, retention purge and agent hard-delete must run
--   as a SEPARATE privileged maintenance role/connection — never the app role.
--
-- WHAT THIS MIGRATION DOES
--   Nothing at all, UNLESS BOTH of these hold (double gate):
--     (1) an explicit activation marker is set:
--           current_setting('aihub.rbac_hardening_activate', true) = 'on'
--         (set as a role/db-scoped GUC by an operator who has completed the infra
--          + app-rewiring steps below), AND
--     (2) a dedicated, non-superuser app role exists (named via
--           current_setting('aihub.app_db_role', true), else 'aihub_app'/'lobe_app').
--   When activated, it REVOKEs DELETE on the guarded append-only/immutable tables
--   from that role. It never creates a callable bypass and never touches superuser.
--
-- INTENTIONAL NO-OP ON CURRENT SUPERUSER / PGlite DEPLOYS
--   The demo/dev DATABASE_URL is the superuser and no activation marker is set, so
--   this migration is a COMPLETE no-op (NOTICE only; zero GRANT/REVOKE). PGlite test
--   runs likewise no-op. Existing direct GUC+DELETE paths keep working unchanged.
--
-- HOW TO FULLY ACTIVATE (deliberate infra + app follow-up — NOT automatic)
--   1. CREATE ROLE aihub_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;  (or name it
--      via `SET aihub.app_db_role = 'your_app_role'` before migrate). GRANT it normal
--      DML (SELECT/INSERT/UPDATE, and DELETE only on genuinely mutable tables).
--   2. Move the two immutable-table delete paths OFF the app role onto a separate
--      privileged maintenance role/connection (they must NOT run as the least-priv app
--      role once its DELETE is revoked):
--        - packages/database/src/models/platform/auditRetention.ts (retention purge)
--        - packages/database/src/repositories/platformAgentCatalog/index.ts (agent hard-delete cascade)
--      (Those files are owned by other batches; this migration does not edit them.)
--   3. Point DATABASE_URL at the least-privilege app role.
--   4. Only then set the activation marker (role/db GUC):
--        ALTER ROLE aihub_app SET aihub.rbac_hardening_activate = 'on';
--      and re-run migrations (or run the guarded block) so the REVOKE takes effect.
--
-- SAFETY PROPERTIES (provable from this file alone)
--   - No SECURITY DEFINER function; no app-callable privileged delete of any kind.
--   - No bare GRANT/REVOKE: the only REVOKE is inside a DO block gated on BOTH the
--     explicit activation marker AND a dedicated non-superuser role.
--   - Superuser / missing marker / missing role → zero privilege statements execute.
--   - current_user is checked: if the connected role is itself the superuser or lacks
--     a dedicated non-super target, nothing is revoked.
--   - Idempotent: guarded, catalog-checked, safe to re-apply.
--   - Drops any SECURITY DEFINER purge helpers a prior draft of this migration may
--     have installed (they were an arbitrary-delete risk).
-- =============================================================================

-- Remove any purge helpers from prior drafts of this migration (arbitrary-delete risk).
DROP FUNCTION IF EXISTS "platform_purge_audit_logs"(text[], timestamptz);
--> statement-breakpoint
DROP FUNCTION IF EXISTS "platform_purge_agent_versions_for_agent"(text);
--> statement-breakpoint
DROP FUNCTION IF EXISTS "platform_purge_agent_versions"(text[]);
--> statement-breakpoint

-- Guarded, activation-gated, no-op-by-default privilege hardening.
DO $$
DECLARE
  activate text;
  candidates text[] := ARRAY[]::text[];
  setting_role text;
  role_name text;
  is_super boolean;
  hardened_any boolean := false;
  guarded_tables text[] := ARRAY[
    'platform_audit_logs',
    'platform_resource_revisions',
    'platform_agent_versions',
    'platform_skill_versions'
  ];
  t text;
BEGIN
  -- Gate 1: explicit activation marker. Absent/!= 'on' → complete no-op.
  -- (The migration must be RUN BY a privileged role — superuser or the tables' owner —
  --  since only such a role can REVOKE privileges from the dedicated app role. That is
  --  expected and correct; the target of the REVOKE is the SEPARATE dedicated role below,
  --  never current_user.)
  activate := nullif(btrim(coalesce(current_setting('aihub.rbac_hardening_activate', true), '')), '');
  IF activate IS DISTINCT FROM 'on' THEN
    RAISE NOTICE
      '0152_round2_rbac_hardening: not activated (aihub.rbac_hardening_activate <> on); intentional no-op. Superuser/PGlite/demo keep direct GUC+DELETE paths.';
    RETURN;
  END IF;

  -- Gate 2: a dedicated, non-superuser app role must exist (the REVOKE target).
  setting_role := nullif(btrim(coalesce(current_setting('aihub.app_db_role', true), '')), '');
  IF setting_role IS NOT NULL THEN
    candidates := array_append(candidates, setting_role);
  END IF;
  candidates := candidates || ARRAY['aihub_app', 'lobe_app'];

  FOREACH role_name IN ARRAY candidates
  LOOP
    SELECT r.rolsuper INTO is_super
    FROM pg_catalog.pg_roles r
    WHERE r.rolname = role_name;
    IF NOT FOUND THEN CONTINUE; END IF;
    IF is_super THEN CONTINUE; END IF;

    -- The only privilege statement in this migration: revoke DELETE on immutable tables.
    FOREACH t IN ARRAY guarded_tables
    LOOP
      IF to_regclass(format('public.%I', t)) IS NOT NULL THEN
        EXECUTE format('REVOKE DELETE ON TABLE public.%I FROM %I', t, role_name);
      END IF;
    END LOOP;

    RAISE NOTICE
      '0152_round2_rbac_hardening: revoked DELETE on guarded immutable tables from non-superuser role %. Ensure retention/hard-delete run as a separate privileged maintenance role.',
      role_name;
    hardened_any := true;
    EXIT; -- harden only the first matching dedicated role
  END LOOP;

  IF NOT hardened_any THEN
    RAISE NOTICE
      '0152_round2_rbac_hardening: activation set but no dedicated non-superuser app role found (aihub.app_db_role / aihub_app / lobe_app); no-op.';
  END IF;
END $$;

--> statement-breakpoint

-- Historical 0153_round2_connector_test_state
-- Round-2 connectors F4: durable connection-test state on platform_connectors.
-- All seven columns are nullable with no DB default (fail-closed until a probe is recorded).
-- Idempotent / PGlite-safe: plain ALTER TABLE ADD COLUMN IF NOT EXISTS only.

ALTER TABLE "platform_connectors" ADD COLUMN IF NOT EXISTS "connection_test_status" varchar(16);
--> statement-breakpoint
ALTER TABLE "platform_connectors" ADD COLUMN IF NOT EXISTS "connection_test_latency_ms" integer;
--> statement-breakpoint
ALTER TABLE "platform_connectors" ADD COLUMN IF NOT EXISTS "connection_test_error_category" varchar(32);
--> statement-breakpoint
ALTER TABLE "platform_connectors" ADD COLUMN IF NOT EXISTS "connection_test_message_code" varchar(128);
--> statement-breakpoint
ALTER TABLE "platform_connectors" ADD COLUMN IF NOT EXISTS "connection_tested_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "platform_connectors" ADD COLUMN IF NOT EXISTS "connection_tested_draft_token" varchar(64);
--> statement-breakpoint
ALTER TABLE "platform_connectors" ADD COLUMN IF NOT EXISTS "connection_tested_revision" integer;

--> statement-breakpoint

-- Historical 0154_round2_catalog_authority
-- Round-2 platform-instance/F4: persisted multi-instance catalog authority generation.
-- One row per catalog domain; writers bump generation in the same transaction as publish.
-- Readers reconcile with a single PK lookup (no catalog-wide scan on the steady-state path).
-- Idempotent / convergent so partial re-applies are safe (PGlite + Postgres).

CREATE TABLE IF NOT EXISTS "platform_catalog_authority" (
	"domain" text PRIMARY KEY NOT NULL,
	"generation" bigint DEFAULT 0 NOT NULL,
	"token_kind" text NOT NULL,
	"token_value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- Seed the two poll domains at generation 0. ON CONFLICT keeps re-applies no-ops.
INSERT INTO "platform_catalog_authority" ("domain", "generation", "token_kind", "token_value", "updated_at")
VALUES
	('ai_catalog', 0, 'immutable_id', '0000000000000000000000000000000000000000000000000000000000000000', now()),
	('skill_catalog', 0, 'immutable_id', '0000000000000000000000000000000000000000000000000000000000000000', now())
ON CONFLICT ("domain") DO NOTHING;

--> statement-breakpoint

-- Historical 0155_round2_skill_validation_trigger
-- Round-2 skills: allow validation_result-only UPDATEs on immutable skill versions
-- when the writer opts in via transaction-local GUC
-- lobe.allow_platform_skill_version_validation_update=on.
--
-- Mirrors 0140 agent-version delete / 0145 audit retention GUC escape hatches.
-- Content fields stay immutable; DELETE stays rejected.
-- Idempotent: CREATE OR REPLACE FUNCTION only (trigger binding from 0122 still points here).

CREATE OR REPLACE FUNCTION "prevent_platform_skill_version_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  masked "platform_skill_versions"%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE'
     AND current_setting('lobe.allow_platform_skill_version_validation_update', true) = 'on'
  THEN
    -- Robust "only validation_result changed" check: mask allowed columns back to OLD
    -- and compare the whole row. platform_skill_versions has no updated_at column;
    -- if one is added later, mask it here as well.
    masked := NEW;
    masked.validation_result := OLD.validation_result;
    IF masked IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION 'platform_skill_versions are immutable' USING ERRCODE = '55000';
END;
$$;

--> statement-breakpoint
