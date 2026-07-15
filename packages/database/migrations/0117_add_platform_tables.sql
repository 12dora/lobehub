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
