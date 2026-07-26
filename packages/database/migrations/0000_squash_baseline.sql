-- Final-state squashed baseline generated from packages/database/src/schemas.
-- Custom extensions, search indexes, and invariant triggers follow the generated DDL.
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_search;
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" varchar(100),
	"title" varchar(255),
	"description" varchar(1000),
	"tags" jsonb DEFAULT '[]'::jsonb,
	"editor_data" jsonb,
	"avatar" text,
	"background_color" text,
	"market_identifier" text,
	"plugins" jsonb,
	"client_id" text,
	"user_id" text NOT NULL,
	"workspace_id" text,
	"agency_config" jsonb,
	"chat_config" jsonb,
	"few_shots" jsonb,
	"model" text,
	"params" jsonb DEFAULT '{}'::jsonb,
	"provider" text,
	"system_role" text,
	"tts" jsonb,
	"virtual" boolean DEFAULT false,
	"pinned" boolean,
	"opening_message" text,
	"opening_questions" text[] DEFAULT '{}',
	"session_group_id" text,
	"visibility" text DEFAULT 'public' NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents_files" (
	"file_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"enabled" boolean DEFAULT true,
	"user_id" text NOT NULL,
	"workspace_id" text,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_files_file_id_agent_id_user_id_pk" PRIMARY KEY("file_id","agent_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "agents_knowledge_bases" (
	"agent_id" text NOT NULL,
	"knowledge_base_id" text NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text,
	"enabled" boolean DEFAULT true,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_knowledge_bases_agent_id_knowledge_base_id_pk" PRIMARY KEY("agent_id","knowledge_base_id")
);
--> statement-breakpoint
CREATE TABLE "agent_bot_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" text NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text,
	"platform" varchar(50) NOT NULL,
	"application_id" varchar(255) NOT NULL,
	"credentials" text,
	"settings" jsonb DEFAULT '{}'::jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_cron_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"group_id" text,
	"user_id" text NOT NULL,
	"workspace_id" text,
	"name" text,
	"description" text,
	"enabled" boolean DEFAULT true,
	"cron_pattern" text NOT NULL,
	"timezone" text DEFAULT 'UTC',
	"content" text NOT NULL,
	"edit_data" jsonb,
	"max_executions" integer,
	"remaining_executions" integer,
	"execution_conditions" jsonb,
	"last_executed_at" timestamp,
	"total_executions" integer DEFAULT 0,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text,
	"agent_id" text NOT NULL,
	"document_id" varchar(255) NOT NULL,
	"template_id" varchar(100),
	"access_self" integer DEFAULT 31 NOT NULL,
	"access_shared" integer DEFAULT 0 NOT NULL,
	"access_public" integer DEFAULT 0 NOT NULL,
	"policy_load" varchar(30) DEFAULT 'always' NOT NULL,
	"policy" jsonb,
	"policy_load_position" varchar(50) DEFAULT 'before-first-user' NOT NULL,
	"policy_load_format" varchar(20) DEFAULT 'raw' NOT NULL,
	"policy_load_rule" varchar(50) DEFAULT 'always' NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by_user_id" text,
	"deleted_by_agent_id" text,
	"delete_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_eval_benchmarks" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"rubrics" jsonb NOT NULL,
	"reference_url" text,
	"metadata" jsonb,
	"user_id" text,
	"workspace_id" text,
	"is_system" boolean DEFAULT true NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_eval_datasets" (
	"id" text PRIMARY KEY NOT NULL,
	"benchmark_id" text NOT NULL,
	"source_experiment_id" text,
	"identifier" text NOT NULL,
	"user_id" text,
	"workspace_id" text,
	"name" text NOT NULL,
	"description" text,
	"eval_mode" text,
	"eval_config" jsonb,
	"metadata" jsonb,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_eval_experiment_benchmarks" (
	"experiment_id" text NOT NULL,
	"benchmark_id" text NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_eval_experiment_benchmarks_experiment_id_benchmark_id_pk" PRIMARY KEY("experiment_id","benchmark_id")
);
--> statement-breakpoint
CREATE TABLE "agent_eval_experiments" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text,
	"name" text NOT NULL,
	"description" text,
	"metadata" jsonb,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_eval_run_topics" (
	"user_id" text NOT NULL,
	"workspace_id" text,
	"run_id" text NOT NULL,
	"topic_id" text NOT NULL,
	"test_case_id" text NOT NULL,
	"status" text,
	"score" real,
	"passed" boolean,
	"eval_result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_eval_run_topics_run_id_topic_id_pk" PRIMARY KEY("run_id","topic_id")
);
--> statement-breakpoint
CREATE TABLE "agent_eval_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"dataset_id" text NOT NULL,
	"experiment_id" text,
	"parent_run_id" text,
	"target_agent_id" text,
	"user_id" text NOT NULL,
	"workspace_id" text,
	"name" text,
	"status" text DEFAULT 'idle' NOT NULL,
	"config" jsonb,
	"metrics" jsonb,
	"started_at" timestamp with time zone,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_eval_test_cases" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text,
	"dataset_id" text NOT NULL,
	"content" jsonb NOT NULL,
	"eval_mode" text,
	"eval_config" jsonb,
	"metadata" jsonb,
	"sort_order" integer,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text,
	"agent_id" text,
	"topic_id" text,
	"thread_id" text,
	"task_id" text,
	"chat_group_id" text,
	"parent_operation_id" text,
	"status" text NOT NULL,
	"completion_reason" text,
	"verify_status" text,
	"verify_plan" jsonb,
	"verify_plan_confirmed_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"step_count" integer,
	"max_steps" integer,
	"force_finish" boolean,
	"interruption" jsonb,
	"error" jsonb,
	"total_cost" numeric(20, 6),
	"currency" text DEFAULT 'USD' NOT NULL,
	"total_input_tokens" integer,
	"total_output_tokens" integer,
	"total_tokens" integer,
	"llm_calls" integer,
	"tool_calls" integer,
	"human_interventions" integer,
	"processing_time_ms" integer,
	"human_waiting_time_ms" integer,
	"cost" jsonb,
	"usage" jsonb,
	"cost_limit" jsonb,
	"model" text,
	"provider" text,
	"model_runtime_config" jsonb,
	"trigger" text,
	"app_context" jsonb,
	"trace_s3_key" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" text NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"share_config" jsonb,
	"user_view_count" integer DEFAULT 0 NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_skills" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"identifier" text NOT NULL,
	"source" text NOT NULL,
	"manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"content" text,
	"editor_data" jsonb,
	"resources" jsonb DEFAULT '{}'::jsonb,
	"zip_file_hash" varchar(64),
	"user_id" text NOT NULL,
	"workspace_id" text,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_models" (
	"id" varchar(150) NOT NULL,
	"_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" varchar(200),
	"description" text,
	"organization" varchar(100),
	"enabled" boolean,
	"provider_id" varchar(64) NOT NULL,
	"type" varchar(20) DEFAULT 'chat' NOT NULL,
	"sort" integer,
	"user_id" text NOT NULL,
	"pricing" jsonb,
	"parameters" jsonb DEFAULT '{}'::jsonb,
	"config" jsonb,
	"abilities" jsonb DEFAULT '{}'::jsonb,
	"context_window_tokens" integer,
	"source" varchar(20),
	"released_at" varchar(10),
	"settings" jsonb DEFAULT '{}'::jsonb,
	"workspace_id" text,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_providers" (
	"id" varchar(64) NOT NULL,
	"name" text,
	"_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"sort" integer,
	"enabled" boolean,
	"fetch_on_client" boolean,
	"check_model" text,
	"logo" text,
	"description" text,
	"key_vaults" text,
	"source" varchar(20),
	"settings" jsonb,
	"config" jsonb,
	"workspace_id" text,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"name" varchar(256) NOT NULL,
	"key" varchar(256) NOT NULL,
	"key_hash" varchar(128),
	"enabled" boolean DEFAULT true,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"user_id" text NOT NULL,
	"workspace_id" text,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_key_unique" UNIQUE("key"),
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "async_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text,
	"status" text,
	"error" jsonb,
	"inference_id" text,
	"user_id" text NOT NULL,
	"workspace_id" text,
	"duration" integer,
	"parent_id" uuid,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"access_token" text,
	"access_token_expires_at" timestamp,
	"account_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"id_token" text,
	"password" text,
	"provider_id" text NOT NULL,
	"refresh_token" text,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"updated_at" timestamp NOT NULL,
	"user_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "passkey" (
	"aaguid" text,
	"backedUp" boolean,
	"counter" integer,
	"createdAt" timestamp DEFAULT now(),
	"credentialID" text NOT NULL,
	"deviceType" text,
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"publicKey" text NOT NULL,
	"transports" text,
	"userId" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"impersonated_by" text,
	"ip_address" text,
	"token" text NOT NULL,
	"updated_at" timestamp NOT NULL,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "auth_sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "two_factor" (
	"backup_codes" text NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"secret" text NOT NULL,
	"user_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text,
	"description" text,
	"avatar" text,
	"background_color" text,
	"market_identifier" text,
	"content" text,
	"editor_data" jsonb,
	"config" jsonb,
	"client_id" text,
	"user_id" text NOT NULL,
	"workspace_id" text,
	"group_id" text,
	"pinned" boolean DEFAULT false,
	"visibility" text DEFAULT 'public' NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_groups_agents" (
	"chat_group_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text,
	"enabled" boolean DEFAULT true,
	"order" integer DEFAULT 0,
	"role" text DEFAULT 'participant',
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_groups_agents_chat_group_id_agent_id_pk" PRIMARY KEY("chat_group_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "user_connector_tools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_connector_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text,
	"tool_name" varchar(255) NOT NULL,
	"display_name" varchar(255),
	"description" text,
	"input_schema" jsonb,
	"output_schema" jsonb,
	"crud_type" text NOT NULL,
	"render_config" jsonb,
	"permission" text NOT NULL,
	"is_work_artifact" boolean DEFAULT false NOT NULL,
	"work_artifact_config" jsonb,
	"limit_config" jsonb,
	"metadata" jsonb,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_connectors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text,
	"agent_id" text,
	"identifier" varchar(255) NOT NULL,
	"name" varchar(255) NOT NULL,
	"source_type" text NOT NULL,
	"mcp_server_url" text,
	"mcp_connection_type" text,
	"mcp_stdio_config" jsonb,
	"status" text NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"oidc_config" jsonb,
	"credentials" text,
	"token_expires_at" timestamp with time zone,
	"metadata" jsonb,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_installed_plugins" (
	"user_id" text NOT NULL,
	"workspace_id" text,
	"identifier" text NOT NULL,
	"type" text NOT NULL,
	"manifest" jsonb,
	"settings" jsonb,
	"custom_params" jsonb,
	"source" varchar(255),
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_installed_plugins_user_id_identifier_pk" PRIMARY KEY("user_id","identifier")
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text,
	"device_id" varchar(64) NOT NULL,
	"identity_source" varchar(20) NOT NULL,
	"hostname" text,
	"platform" varchar(20),
	"friendly_name" text,
	"default_cwd" text,
	"recent_cwds" text[] DEFAULT '{}' NOT NULL,
	"working_dirs" jsonb DEFAULT '[]'::jsonb,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_histories" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"document_id" varchar(255) NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text,
	"editor_data" jsonb NOT NULL,
	"save_source" text NOT NULL,
	"saved_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" varchar(255) NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text,
	"visibility" text DEFAULT 'private' NOT NULL,
	"permission" text DEFAULT 'read' NOT NULL,
	"page_view_count" integer DEFAULT 0 NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"title" text,
	"description" text,
	"content" text,
	"file_type" varchar(255) NOT NULL,
	"filename" text,
	"total_char_count" integer NOT NULL,
	"total_line_count" integer NOT NULL,
	"metadata" jsonb,
	"pages" jsonb,
	"source_type" text NOT NULL,
	"source" text NOT NULL,
	"file_id" text,
	"knowledge_base_id" text,
	"parent_id" varchar(255),
	"user_id" text NOT NULL,
	"client_id" text,
	"editor_data" jsonb,
	"slug" varchar(255),
	"workspace_id" text,
	"visibility" text DEFAULT 'public' NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"file_type" varchar(255) NOT NULL,
	"file_hash" varchar(64),
	"name" text NOT NULL,
	"size" integer NOT NULL,
	"url" text NOT NULL,
	"source" text,
	"parent_id" varchar(255),
	"client_id" text,
	"metadata" jsonb,
	"chunk_task_id" uuid,
	"embedding_task_id" uuid,
	"workspace_id" text,
	"visibility" text DEFAULT 'public' NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "global_files" (
	"hash_id" varchar(64) PRIMARY KEY NOT NULL,
	"file_type" varchar(255) NOT NULL,
	"size" integer NOT NULL,
	"url" text NOT NULL,
	"metadata" jsonb,
	"creator" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_base_files" (
	"knowledge_base_id" text NOT NULL,
	"file_id" text NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_base_files_knowledge_base_id_file_id_pk" PRIMARY KEY("knowledge_base_id","file_id")
);
--> statement-breakpoint
CREATE TABLE "knowledge_bases" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"avatar" text,
	"type" text,
	"user_id" text NOT NULL,
	"client_id" text,
	"is_public" boolean DEFAULT false,
	"settings" jsonb,
	"workspace_id" text,
	"visibility" text DEFAULT 'public' NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "generation_batches" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text,
	"generation_topic_id" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"prompt" text NOT NULL,
	"width" integer,
	"height" integer,
	"ratio" varchar(64),
	"config" jsonb,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "generation_topics" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text,
	"title" text,
	"cover_url" text,
	"type" varchar(32) DEFAULT 'image' NOT NULL,
	"visibility" text DEFAULT 'public' NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "generations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text,
	"generation_batch_id" varchar(64) NOT NULL,
	"async_task_id" uuid,
	"file_id" text,
	"seed" integer,
	"asset" jsonb,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_generation_tracing" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scenario" text NOT NULL,
	"prompt_version" text NOT NULL,
	"prompt_hash" text NOT NULL,
	"schema_name" text,
	"user_id" text NOT NULL,
	"agent_id" text,
	"topic_id" text,
	"workspace_id" text,
	"trigger" text,
	"parent_tracing_id" uuid,
	"provider" text,
	"model" text,
	"success" boolean NOT NULL,
	"error_code" text,
	"error_detail" text,
	"validation_failed" boolean DEFAULT false NOT NULL,
	"input_hash" text,
	"input_hint" text,
	"latency_ms" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_usd" numeric(12, 8),
	"storage_key" text,
	"feedback_signal" text,
	"feedback_score" numeric(3, 2),
	"feedback_source" text,
	"feedback_data" jsonb,
	"feedback_updated_at" timestamp with time zone,
	"trace_id" text,
	"span_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_chunks" (
	"message_id" text,
	"chunk_id" uuid,
	"user_id" text NOT NULL,
	"workspace_id" text,
	CONSTRAINT "message_chunks_chunk_id_message_id_pk" PRIMARY KEY("chunk_id","message_id")
);
--> statement-breakpoint
CREATE TABLE "message_groups" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"topic_id" text,
	"user_id" text NOT NULL,
	"workspace_id" text,
	"parent_group_id" varchar(255),
	"parent_message_id" text,
	"title" varchar(255),
	"description" text,
	"type" text,
	"content" text,
	"editor_data" jsonb,
	"metadata" jsonb,
	"client_id" varchar(255),
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_plugins" (
	"id" text PRIMARY KEY NOT NULL,
	"tool_call_id" text,
	"type" text DEFAULT 'default',
	"intervention" jsonb,
	"api_name" text,
	"arguments" text,
	"identifier" text,
	"state" jsonb,
	"error" jsonb,
	"client_id" text,
	"user_id" text NOT NULL,
	"workspace_id" text
);
--> statement-breakpoint
CREATE TABLE "message_queries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" text NOT NULL,
	"rewrite_query" text,
	"user_query" text,
	"client_id" text,
	"user_id" text NOT NULL,
	"workspace_id" text,
	"embeddings_id" uuid
);
--> statement-breakpoint
CREATE TABLE "message_query_chunks" (
	"id" text,
	"query_id" uuid,
	"chunk_id" uuid,
	"similarity" numeric(6, 5),
	"user_id" text NOT NULL,
	"workspace_id" text,
	CONSTRAINT "message_query_chunks_chunk_id_id_query_id_pk" PRIMARY KEY("chunk_id","id","query_id")
);
--> statement-breakpoint
CREATE TABLE "message_tts" (
	"id" text PRIMARY KEY NOT NULL,
	"content_md5" text,
	"file_id" text,
	"voice" text,
	"client_id" text,
	"user_id" text NOT NULL,
	"workspace_id" text
);
--> statement-breakpoint
CREATE TABLE "message_translates" (
	"id" text PRIMARY KEY NOT NULL,
	"content" text,
	"from" text,
	"to" text,
	"client_id" text,
	"user_id" text NOT NULL,
	"workspace_id" text
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"role" varchar(255) NOT NULL,
	"content" text,
	"editor_data" jsonb,
	"summary" text,
	"reasoning" jsonb,
	"search" jsonb,
	"metadata" jsonb,
	"usage" jsonb,
	"model" text,
	"provider" text,
	"favorite" boolean DEFAULT false,
	"error" jsonb,
	"tools" jsonb,
	"trace_id" text,
	"observation_id" text,
	"client_id" text,
	"user_id" text NOT NULL,
	"session_id" text,
	"topic_id" text,
	"thread_id" text,
	"parent_id" text,
	"quota_id" text,
	"agent_id" text,
	"group_id" text,
	"target_id" text,
	"message_group_id" varchar(255),
	"workspace_id" text,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages_files" (
	"file_id" text NOT NULL,
	"message_id" text NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text,
	CONSTRAINT "messages_files_file_id_message_id_pk" PRIMARY KEY("file_id","message_id")
);
--> statement-breakpoint
CREATE TABLE "messenger_account_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text,
	"platform" varchar(50) NOT NULL,
	"tenant_id" varchar(255) DEFAULT '' NOT NULL,
	"platform_user_id" varchar(255) NOT NULL,
	"platform_username" text,
	"active_agent_id" text,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messenger_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform" varchar(50) NOT NULL,
	"tenant_id" varchar(255) NOT NULL,
	"application_id" varchar(255) NOT NULL,
	"account_id" varchar(255),
	"credentials" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"token_expires_at" timestamp with time zone,
	"installed_by_user_id" text,
	"installed_by_platform_user_id" varchar(255),
	"revoked_at" timestamp with time zone,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nextauth_accounts" (
	"access_token" text,
	"expires_at" integer,
	"id_token" text,
	"provider" text NOT NULL,
	"providerAccountId" text NOT NULL,
	"refresh_token" text,
	"scope" text,
	"session_state" text,
	"token_type" text,
	"type" text NOT NULL,
	"user_id" text NOT NULL,
	CONSTRAINT "nextauth_accounts_provider_providerAccountId_pk" PRIMARY KEY("provider","providerAccountId")
);
--> statement-breakpoint
CREATE TABLE "nextauth_authenticators" (
	"counter" integer NOT NULL,
	"credentialBackedUp" boolean NOT NULL,
	"credentialDeviceType" text NOT NULL,
	"credentialID" text NOT NULL,
	"credentialPublicKey" text NOT NULL,
	"providerAccountId" text NOT NULL,
	"transports" text,
	"user_id" text NOT NULL,
	CONSTRAINT "nextauth_authenticators_user_id_credentialID_pk" PRIMARY KEY("user_id","credentialID"),
	CONSTRAINT "nextauth_authenticators_credentialID_unique" UNIQUE("credentialID")
);
--> statement-breakpoint
CREATE TABLE "nextauth_sessions" (
	"expires" timestamp NOT NULL,
	"sessionToken" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nextauth_verificationtokens" (
	"expires" timestamp NOT NULL,
	"identifier" text NOT NULL,
	"token" text NOT NULL,
	CONSTRAINT "nextauth_verificationtokens_identifier_token_pk" PRIMARY KEY("identifier","token")
);
--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"notification_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"status" text NOT NULL,
	"provider_message_id" text,
	"failed_reason" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"category" text NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"dedupe_key" text,
	"action_url" text,
	"is_read" boolean DEFAULT false NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_handoffs" (
	"id" text PRIMARY KEY NOT NULL,
	"client" varchar(50) NOT NULL,
	"payload" jsonb NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oidc_access_tokens" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"user_id" text NOT NULL,
	"client_id" varchar(255) NOT NULL,
	"grant_id" varchar(255),
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oidc_authorization_codes" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"user_id" text NOT NULL,
	"client_id" varchar(255) NOT NULL,
	"grant_id" varchar(255),
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oidc_clients" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"client_secret" varchar(255),
	"redirect_uris" text[] NOT NULL,
	"grants" text[] NOT NULL,
	"response_types" text[] NOT NULL,
	"scopes" text[] NOT NULL,
	"token_endpoint_auth_method" varchar(20),
	"application_type" varchar(20),
	"client_uri" text,
	"logo_uri" text,
	"policy_uri" text,
	"tos_uri" text,
	"is_first_party" boolean DEFAULT false,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oidc_consents" (
	"user_id" text NOT NULL,
	"client_id" varchar(255) NOT NULL,
	"scopes" text[] NOT NULL,
	"expires_at" timestamp with time zone,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oidc_consents_user_id_client_id_pk" PRIMARY KEY("user_id","client_id")
);
--> statement-breakpoint
CREATE TABLE "oidc_device_codes" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"user_id" text,
	"client_id" varchar(255) NOT NULL,
	"grant_id" varchar(255),
	"user_code" varchar(255),
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oidc_grants" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"user_id" text NOT NULL,
	"client_id" varchar(255) NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oidc_interactions" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oidc_refresh_tokens" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"user_id" text NOT NULL,
	"client_id" varchar(255) NOT NULL,
	"grant_id" varchar(255),
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oidc_sessions" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"user_id" text NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_admin_mutation_rate_windows" (
	"scope_digest" text PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_ms" integer NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_agent_assignments" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"target_type" varchar(32) NOT NULL,
	"target_id" text NOT NULL,
	"mode" varchar(32) DEFAULT 'optional' NOT NULL,
	"version_policy" varchar(32) DEFAULT 'latest_published' NOT NULL,
	"pinned_version_id" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"materialized_agent_id" text,
	"installed_version" text,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"user_overlay" jsonb,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_agent_assignments_target_check" CHECK (("platform_agent_assignments"."target_type" = 'global' AND "platform_agent_assignments"."target_id" = '__global__')
        OR ("platform_agent_assignments"."target_type" IN ('global_role', 'user')
          AND length("platform_agent_assignments"."target_id") > 0
          AND "platform_agent_assignments"."target_id" <> '__global__')),
	CONSTRAINT "platform_agent_assignments_mode_check" CHECK ("platform_agent_assignments"."mode" IN ('mandatory', 'default', 'optional')),
	CONSTRAINT "platform_agent_assignments_version_policy_check" CHECK (("platform_agent_assignments"."version_policy" = 'latest_published' AND "platform_agent_assignments"."pinned_version_id" IS NULL)
        OR ("platform_agent_assignments"."version_policy" = 'pinned' AND "platform_agent_assignments"."pinned_version_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "platform_agent_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"version" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dependency_check" jsonb,
	"dependency_snapshot" jsonb,
	"checksum" varchar(64),
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_agent_versions_checksum_check" CHECK ("platform_agent_versions"."checksum" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "platform_agent_versions_exact_snapshot_pair_check" CHECK (("platform_agent_versions"."checksum" IS NULL AND "platform_agent_versions"."dependency_snapshot" IS NULL)
        OR ("platform_agent_versions"."checksum" IS NOT NULL AND "platform_agent_versions"."dependency_snapshot" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "platform_agents" (
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
	"migration_required" boolean DEFAULT false NOT NULL,
	"current_version" text,
	"current_version_id" text,
	"status" varchar(32) DEFAULT 'draft' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"draft_sequence" integer DEFAULT 0 NOT NULL,
	"published_at" timestamp with time zone,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_agents_default_inbox_consistency_check" CHECK (("platform_agents"."is_default" AND "platform_agents"."system_key" = 'default-inbox')
        OR (NOT "platform_agents"."is_default" AND "platform_agents"."system_key" IS DISTINCT FROM 'default-inbox')),
	CONSTRAINT "platform_agents_published_pointer_check" CHECK ("platform_agents"."status" <> 'published'
        OR (NOT "platform_agents"."migration_required"
          AND "platform_agents"."current_version_id" IS NOT NULL
          AND "platform_agents"."published_at" IS NOT NULL)),
	CONSTRAINT "platform_agents_revision_check" CHECK ("platform_agents"."revision" >= 0 AND "platform_agents"."draft_sequence" >= 0)
);
--> statement-breakpoint
CREATE TABLE "platform_user_agent_materialization_tombstones" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"materialized_agent_id" text NOT NULL,
	"former_platform_agent_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_user_agent_materializations" (
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
	CONSTRAINT "platform_user_agent_materializations_checksum_check" CHECK ("platform_user_agent_materializations"."platform_agent_version_checksum" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "platform_user_agent_materializations_status_check" CHECK ("platform_user_agent_materializations"."status" IN ('pending', 'materialized', 'error')),
	CONSTRAINT "platform_user_agent_materializations_local_status_check" CHECK (("platform_user_agent_materializations"."status" = 'materialized' AND "platform_user_agent_materializations"."materialized_agent_id" IS NOT NULL)
        OR ("platform_user_agent_materializations"."status" <> 'materialized')),
	CONSTRAINT "platform_user_agent_materializations_error_category_value_check" CHECK ("platform_user_agent_materializations"."last_error_category" IS NULL
        OR "platform_user_agent_materializations"."last_error_category" IN ('local_agent_missing', 'materialization_failed', 'version_conflict')),
	CONSTRAINT "platform_user_agent_materializations_error_category_check" CHECK (("platform_user_agent_materializations"."status" = 'error' AND "platform_user_agent_materializations"."last_error_category" IS NOT NULL)
        OR ("platform_user_agent_materializations"."status" <> 'error' AND "platform_user_agent_materializations"."last_error_category" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "platform_ai_models" (
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
CREATE TABLE "platform_ai_provider_secrets" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"ciphertext" text NOT NULL,
	"key_id" varchar(256),
	"key_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_ai_providers" (
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
	"secret_key_id" varchar(256),
	"secret_key_version" integer,
	"secret_updated_at" timestamp with time zone,
	"secret_fingerprint" text,
	"connection_test_status" varchar(16),
	"connection_test_latency_ms" integer,
	"connection_test_error_category" varchar(32),
	"connection_test_sanitized_message" varchar(500),
	"connection_tested_at" timestamp with time zone,
	"connection_tested_draft_token" varchar(64),
	"connection_tested_revision" integer,
	"connection_test_attempt_id" text,
	"sort" integer DEFAULT 0 NOT NULL,
	"status" varchar(32) DEFAULT 'draft' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_audit_exports" (
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
CREATE TABLE "platform_audit_legal_holds" (
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
CREATE TABLE "platform_audit_policies" (
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
CREATE TABLE "platform_audit_retention_runs" (
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
CREATE TABLE "platform_audit_logs" (
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
CREATE TABLE "platform_auth_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"email_domain_allowlist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"email_domain_allowlist_enabled" boolean DEFAULT false NOT NULL,
	"open_registration" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_auth_settings_id_singleton" CHECK ("platform_auth_settings"."id" = 'global'),
	CONSTRAINT "platform_auth_settings_revision_check" CHECK ("platform_auth_settings"."revision" >= 0),
	CONSTRAINT "platform_auth_settings_allowlist_nonempty_when_enabled" CHECK ((NOT "platform_auth_settings"."email_domain_allowlist_enabled") OR (jsonb_array_length("platform_auth_settings"."email_domain_allowlist") > 0))
);
--> statement-breakpoint
CREATE TABLE "platform_branding" (
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
CREATE TABLE "platform_branding_assets" (
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
CREATE TABLE "platform_branding_operations" (
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
CREATE TABLE "platform_catalog_authority" (
	"domain" text PRIMARY KEY NOT NULL,
	"generation" bigint DEFAULT 0 NOT NULL,
	"token_kind" text NOT NULL,
	"token_value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_connector_governance" (
	"id" text PRIMARY KEY NOT NULL,
	"resource" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_connector_oauth_states" (
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
	"authorization_outcome" varchar(16),
	"finished_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_connector_oauth_states_terminal_check" CHECK ("platform_connector_oauth_states"."consumed_at" IS NULL OR "platform_connector_oauth_states"."revoked_at" IS NULL),
	CONSTRAINT "platform_connector_oauth_states_outcome_check" CHECK (("platform_connector_oauth_states"."authorization_outcome" IS NULL AND "platform_connector_oauth_states"."finished_at" IS NULL)
        OR ("platform_connector_oauth_states"."authorization_outcome" IN ('completed', 'failed') AND "platform_connector_oauth_states"."finished_at" IS NOT NULL)),
	CONSTRAINT "platform_connector_oauth_states_pkce_ref_check" CHECK ("platform_connector_oauth_states"."pkce_verifier_ref" LIKE 'vault://%' OR "platform_connector_oauth_states"."pkce_verifier_ref" LIKE 'kms://%'),
	CONSTRAINT "platform_connector_oauth_states_hash_check" CHECK ("platform_connector_oauth_states"."state_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "platform_connector_oauth_states_revision_check" CHECK ("platform_connector_oauth_states"."published_revision" > 0 AND "platform_connector_oauth_states"."revision_resource_type" = 'connector'),
	CONSTRAINT "platform_connector_oauth_states_ttl_check" CHECK ("platform_connector_oauth_states"."expires_at" > "platform_connector_oauth_states"."created_at"
        AND "platform_connector_oauth_states"."expires_at" <= "platform_connector_oauth_states"."created_at" + interval '10 minutes')
);
--> statement-breakpoint
CREATE TABLE "platform_connector_secrets" (
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
CREATE TABLE "platform_connector_tools" (
	"id" text PRIMARY KEY NOT NULL,
	"connector_id" text NOT NULL,
	"tool_key" varchar(128) NOT NULL,
	"manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"permission_policy" varchar(32) DEFAULT 'needs_approval' NOT NULL,
	"allow_user_stricter_policy" boolean DEFAULT true NOT NULL,
	"limit_config" jsonb,
	"display_name" varchar(200) NOT NULL,
	"description" text,
	"input_schema" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output_schema" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"platform_policy" varchar(16) DEFAULT 'deny' NOT NULL,
	"risk_level" varchar(16) DEFAULT 'high' NOT NULL,
	"requires_confirmation" boolean DEFAULT true NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_connector_tools_policy_check" CHECK ("platform_connector_tools"."platform_policy" IN ('allow', 'deny')),
	CONSTRAINT "platform_connector_tools_risk_check" CHECK ("platform_connector_tools"."risk_level" IN ('low', 'medium', 'high', 'critical')),
	CONSTRAINT "platform_connector_tools_schema_check" CHECK (jsonb_typeof("platform_connector_tools"."input_schema") = 'object'
        AND jsonb_typeof("platform_connector_tools"."output_schema") = 'object'
        AND octet_length("platform_connector_tools"."input_schema"::text) <= 65536
        AND octet_length("platform_connector_tools"."output_schema"::text) <= 65536),
	CONSTRAINT "platform_connector_tools_confirmation_check" CHECK ("platform_connector_tools"."risk_level" NOT IN ('high', 'critical') OR "platform_connector_tools"."requires_confirmation" = true)
);
--> statement-breakpoint
CREATE TABLE "platform_connectors" (
	"id" text PRIMARY KEY NOT NULL,
	"connector_key" varchar(128) NOT NULL,
	"name" text NOT NULL,
	"source_type" varchar(32) DEFAULT 'custom' NOT NULL,
	"connection_type" varchar(32) DEFAULT 'http' NOT NULL,
	"mcp_server_url" text,
	"mcp_stdio_config" jsonb,
	"display_name" varchar(200) NOT NULL,
	"description" text,
	"endpoint" text,
	"migration_required" boolean DEFAULT true NOT NULL,
	"transport" varchar(16) DEFAULT 'http' NOT NULL,
	"credential_mode" varchar(64) DEFAULT 'per_user_oauth' NOT NULL,
	"oidc_config" jsonb,
	"encrypted_shared_credentials" text,
	"secret_fingerprint" text,
	"is_required" boolean DEFAULT false NOT NULL,
	"oauth_config" jsonb,
	"shared_secret_ref" text,
	"shared_secret_fingerprint" varchar(256),
	"shared_secret_updated_at" timestamp with time zone,
	"oauth_client_secret_ref" text,
	"oauth_client_secret_fingerprint" varchar(256),
	"oauth_client_secret_updated_at" timestamp with time zone,
	"connection_test_status" varchar(16),
	"connection_test_latency_ms" integer,
	"connection_test_error_category" varchar(32),
	"connection_test_message_code" varchar(128),
	"connection_tested_at" timestamp with time zone,
	"connection_tested_draft_token" varchar(64),
	"connection_tested_revision" integer,
	"enabled" boolean DEFAULT false NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"status" varchar(32) DEFAULT 'draft' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"published_resource_type" varchar(64) DEFAULT 'connector' NOT NULL,
	"published_revision" integer,
	"published_checksum" varchar(64),
	"published_at" timestamp with time zone,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_connectors_transport_http_check" CHECK ("platform_connectors"."migration_required" OR ("platform_connectors"."endpoint" IS NOT NULL AND "platform_connectors"."transport" = 'http')),
	CONSTRAINT "platform_connectors_credential_mode_check" CHECK ("platform_connectors"."migration_required" OR "platform_connectors"."credential_mode" IN ('none', 'shared_service_account', 'per_user_oauth')),
	CONSTRAINT "platform_connectors_credential_slot_check" CHECK ("platform_connectors"."migration_required" OR (
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
      )),
	CONSTRAINT "platform_connectors_published_pointer_check" CHECK ("platform_connectors"."migration_required" OR ((
        ("platform_connectors"."published_revision" IS NULL
          AND "platform_connectors"."published_checksum" IS NULL
          AND "platform_connectors"."published_at" IS NULL)
        OR ("platform_connectors"."published_revision" > 0
          AND "platform_connectors"."published_checksum" ~ '^[a-f0-9]{64}$'
          AND "platform_connectors"."published_at" IS NOT NULL)
        ) AND ("platform_connectors"."status" <> 'published' OR "platform_connectors"."published_revision" IS NOT NULL))),
	CONSTRAINT "platform_connectors_revision_check" CHECK ("platform_connectors"."revision" >= 0 AND "platform_connectors"."published_resource_type" = 'connector'),
	CONSTRAINT "platform_connectors_secret_ref_check" CHECK (("platform_connectors"."shared_secret_ref" IS NULL OR "platform_connectors"."shared_secret_ref" LIKE 'vault://%' OR "platform_connectors"."shared_secret_ref" LIKE 'kms://%')
        AND ("platform_connectors"."oauth_client_secret_ref" IS NULL OR "platform_connectors"."oauth_client_secret_ref" LIKE 'vault://%' OR "platform_connectors"."oauth_client_secret_ref" LIKE 'kms://%')),
	CONSTRAINT "platform_connectors_oauth_config_check" CHECK ("platform_connectors"."oauth_config" IS NULL
        OR (jsonb_typeof("platform_connectors"."oauth_config") = 'object'
          AND octet_length("platform_connectors"."oauth_config"::text) <= 16384
          AND "platform_connectors"."oauth_config"::text !~* '"(client_?secret|secret|access_?token|refresh_?token|token|password|authorization)"[[:space:]]*:')),
	CONSTRAINT "platform_connectors_published_shared_secret_check" CHECK ("platform_connectors"."migration_required"
        OR "platform_connectors"."status" <> 'published'
        OR "platform_connectors"."credential_mode" <> 'shared_service_account'
        OR ("platform_connectors"."shared_secret_ref" IS NOT NULL
          AND "platform_connectors"."shared_secret_fingerprint" IS NOT NULL
          AND "platform_connectors"."shared_secret_updated_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "platform_user_connector_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"connector_id" text NOT NULL,
	"revision_resource_type" varchar(64) DEFAULT 'connector' NOT NULL,
	"published_revision" integer,
	"status" varchar(32) DEFAULT 'active' NOT NULL,
	"auth_status" varchar(32) DEFAULT 'disconnected' NOT NULL,
	"encrypted_credentials" text,
	"last_error" text,
	"binding_status" varchar(32) DEFAULT 'disconnected' NOT NULL,
	"oauth_token_ref" text,
	"token_fingerprint" varchar(256),
	"scopes" varchar(200)[] DEFAULT ARRAY[]::varchar[] NOT NULL,
	"expires_at" timestamp with time zone,
	"connected_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_error_category" varchar(32),
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_user_connector_bindings_status_check" CHECK ("platform_user_connector_bindings"."binding_status" IN ('disconnected', 'pending', 'connected', 'expired', 'revoked', 'error')),
	CONSTRAINT "platform_user_connector_bindings_revision_check" CHECK ("platform_user_connector_bindings"."published_revision" IS NULL OR ("platform_user_connector_bindings"."published_revision" > 0
        AND "platform_user_connector_bindings"."revision" >= 0
        AND "platform_user_connector_bindings"."revision_resource_type" = 'connector')),
	CONSTRAINT "platform_user_connector_bindings_token_ref_check" CHECK (("platform_user_connector_bindings"."oauth_token_ref" IS NULL AND "platform_user_connector_bindings"."token_fingerprint" IS NULL)
        OR ("platform_user_connector_bindings"."oauth_token_ref" IS NOT NULL AND "platform_user_connector_bindings"."token_fingerprint" IS NOT NULL)),
	CONSTRAINT "platform_user_connector_bindings_state_fields_check" CHECK (("platform_user_connector_bindings"."binding_status" = 'connected'
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
        OR ("platform_user_connector_bindings"."binding_status" IN ('expired', 'error') AND "platform_user_connector_bindings"."revoked_at" IS NULL)),
	CONSTRAINT "platform_user_connector_bindings_revoked_check" CHECK (("platform_user_connector_bindings"."binding_status" = 'revoked' AND "platform_user_connector_bindings"."revoked_at" IS NOT NULL)
        OR ("platform_user_connector_bindings"."binding_status" <> 'revoked' AND "platform_user_connector_bindings"."revoked_at" IS NULL)),
	CONSTRAINT "platform_user_connector_bindings_token_ref_format_check" CHECK ("platform_user_connector_bindings"."oauth_token_ref" IS NULL OR "platform_user_connector_bindings"."oauth_token_ref" LIKE 'vault://%' OR "platform_user_connector_bindings"."oauth_token_ref" LIKE 'kms://%')
);
--> statement-breakpoint
CREATE TABLE "platform_global_credential_secrets" (
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
CREATE TABLE "platform_global_credential_uploads" (
	"id" text PRIMARY KEY NOT NULL,
	"file_hash_id" varchar(64) NOT NULL,
	"file_name" varchar(255) NOT NULL,
	"file_type" varchar(128) NOT NULL,
	"file_size" integer NOT NULL,
	"fingerprint" varchar(64) NOT NULL,
	"ref" text NOT NULL,
	"ciphertext" text NOT NULL,
	"key_id" varchar(256) NOT NULL,
	"created_by" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_global_credential_uploads_fingerprint_check" CHECK ("platform_global_credential_uploads"."fingerprint" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "platform_global_credential_uploads_file_hash_id_check" CHECK ("platform_global_credential_uploads"."file_hash_id" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "platform_global_credential_uploads_file_size_check" CHECK ("platform_global_credential_uploads"."file_size" > 0 AND "platform_global_credential_uploads"."file_size" <= 262144),
	CONSTRAINT "platform_global_credential_uploads_ref_check" CHECK ("platform_global_credential_uploads"."ref" LIKE 'kms://platform-global-credentials/upload/%')
);
--> statement-breakpoint
CREATE TABLE "platform_global_credentials" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" varchar(100) NOT NULL,
	"name" varchar(255) NOT NULL,
	"type" varchar(32) NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_global_credentials_type_check" CHECK ("platform_global_credentials"."type" IN ('kv-env', 'kv-header', 'file')),
	CONSTRAINT "platform_global_credentials_key_check" CHECK ("platform_global_credentials"."key" ~ '^[\w-]+$' AND char_length("platform_global_credentials"."key") >= 1),
	CONSTRAINT "platform_global_credentials_revision_check" CHECK ("platform_global_credentials"."revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "platform_identity_provider_instances" (
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
CREATE TABLE "platform_identity_provider_restart_requests" (
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
CREATE TABLE "platform_identity_provider_secrets" (
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
CREATE TABLE "platform_identity_provider_test_attempts" (
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
CREATE TABLE "platform_identity_providers" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_key" text NOT NULL,
	"type" varchar(32) DEFAULT 'generic_oidc' NOT NULL,
	"display_name" text NOT NULL,
	"button_label" text DEFAULT '使用工作账号登录' NOT NULL,
	"icon" text,
	"issuer" text,
	"client_id" text,
	"discovery_url" text,
	"encrypted_client_secret" text,
	"migration_required" boolean DEFAULT false NOT NULL,
	"secret_ref" text,
	"secret_fingerprint" text,
	"secret_updated_at" timestamp with time zone,
	"scopes" jsonb DEFAULT '["openid","profile","email"]'::jsonb NOT NULL,
	"use_pkce" boolean DEFAULT true NOT NULL,
	"claim_mapping" jsonb DEFAULT '{"dingtalkTitle":[],"dingtalkUserId":[],"email":["email"],"name":["name","preferred_username"],"picture":["picture"],"subject":["sub"]}'::jsonb NOT NULL,
	"domain_allowlist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"auto_provision" boolean DEFAULT true NOT NULL,
	"group_role_mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"status" varchar(32) DEFAULT 'draft' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"activation_revision" integer,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_identity_providers_key_check" CHECK ("platform_identity_providers"."migration_required" OR "platform_identity_providers"."provider_key" ~ '^[a-z0-9][a-z0-9._-]{0,127}$'),
	CONSTRAINT "platform_identity_providers_type_check" CHECK ("platform_identity_providers"."type" IN ('authentik', 'generic_oidc')),
	CONSTRAINT "platform_identity_providers_status_check" CHECK ("platform_identity_providers"."status" IN ('draft', 'published', 'pending_restart', 'active', 'error', 'disabled', 'archived')),
	CONSTRAINT "platform_identity_providers_revision_check" CHECK ("platform_identity_providers"."revision" >= 0 AND ("platform_identity_providers"."activation_revision" IS NULL OR "platform_identity_providers"."activation_revision" > 0)),
	CONSTRAINT "platform_identity_providers_migration_state_check" CHECK (NOT "platform_identity_providers"."migration_required" OR (
        NOT "platform_identity_providers"."enabled"
        AND "platform_identity_providers"."activation_revision" IS NULL
        AND "platform_identity_providers"."secret_ref" IS NULL
        AND "platform_identity_providers"."secret_fingerprint" IS NULL
        AND "platform_identity_providers"."secret_updated_at" IS NULL
        AND "platform_identity_providers"."status" IN ('draft', 'error', 'disabled', 'archived')
      )),
	CONSTRAINT "platform_identity_providers_secret_state_check" CHECK (("platform_identity_providers"."secret_ref" IS NULL AND "platform_identity_providers"."secret_fingerprint" IS NULL AND "platform_identity_providers"."secret_updated_at" IS NULL)
        OR ("platform_identity_providers"."secret_ref" IS NOT NULL
          AND "platform_identity_providers"."secret_fingerprint" IS NOT NULL
          AND "platform_identity_providers"."secret_fingerprint" ~ '^[a-f0-9]{64}$'
          AND "platform_identity_providers"."secret_updated_at" IS NOT NULL)),
	CONSTRAINT "platform_identity_providers_secret_ref_check" CHECK ("platform_identity_providers"."secret_ref" IS NULL OR "platform_identity_providers"."secret_ref" LIKE 'kms://platform-identity-providers/%'),
	CONSTRAINT "platform_identity_providers_scopes_check" CHECK (jsonb_typeof("platform_identity_providers"."scopes") = 'array'
        AND jsonb_array_length(CASE WHEN jsonb_typeof("platform_identity_providers"."scopes") = 'array' THEN "platform_identity_providers"."scopes" ELSE '[]'::jsonb END) BETWEEN 1 AND 32
        AND "platform_identity_providers"."scopes" ? 'openid'
        AND NOT jsonb_path_exists("platform_identity_providers"."scopes", '$[*] ? (@.type() != "string")')
        AND octet_length("platform_identity_providers"."scopes"::text) <= 4096),
	CONSTRAINT "platform_identity_providers_pkce_check" CHECK ("platform_identity_providers"."use_pkce"),
	CONSTRAINT "platform_identity_providers_claim_mapping_check" CHECK (jsonb_typeof("platform_identity_providers"."claim_mapping") = 'object'
        AND "platform_identity_providers"."claim_mapping" = jsonb_build_object(
          'dingtalkTitle', "platform_identity_providers"."claim_mapping"->'dingtalkTitle',
          'dingtalkUserId', "platform_identity_providers"."claim_mapping"->'dingtalkUserId',
          'email', "platform_identity_providers"."claim_mapping"->'email',
          'name', "platform_identity_providers"."claim_mapping"->'name',
          'picture', "platform_identity_providers"."claim_mapping"->'picture',
          'subject', "platform_identity_providers"."claim_mapping"->'subject'
        )
        AND jsonb_typeof("platform_identity_providers"."claim_mapping"->'dingtalkTitle') = 'array'
        AND jsonb_typeof("platform_identity_providers"."claim_mapping"->'dingtalkUserId') = 'array'
        AND jsonb_typeof("platform_identity_providers"."claim_mapping"->'email') = 'array'
        AND jsonb_typeof("platform_identity_providers"."claim_mapping"->'picture') = 'array'
        AND jsonb_typeof("platform_identity_providers"."claim_mapping"->'subject') = 'array'
        AND jsonb_array_length(CASE WHEN jsonb_typeof("platform_identity_providers"."claim_mapping"->'subject') = 'array' THEN "platform_identity_providers"."claim_mapping"->'subject' ELSE '[]'::jsonb END) > 0
        AND jsonb_typeof("platform_identity_providers"."claim_mapping"->'name') = 'array'
        AND jsonb_array_length(CASE WHEN jsonb_typeof("platform_identity_providers"."claim_mapping"->'name') = 'array' THEN "platform_identity_providers"."claim_mapping"->'name' ELSE '[]'::jsonb END) > 0
        AND jsonb_array_length(CASE WHEN jsonb_typeof("platform_identity_providers"."claim_mapping"->'dingtalkTitle') = 'array' THEN "platform_identity_providers"."claim_mapping"->'dingtalkTitle' ELSE '[]'::jsonb END) <= 8
        AND jsonb_array_length(CASE WHEN jsonb_typeof("platform_identity_providers"."claim_mapping"->'dingtalkUserId') = 'array' THEN "platform_identity_providers"."claim_mapping"->'dingtalkUserId' ELSE '[]'::jsonb END) <= 8
        AND jsonb_array_length(CASE WHEN jsonb_typeof("platform_identity_providers"."claim_mapping"->'email') = 'array' THEN "platform_identity_providers"."claim_mapping"->'email' ELSE '[]'::jsonb END) <= 8
        AND jsonb_array_length(CASE WHEN jsonb_typeof("platform_identity_providers"."claim_mapping"->'name') = 'array' THEN "platform_identity_providers"."claim_mapping"->'name' ELSE '[]'::jsonb END) <= 8
        AND jsonb_array_length(CASE WHEN jsonb_typeof("platform_identity_providers"."claim_mapping"->'picture') = 'array' THEN "platform_identity_providers"."claim_mapping"->'picture' ELSE '[]'::jsonb END) <= 8
        AND jsonb_array_length(CASE WHEN jsonb_typeof("platform_identity_providers"."claim_mapping"->'subject') = 'array' THEN "platform_identity_providers"."claim_mapping"->'subject' ELSE '[]'::jsonb END) <= 8
        AND NOT jsonb_path_exists("platform_identity_providers"."claim_mapping", '$.*[*] ? (@.type() != "string")')
        AND NOT jsonb_path_exists("platform_identity_providers"."claim_mapping", '$.*[*] ? (!(@ like_regex "^[A-Za-z0-9_.:-]{1,128}$"))')
        AND octet_length("platform_identity_providers"."claim_mapping"::text) <= 8192
        AND "platform_identity_providers"."claim_mapping"::text !~* '(client.?secret|api.?key|access.?token|refresh.?token|id.?token|password|authorization|bearer|credential)'),
	CONSTRAINT "platform_identity_providers_policy_json_check" CHECK (jsonb_typeof("platform_identity_providers"."domain_allowlist") = 'array'
        AND jsonb_array_length(CASE WHEN jsonb_typeof("platform_identity_providers"."domain_allowlist") = 'array' THEN "platform_identity_providers"."domain_allowlist" ELSE '[]'::jsonb END) <= 256
        AND octet_length("platform_identity_providers"."domain_allowlist"::text) <= 65536
        AND jsonb_typeof("platform_identity_providers"."group_role_mapping") = 'object'
        AND octet_length("platform_identity_providers"."group_role_mapping"::text) <= 65536)
);
--> statement-breakpoint
CREATE TABLE "platform_instance_heartbeats" (
	"instance_id" varchar(64) PRIMARY KEY NOT NULL,
	"last_heartbeat_at" timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
	"started_at" timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
	CONSTRAINT "platform_instance_heartbeats_id_check" CHECK ("platform_instance_heartbeats"."instance_id" ~ '^pinst_[a-f0-9]{48}$'),
	CONSTRAINT "platform_instance_heartbeats_time_check" CHECK ("platform_instance_heartbeats"."last_heartbeat_at" >= "platform_instance_heartbeats"."started_at")
);
--> statement-breakpoint
CREATE TABLE "platform_instance_revision_states" (
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
CREATE TABLE "platform_jobs" (
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
CREATE TABLE "platform_managed_resource_policies" (
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
CREATE TABLE "platform_resource_revisions" (
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
CREATE TABLE "platform_setting_policies" (
	"path" text PRIMARY KEY NOT NULL,
	"mode" varchar(32) DEFAULT 'user' NOT NULL,
	"visibility" varchar(32) DEFAULT 'visible' NOT NULL,
	"value" jsonb,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"status" varchar(32) DEFAULT 'draft' NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_settings_bundle" (
	"id" text PRIMARY KEY NOT NULL,
	"draft" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" varchar(32) DEFAULT 'draft' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_setting_override_revisions" (
	"user_id" text PRIMARY KEY NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_setting_overrides" (
	"user_id" text NOT NULL,
	"path" text NOT NULL,
	"value" jsonb,
	"source" varchar(32) DEFAULT 'user' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_setting_overrides_pkey" PRIMARY KEY("user_id","path")
);
--> statement-breakpoint
CREATE TABLE "platform_sidebar_layout" (
	"id" text PRIMARY KEY NOT NULL,
	"layout" jsonb,
	"mode" text DEFAULT 'user' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_sidebar_layout_id_singleton" CHECK ("platform_sidebar_layout"."id" = 'global'),
	CONSTRAINT "platform_sidebar_layout_mode_check" CHECK ("platform_sidebar_layout"."mode" IN ('user', 'platform')),
	CONSTRAINT "platform_sidebar_layout_revision_check" CHECK ("platform_sidebar_layout"."revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "platform_skill_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"skill_id" text NOT NULL,
	"version" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"content" text NOT NULL,
	"content_ref" text,
	"resources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"checksum" text NOT NULL,
	"validation_result" jsonb,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_skills" (
	"id" text PRIMARY KEY NOT NULL,
	"skill_key" varchar(128) NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"source" varchar(32) DEFAULT 'uploaded' NOT NULL,
	"distribution" varchar(32) DEFAULT 'optional' NOT NULL,
	"allow_builtin_override" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"current_version_id" text,
	"status" varchar(32) DEFAULT 'draft' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"draft_sequence" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_skills_published_version_required" CHECK ("platform_skills"."status" <> 'published' OR "platform_skills"."current_version_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "push_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"expo_token" text NOT NULL,
	"device_id" text NOT NULL,
	"platform" text NOT NULL,
	"app_version" text,
	"locale" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"text" text,
	"abstract" text,
	"metadata" jsonb,
	"index" integer,
	"type" varchar,
	"client_id" text,
	"user_id" text,
	"workspace_id" text,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_chunks" (
	"document_id" varchar(30) NOT NULL,
	"chunk_id" uuid NOT NULL,
	"page_index" integer,
	"user_id" text NOT NULL,
	"workspace_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_chunks_document_id_chunk_id_pk" PRIMARY KEY("document_id","chunk_id")
);
--> statement-breakpoint
CREATE TABLE "embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chunk_id" uuid,
	"embeddings" vector(1024),
	"model" text,
	"client_id" text,
	"user_id" text,
	"workspace_id" text,
	CONSTRAINT "embeddings_chunk_id_unique" UNIQUE("chunk_id")
);
--> statement-breakpoint
CREATE TABLE "unstructured_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"text" text,
	"metadata" jsonb,
	"index" integer,
	"type" varchar,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"parent_id" varchar,
	"composite_id" uuid,
	"client_id" text,
	"user_id" text,
	"workspace_id" text,
	"file_id" varchar
);
--> statement-breakpoint
CREATE TABLE "rag_eval_dataset_records" (
	"id" text PRIMARY KEY NOT NULL,
	"dataset_id" text NOT NULL,
	"ideal" text,
	"question" text,
	"reference_files" text[],
	"metadata" jsonb,
	"user_id" text,
	"workspace_id" text,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rag_eval_datasets" (
	"id" text PRIMARY KEY NOT NULL,
	"description" text,
	"name" text NOT NULL,
	"knowledge_base_id" text,
	"user_id" text,
	"workspace_id" text,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rag_eval_evaluations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"eval_records_url" text,
	"status" text,
	"error" jsonb,
	"dataset_id" text NOT NULL,
	"knowledge_base_id" text,
	"language_model" text,
	"embedding_model" text,
	"user_id" text,
	"workspace_id" text,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rag_eval_evaluation_records" (
	"id" text PRIMARY KEY NOT NULL,
	"question" text NOT NULL,
	"answer" text,
	"context" text[],
	"ideal" text,
	"status" text,
	"error" jsonb,
	"language_model" text,
	"embedding_model" text,
	"question_embedding_id" uuid,
	"duration" integer,
	"dataset_record_id" text NOT NULL,
	"evaluation_id" text NOT NULL,
	"user_id" text,
	"workspace_id" text,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rbac_permissions" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rbac_permissions_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "rbac_role_permissions" (
	"role_id" text NOT NULL,
	"permission_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rbac_role_permissions_role_id_permission_id_pk" PRIMARY KEY("role_id","permission_id")
);
--> statement-breakpoint
CREATE TABLE "rbac_roles" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text,
	"is_system" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"workspace_id" text,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rbac_user_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"role_id" text NOT NULL,
	"workspace_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "agents_to_sessions" (
	"agent_id" text NOT NULL,
	"session_id" text NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text,
	CONSTRAINT "agents_to_sessions_agent_id_session_id_pk" PRIMARY KEY("agent_id","session_id")
);
--> statement-breakpoint
CREATE TABLE "file_chunks" (
	"file_id" varchar,
	"chunk_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text,
	CONSTRAINT "file_chunks_file_id_chunk_id_pk" PRIMARY KEY("file_id","chunk_id")
);
--> statement-breakpoint
CREATE TABLE "files_to_sessions" (
	"file_id" text NOT NULL,
	"session_id" text NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text,
	CONSTRAINT "files_to_sessions_file_id_session_id_pk" PRIMARY KEY("file_id","session_id")
);
--> statement-breakpoint
CREATE TABLE "session_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"sort" integer,
	"user_id" text NOT NULL,
	"client_id" text,
	"workspace_id" text,
	"visibility" text DEFAULT 'public' NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" varchar(100) NOT NULL,
	"title" text,
	"description" text,
	"avatar" text,
	"background_color" text,
	"type" text DEFAULT 'agent',
	"user_id" text NOT NULL,
	"group_id" text,
	"client_id" text,
	"pinned" boolean DEFAULT false,
	"workspace_id" text,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_bot_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform" varchar(50) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"credentials" text NOT NULL,
	"application_id" varchar(255),
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"connection_mode" varchar(20),
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "briefs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text,
	"task_id" text,
	"cron_job_id" text,
	"topic_id" text,
	"agent_id" text,
	"type" text NOT NULL,
	"priority" text DEFAULT 'info',
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"artifacts" jsonb,
	"actions" jsonb,
	"resolved_action" text,
	"resolved_comment" text,
	"read_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"trigger" varchar(255),
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_comments" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text,
	"author_user_id" text,
	"author_agent_id" text,
	"content" text NOT NULL,
	"editor_data" jsonb,
	"brief_id" text,
	"topic_id" text,
	"visibility" text DEFAULT 'public' NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_dependencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" text NOT NULL,
	"depends_on_id" text NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text,
	"type" text DEFAULT 'blocks' NOT NULL,
	"visibility" text DEFAULT 'public' NOT NULL,
	"condition" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" text NOT NULL,
	"document_id" text NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text,
	"pinned_by" text DEFAULT 'agent' NOT NULL,
	"visibility" text DEFAULT 'public' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_topics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" text NOT NULL,
	"topic_id" text,
	"user_id" text NOT NULL,
	"workspace_id" text,
	"seq" integer NOT NULL,
	"operation_id" text,
	"status" text DEFAULT 'running' NOT NULL,
	"trigger" text,
	"handoff" jsonb,
	"review_passed" integer,
	"review_score" integer,
	"review_scores" jsonb,
	"review_iteration" integer,
	"reviewed_at" timestamp with time zone,
	"visibility" text DEFAULT 'public' NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"seq" integer NOT NULL,
	"created_by_user_id" text NOT NULL,
	"workspace_id" text,
	"created_by_agent_id" text,
	"assignee_user_id" text,
	"assignee_agent_id" text,
	"parent_task_id" text,
	"name" text,
	"description" varchar(255),
	"instruction" text NOT NULL,
	"editor_data" jsonb,
	"status" text DEFAULT 'backlog' NOT NULL,
	"priority" integer DEFAULT 0,
	"sort_order" integer DEFAULT 0,
	"automation_mode" text,
	"heartbeat_interval" integer,
	"heartbeat_timeout" integer,
	"last_heartbeat_at" timestamp with time zone,
	"schedule_pattern" text,
	"schedule_timezone" text DEFAULT 'UTC',
	"total_topics" integer DEFAULT 0,
	"max_topics" integer,
	"current_topic_id" text,
	"context" jsonb DEFAULT '{}'::jsonb,
	"config" jsonb DEFAULT '{}'::jsonb,
	"error" text,
	"visibility" text DEFAULT 'public' NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text,
	"content" text,
	"editor_data" jsonb,
	"type" text NOT NULL,
	"status" text,
	"topic_id" text NOT NULL,
	"source_message_id" text,
	"parent_thread_id" text,
	"client_id" text,
	"agent_id" text,
	"group_id" text,
	"metadata" jsonb,
	"user_id" text NOT NULL,
	"last_active_at" timestamp with time zone DEFAULT now(),
	"workspace_id" text,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "topic_documents" (
	"document_id" text NOT NULL,
	"topic_id" text NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "topic_documents_document_id_topic_id_pk" PRIMARY KEY("document_id","topic_id")
);
--> statement-breakpoint
CREATE TABLE "topic_shares" (
	"id" text PRIMARY KEY NOT NULL,
	"topic_id" text NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text,
	"visibility" text DEFAULT 'private' NOT NULL,
	"page_view_count" integer DEFAULT 0 NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "topics" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text,
	"favorite" boolean DEFAULT false,
	"session_id" text,
	"content" text,
	"editor_data" jsonb,
	"agent_id" text,
	"group_id" text,
	"user_id" text NOT NULL,
	"client_id" text,
	"description" text,
	"history_summary" text,
	"metadata" jsonb,
	"trigger" text,
	"mode" text,
	"status" text,
	"completed_at" timestamp with time zone,
	"total_cost" numeric(20, 6),
	"total_input_tokens" integer,
	"total_output_tokens" integer,
	"total_tokens" integer,
	"cost" jsonb,
	"usage" jsonb,
	"model" text,
	"provider" text,
	"sender_id" text,
	"workspace_id" text,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"tts" jsonb,
	"hotkey" jsonb,
	"key_vaults" text,
	"general" jsonb,
	"language_model" jsonb,
	"system_agent" jsonb,
	"default_agent" jsonb,
	"market" jsonb,
	"memory" jsonb,
	"tool" jsonb,
	"image" jsonb,
	"notification" jsonb
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"username" text,
	"email" text,
	"normalized_email" text,
	"avatar" text,
	"phone" text,
	"first_name" text,
	"last_name" text,
	"full_name" text,
	"interests" varchar(64)[],
	"is_onboarded" boolean DEFAULT false,
	"agent_onboarding" jsonb,
	"onboarding" jsonb,
	"clerk_created_at" timestamp with time zone,
	"email_verified" boolean DEFAULT false NOT NULL,
	"email_verified_at" timestamp with time zone,
	"preference" jsonb,
	"role" text,
	"banned" boolean DEFAULT false,
	"ban_reason" text,
	"ban_expires" timestamp with time zone,
	"auth_invalidated_at" timestamp with time zone,
	"auth_invalidated_excluded_session_id" text,
	"dingtalk_title" text,
	"dingtalk_user_id" text,
	"two_factor_enabled" boolean DEFAULT false,
	"phone_number_verified" boolean,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username"),
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_normalized_email_unique" UNIQUE("normalized_email"),
	CONSTRAINT "users_phone_unique" UNIQUE("phone")
);
--> statement-breakpoint
CREATE TABLE "user_memories" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"user_id" text,
	"memory_category" varchar(255),
	"memory_layer" varchar(255),
	"memory_type" varchar(255),
	"metadata" jsonb,
	"tags" text[],
	"title" varchar(255),
	"summary" text,
	"summary_vector_1024" vector(1024),
	"details" text,
	"details_vector_1024" vector(1024),
	"status" varchar(255),
	"accessed_count" bigint DEFAULT 0,
	"last_accessed_at" timestamp with time zone NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_memories_activities" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"user_id" text,
	"user_memory_id" varchar(255),
	"metadata" jsonb,
	"tags" text[],
	"type" varchar(255) NOT NULL,
	"status" varchar(255) DEFAULT 'pending' NOT NULL,
	"timezone" varchar(255),
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"associated_objects" jsonb,
	"associated_subjects" jsonb,
	"associated_locations" jsonb,
	"notes" text,
	"narrative" text,
	"narrative_vector" vector(1024),
	"feedback" text,
	"feedback_vector" vector(1024),
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_memories_contexts" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"user_id" text,
	"user_memory_ids" jsonb,
	"metadata" jsonb,
	"tags" text[],
	"associated_objects" jsonb,
	"associated_subjects" jsonb,
	"title" text,
	"description" text,
	"description_vector" vector(1024),
	"type" varchar(255),
	"current_status" text,
	"score_impact" numeric DEFAULT 0,
	"score_urgency" numeric DEFAULT 0,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_memories_experiences" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"user_id" text,
	"user_memory_id" varchar(255),
	"metadata" jsonb,
	"tags" text[],
	"type" varchar(255),
	"situation" text,
	"situation_vector" vector(1024),
	"reasoning" text,
	"possible_outcome" text,
	"action" text,
	"action_vector" vector(1024),
	"key_learning" text,
	"key_learning_vector" vector(1024),
	"score_confidence" real DEFAULT 0,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_memories_identities" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"user_id" text,
	"user_memory_id" varchar(255),
	"metadata" jsonb,
	"tags" text[],
	"type" varchar(255),
	"description" text,
	"description_vector" vector(1024),
	"episodic_date" timestamp with time zone,
	"relationship" varchar(255),
	"role" text,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_memories_preferences" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"user_id" text,
	"user_memory_id" varchar(255),
	"metadata" jsonb,
	"tags" text[],
	"conclusion_directives" text,
	"conclusion_directives_vector" vector(1024),
	"type" varchar(255),
	"suggestions" text,
	"score_priority" numeric DEFAULT 0,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_memory_persona_document_histories" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"user_id" text,
	"persona_id" varchar(255),
	"profile" varchar(255) DEFAULT 'default' NOT NULL,
	"snapshot_persona" text,
	"snapshot_tagline" text,
	"reasoning" text,
	"diff_persona" text,
	"diff_tagline" text,
	"snapshot" text,
	"summary" text,
	"edited_by" varchar(255) DEFAULT 'agent',
	"memory_ids" jsonb,
	"source_ids" jsonb,
	"metadata" jsonb,
	"previous_version" integer,
	"next_version" integer,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_memory_persona_documents" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"user_id" text,
	"profile" varchar(255) DEFAULT 'default' NOT NULL,
	"tagline" text,
	"persona" text,
	"memory_ids" jsonb,
	"source_ids" jsonb,
	"metadata" jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verify_check_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"verify_run_id" uuid,
	"operation_id" text,
	"user_id" text NOT NULL,
	"workspace_id" text,
	"check_item_id" text NOT NULL,
	"check_item_title" text,
	"required" boolean DEFAULT true NOT NULL,
	"check_item_index" integer,
	"verifier_type" text NOT NULL,
	"verifier_config_hash" text,
	"verifier_operation_id" text,
	"verifier_tracing_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"verdict" text,
	"confidence" numeric(3, 2),
	"toulmin" jsonb,
	"metadata" jsonb,
	"suggestion" text,
	"user_decision" text,
	"is_false_positive" boolean,
	"is_false_negative" boolean,
	"repair_operation_id" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verify_criteria" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"required" boolean DEFAULT true NOT NULL,
	"verifier_type" text NOT NULL,
	"verifier_config" jsonb DEFAULT '{}'::jsonb,
	"on_fail" text DEFAULT 'manual' NOT NULL,
	"document_id" varchar(255),
	"workspace_id" text,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verify_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"description" text,
	"check_result_id" uuid NOT NULL,
	"type" text NOT NULL,
	"content" text,
	"file_id" text,
	"metadata" jsonb,
	"captured_by" text,
	"captured_at" timestamp with time zone,
	"user_id" text NOT NULL,
	"workspace_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verify_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"verify_run_id" uuid,
	"operation_id" text,
	"user_id" text NOT NULL,
	"workspace_id" text,
	"verdict" text,
	"overall_confidence" numeric(3, 2),
	"total_checks" integer,
	"passed_checks" integer,
	"failed_checks" integer,
	"uncertain_checks" integer,
	"summary" text,
	"content" text,
	"reviewed_by_user" boolean DEFAULT false,
	"generated_by" text DEFAULT 'system',
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verify_rubric_criteria" (
	"rubric_id" uuid NOT NULL,
	"criterion_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text,
	"sort_order" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verify_rubric_criteria_rubric_id_criterion_id_pk" PRIMARY KEY("rubric_id","criterion_id")
);
--> statement-breakpoint
CREATE TABLE "verify_rubrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"config" jsonb DEFAULT '{}'::jsonb,
	"workspace_id" text,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verify_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text,
	"operation_id" text,
	"source" text DEFAULT 'agent' NOT NULL,
	"scenario" text,
	"title" text,
	"goal" text,
	"context" jsonb,
	"metadata" jsonb,
	"plan" jsonb,
	"plan_confirmed_at" timestamp with time zone,
	"status" text,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_audit_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text,
	"action" text NOT NULL,
	"resource_type" text,
	"resource_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"ip_address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"inviter_id" text NOT NULL,
	"email" text,
	"role" text DEFAULT 'member' NOT NULL,
	"token" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_invitations_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "workspace_members" (
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "workspace_members_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" varchar(100) NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" varchar(1000),
	"avatar" text,
	"primary_owner_id" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb,
	"frozen" boolean DEFAULT false,
	"frozen_reason" text,
	"frozen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_session_group_id_session_groups_id_fk" FOREIGN KEY ("session_group_id") REFERENCES "public"."session_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents_files" ADD CONSTRAINT "agents_files_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents_files" ADD CONSTRAINT "agents_files_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents_files" ADD CONSTRAINT "agents_files_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents_files" ADD CONSTRAINT "agents_files_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents_knowledge_bases" ADD CONSTRAINT "agents_knowledge_bases_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents_knowledge_bases" ADD CONSTRAINT "agents_knowledge_bases_knowledge_base_id_knowledge_bases_id_fk" FOREIGN KEY ("knowledge_base_id") REFERENCES "public"."knowledge_bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents_knowledge_bases" ADD CONSTRAINT "agents_knowledge_bases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents_knowledge_bases" ADD CONSTRAINT "agents_knowledge_bases_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_bot_providers" ADD CONSTRAINT "agent_bot_providers_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_bot_providers" ADD CONSTRAINT "agent_bot_providers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_bot_providers" ADD CONSTRAINT "agent_bot_providers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_cron_jobs" ADD CONSTRAINT "agent_cron_jobs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_cron_jobs" ADD CONSTRAINT "agent_cron_jobs_group_id_chat_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."chat_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_cron_jobs" ADD CONSTRAINT "agent_cron_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_cron_jobs" ADD CONSTRAINT "agent_cron_jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_documents" ADD CONSTRAINT "agent_documents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_documents" ADD CONSTRAINT "agent_documents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_documents" ADD CONSTRAINT "agent_documents_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_documents" ADD CONSTRAINT "agent_documents_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_documents" ADD CONSTRAINT "agent_documents_deleted_by_user_id_users_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_documents" ADD CONSTRAINT "agent_documents_deleted_by_agent_id_agents_id_fk" FOREIGN KEY ("deleted_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_eval_benchmarks" ADD CONSTRAINT "agent_eval_benchmarks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_eval_benchmarks" ADD CONSTRAINT "agent_eval_benchmarks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_eval_datasets" ADD CONSTRAINT "agent_eval_datasets_benchmark_id_agent_eval_benchmarks_id_fk" FOREIGN KEY ("benchmark_id") REFERENCES "public"."agent_eval_benchmarks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_eval_datasets" ADD CONSTRAINT "agent_eval_datasets_source_experiment_id_agent_eval_experiments_id_fk" FOREIGN KEY ("source_experiment_id") REFERENCES "public"."agent_eval_experiments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_eval_datasets" ADD CONSTRAINT "agent_eval_datasets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_eval_datasets" ADD CONSTRAINT "agent_eval_datasets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_eval_experiment_benchmarks" ADD CONSTRAINT "agent_eval_experiment_benchmarks_experiment_id_agent_eval_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."agent_eval_experiments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_eval_experiment_benchmarks" ADD CONSTRAINT "agent_eval_experiment_benchmarks_benchmark_id_agent_eval_benchmarks_id_fk" FOREIGN KEY ("benchmark_id") REFERENCES "public"."agent_eval_benchmarks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_eval_experiment_benchmarks" ADD CONSTRAINT "agent_eval_experiment_benchmarks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_eval_experiment_benchmarks" ADD CONSTRAINT "agent_eval_experiment_benchmarks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_eval_experiments" ADD CONSTRAINT "agent_eval_experiments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_eval_experiments" ADD CONSTRAINT "agent_eval_experiments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_eval_run_topics" ADD CONSTRAINT "agent_eval_run_topics_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_eval_run_topics" ADD CONSTRAINT "agent_eval_run_topics_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_eval_run_topics" ADD CONSTRAINT "agent_eval_run_topics_run_id_agent_eval_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_eval_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_eval_run_topics" ADD CONSTRAINT "agent_eval_run_topics_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_eval_run_topics" ADD CONSTRAINT "agent_eval_run_topics_test_case_id_agent_eval_test_cases_id_fk" FOREIGN KEY ("test_case_id") REFERENCES "public"."agent_eval_test_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_eval_runs" ADD CONSTRAINT "agent_eval_runs_dataset_id_agent_eval_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."agent_eval_datasets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_eval_runs" ADD CONSTRAINT "agent_eval_runs_experiment_id_agent_eval_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."agent_eval_experiments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_eval_runs" ADD CONSTRAINT "agent_eval_runs_target_agent_id_agents_id_fk" FOREIGN KEY ("target_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_eval_runs" ADD CONSTRAINT "agent_eval_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_eval_runs" ADD CONSTRAINT "agent_eval_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_eval_runs" ADD CONSTRAINT "agent_eval_runs_parent_run_id_agent_eval_runs_id_fk" FOREIGN KEY ("parent_run_id") REFERENCES "public"."agent_eval_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_eval_test_cases" ADD CONSTRAINT "agent_eval_test_cases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_eval_test_cases" ADD CONSTRAINT "agent_eval_test_cases_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_eval_test_cases" ADD CONSTRAINT "agent_eval_test_cases_dataset_id_agent_eval_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."agent_eval_datasets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_operations" ADD CONSTRAINT "agent_operations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_operations" ADD CONSTRAINT "agent_operations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_operations" ADD CONSTRAINT "agent_operations_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_operations" ADD CONSTRAINT "agent_operations_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_operations" ADD CONSTRAINT "agent_operations_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_operations" ADD CONSTRAINT "agent_operations_chat_group_id_chat_groups_id_fk" FOREIGN KEY ("chat_group_id") REFERENCES "public"."chat_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_shares" ADD CONSTRAINT "agent_shares_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_zip_file_hash_global_files_hash_id_fk" FOREIGN KEY ("zip_file_hash") REFERENCES "public"."global_files"("hash_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_models" ADD CONSTRAINT "ai_models_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_models" ADD CONSTRAINT "ai_models_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_providers" ADD CONSTRAINT "ai_providers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_providers" ADD CONSTRAINT "ai_providers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "async_tasks" ADD CONSTRAINT "async_tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "async_tasks" ADD CONSTRAINT "async_tasks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkey" ADD CONSTRAINT "passkey_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_groups" ADD CONSTRAINT "chat_groups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_groups" ADD CONSTRAINT "chat_groups_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_groups" ADD CONSTRAINT "chat_groups_group_id_session_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."session_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_groups_agents" ADD CONSTRAINT "chat_groups_agents_chat_group_id_chat_groups_id_fk" FOREIGN KEY ("chat_group_id") REFERENCES "public"."chat_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_groups_agents" ADD CONSTRAINT "chat_groups_agents_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_groups_agents" ADD CONSTRAINT "chat_groups_agents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_groups_agents" ADD CONSTRAINT "chat_groups_agents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_connector_tools" ADD CONSTRAINT "user_connector_tools_user_connector_id_user_connectors_id_fk" FOREIGN KEY ("user_connector_id") REFERENCES "public"."user_connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_connector_tools" ADD CONSTRAINT "user_connector_tools_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_connector_tools" ADD CONSTRAINT "user_connector_tools_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_connectors" ADD CONSTRAINT "user_connectors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_connectors" ADD CONSTRAINT "user_connectors_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_connectors" ADD CONSTRAINT "user_connectors_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_installed_plugins" ADD CONSTRAINT "user_installed_plugins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_installed_plugins" ADD CONSTRAINT "user_installed_plugins_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_histories" ADD CONSTRAINT "document_histories_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_histories" ADD CONSTRAINT "document_histories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_histories" ADD CONSTRAINT "document_histories_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_shares" ADD CONSTRAINT "document_shares_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_shares" ADD CONSTRAINT "document_shares_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_shares" ADD CONSTRAINT "document_shares_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_knowledge_base_id_knowledge_bases_id_fk" FOREIGN KEY ("knowledge_base_id") REFERENCES "public"."knowledge_bases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_parent_id_documents_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_file_hash_global_files_hash_id_fk" FOREIGN KEY ("file_hash") REFERENCES "public"."global_files"("hash_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_parent_id_documents_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_chunk_task_id_async_tasks_id_fk" FOREIGN KEY ("chunk_task_id") REFERENCES "public"."async_tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_embedding_task_id_async_tasks_id_fk" FOREIGN KEY ("embedding_task_id") REFERENCES "public"."async_tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "global_files" ADD CONSTRAINT "global_files_creator_users_id_fk" FOREIGN KEY ("creator") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_base_files" ADD CONSTRAINT "knowledge_base_files_knowledge_base_id_knowledge_bases_id_fk" FOREIGN KEY ("knowledge_base_id") REFERENCES "public"."knowledge_bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_base_files" ADD CONSTRAINT "knowledge_base_files_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_base_files" ADD CONSTRAINT "knowledge_base_files_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_base_files" ADD CONSTRAINT "knowledge_base_files_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_bases" ADD CONSTRAINT "knowledge_bases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_bases" ADD CONSTRAINT "knowledge_bases_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_batches" ADD CONSTRAINT "generation_batches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_batches" ADD CONSTRAINT "generation_batches_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_batches" ADD CONSTRAINT "generation_batches_generation_topic_id_generation_topics_id_fk" FOREIGN KEY ("generation_topic_id") REFERENCES "public"."generation_topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_topics" ADD CONSTRAINT "generation_topics_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_topics" ADD CONSTRAINT "generation_topics_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generations" ADD CONSTRAINT "generations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generations" ADD CONSTRAINT "generations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generations" ADD CONSTRAINT "generations_generation_batch_id_generation_batches_id_fk" FOREIGN KEY ("generation_batch_id") REFERENCES "public"."generation_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generations" ADD CONSTRAINT "generations_async_task_id_async_tasks_id_fk" FOREIGN KEY ("async_task_id") REFERENCES "public"."async_tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generations" ADD CONSTRAINT "generations_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_generation_tracing" ADD CONSTRAINT "llm_generation_tracing_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_chunks" ADD CONSTRAINT "message_chunks_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_chunks" ADD CONSTRAINT "message_chunks_chunk_id_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."chunks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_chunks" ADD CONSTRAINT "message_chunks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_chunks" ADD CONSTRAINT "message_chunks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_groups" ADD CONSTRAINT "message_groups_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_groups" ADD CONSTRAINT "message_groups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_groups" ADD CONSTRAINT "message_groups_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_groups" ADD CONSTRAINT "message_groups_parent_group_id_message_groups_id_fk" FOREIGN KEY ("parent_group_id") REFERENCES "public"."message_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_groups" ADD CONSTRAINT "message_groups_parent_message_id_messages_id_fk" FOREIGN KEY ("parent_message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_plugins" ADD CONSTRAINT "message_plugins_id_messages_id_fk" FOREIGN KEY ("id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_plugins" ADD CONSTRAINT "message_plugins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_plugins" ADD CONSTRAINT "message_plugins_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_queries" ADD CONSTRAINT "message_queries_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_queries" ADD CONSTRAINT "message_queries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_queries" ADD CONSTRAINT "message_queries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_queries" ADD CONSTRAINT "message_queries_embeddings_id_embeddings_id_fk" FOREIGN KEY ("embeddings_id") REFERENCES "public"."embeddings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_query_chunks" ADD CONSTRAINT "message_query_chunks_id_messages_id_fk" FOREIGN KEY ("id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_query_chunks" ADD CONSTRAINT "message_query_chunks_query_id_message_queries_id_fk" FOREIGN KEY ("query_id") REFERENCES "public"."message_queries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_query_chunks" ADD CONSTRAINT "message_query_chunks_chunk_id_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."chunks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_query_chunks" ADD CONSTRAINT "message_query_chunks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_query_chunks" ADD CONSTRAINT "message_query_chunks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_tts" ADD CONSTRAINT "message_tts_id_messages_id_fk" FOREIGN KEY ("id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_tts" ADD CONSTRAINT "message_tts_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_tts" ADD CONSTRAINT "message_tts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_tts" ADD CONSTRAINT "message_tts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_translates" ADD CONSTRAINT "message_translates_id_messages_id_fk" FOREIGN KEY ("id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_translates" ADD CONSTRAINT "message_translates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_translates" ADD CONSTRAINT "message_translates_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_parent_id_messages_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_quota_id_messages_id_fk" FOREIGN KEY ("quota_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_group_id_chat_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."chat_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_message_group_id_message_groups_id_fk" FOREIGN KEY ("message_group_id") REFERENCES "public"."message_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages_files" ADD CONSTRAINT "messages_files_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages_files" ADD CONSTRAINT "messages_files_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages_files" ADD CONSTRAINT "messages_files_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages_files" ADD CONSTRAINT "messages_files_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messenger_account_links" ADD CONSTRAINT "messenger_account_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messenger_account_links" ADD CONSTRAINT "messenger_account_links_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messenger_account_links" ADD CONSTRAINT "messenger_account_links_active_agent_id_agents_id_fk" FOREIGN KEY ("active_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messenger_installations" ADD CONSTRAINT "messenger_installations_installed_by_user_id_users_id_fk" FOREIGN KEY ("installed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nextauth_accounts" ADD CONSTRAINT "nextauth_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nextauth_authenticators" ADD CONSTRAINT "nextauth_authenticators_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nextauth_sessions" ADD CONSTRAINT "nextauth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_access_tokens" ADD CONSTRAINT "oidc_access_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_authorization_codes" ADD CONSTRAINT "oidc_authorization_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_consents" ADD CONSTRAINT "oidc_consents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_consents" ADD CONSTRAINT "oidc_consents_client_id_oidc_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oidc_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_device_codes" ADD CONSTRAINT "oidc_device_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_grants" ADD CONSTRAINT "oidc_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_refresh_tokens" ADD CONSTRAINT "oidc_refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_sessions" ADD CONSTRAINT "oidc_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Composite platform-Agent foreign keys below require their referenced unique
-- keys before PostgreSQL validates the constraints.
CREATE UNIQUE INDEX IF NOT EXISTS "platform_agent_versions_agent_id_id_unique"
  ON "platform_agent_versions" USING btree ("agent_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_agent_versions_agent_id_id_checksum_unique"
  ON "platform_agent_versions" USING btree ("agent_id","id","checksum");--> statement-breakpoint
ALTER TABLE "platform_agent_assignments" ADD CONSTRAINT "platform_agent_assignments_agent_id_platform_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."platform_agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_agent_assignments" ADD CONSTRAINT "platform_agent_assignments_pinned_version_same_agent_fk" FOREIGN KEY ("agent_id","pinned_version_id") REFERENCES "public"."platform_agent_versions"("agent_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_agent_versions" ADD CONSTRAINT "platform_agent_versions_agent_id_platform_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."platform_agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_agents" ADD CONSTRAINT "platform_agents_current_version_same_agent_fk" FOREIGN KEY ("id","current_version_id") REFERENCES "public"."platform_agent_versions"("agent_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_user_agent_materialization_tombstones" ADD CONSTRAINT "platform_user_agent_materialization_tombstones_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_user_agent_materialization_tombstones" ADD CONSTRAINT "platform_user_agent_materialization_tombstones_materialized_agent_id_agents_id_fk" FOREIGN KEY ("materialized_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_user_agent_materializations" ADD CONSTRAINT "platform_user_agent_materializations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_user_agent_materializations" ADD CONSTRAINT "platform_user_agent_materializations_platform_agent_id_platform_agents_id_fk" FOREIGN KEY ("platform_agent_id") REFERENCES "public"."platform_agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_user_agent_materializations" ADD CONSTRAINT "platform_user_agent_materializations_materialized_agent_id_agents_id_fk" FOREIGN KEY ("materialized_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_user_agent_materializations" ADD CONSTRAINT "platform_user_agent_materializations_exact_version_fk" FOREIGN KEY ("platform_agent_id","platform_agent_version_id","platform_agent_version_checksum") REFERENCES "public"."platform_agent_versions"("agent_id","id","checksum") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_ai_models" ADD CONSTRAINT "platform_ai_models_provider_id_platform_ai_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."platform_ai_providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_ai_provider_secrets" ADD CONSTRAINT "platform_ai_provider_secrets_provider_id_platform_ai_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."platform_ai_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_branding_assets" ADD CONSTRAINT "platform_branding_assets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Additional composite FK targets must likewise exist before their ALTERs.
CREATE UNIQUE INDEX IF NOT EXISTS "platform_user_connector_bindings_oauth_state_owner_unique"
  ON "platform_user_connector_bindings" USING btree ("id","user_id","connector_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_resource_revisions_type_id_revision_unique"
  ON "platform_resource_revisions" USING btree ("resource_type","resource_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_resource_revisions_type_id_revision_checksum_unique"
  ON "platform_resource_revisions" USING btree ("resource_type","resource_id","revision","checksum");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_skill_versions_skill_id_id_unique"
  ON "platform_skill_versions" USING btree ("skill_id","id");--> statement-breakpoint
ALTER TABLE "platform_connector_oauth_states" ADD CONSTRAINT "platform_connector_oauth_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_connector_oauth_states" ADD CONSTRAINT "platform_connector_oauth_states_connector_id_platform_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."platform_connectors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_connector_oauth_states" ADD CONSTRAINT "platform_connector_oauth_states_binding_owner_fk" FOREIGN KEY ("binding_id","user_id","connector_id") REFERENCES "public"."platform_user_connector_bindings"("id","user_id","connector_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_connector_oauth_states" ADD CONSTRAINT "platform_connector_oauth_states_revision_fk" FOREIGN KEY ("revision_resource_type","connector_id","published_revision") REFERENCES "public"."platform_resource_revisions"("resource_type","resource_id","revision") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_connector_secrets" ADD CONSTRAINT "platform_connector_secrets_connector_id_platform_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."platform_connectors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_connector_tools" ADD CONSTRAINT "platform_connector_tools_connector_id_platform_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."platform_connectors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_connectors" ADD CONSTRAINT "platform_connectors_published_revision_fk" FOREIGN KEY ("published_resource_type","id","published_revision","published_checksum") REFERENCES "public"."platform_resource_revisions"("resource_type","resource_id","revision","checksum") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_user_connector_bindings" ADD CONSTRAINT "platform_user_connector_bindings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_user_connector_bindings" ADD CONSTRAINT "platform_user_connector_bindings_connector_id_platform_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."platform_connectors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_user_connector_bindings" ADD CONSTRAINT "platform_user_connector_bindings_revision_fk" FOREIGN KEY ("revision_resource_type","connector_id","published_revision") REFERENCES "public"."platform_resource_revisions"("resource_type","resource_id","revision") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_global_credential_secrets" ADD CONSTRAINT "platform_global_credential_secrets_credential_id_platform_global_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."platform_global_credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_identity_provider_restart_requests" ADD CONSTRAINT "platform_identity_provider_restart_requests_target_instance_id_platform_identity_provider_instances_instance_id_fk" FOREIGN KEY ("target_instance_id") REFERENCES "public"."platform_identity_provider_instances"("instance_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_identity_provider_secrets" ADD CONSTRAINT "platform_identity_provider_secrets_provider_id_platform_identity_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."platform_identity_providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_identity_provider_test_attempts" ADD CONSTRAINT "platform_identity_provider_test_attempts_provider_id_platform_identity_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."platform_identity_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_instance_revision_states" ADD CONSTRAINT "platform_instance_revision_states_instance_id_platform_instance_heartbeats_instance_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."platform_instance_heartbeats"("instance_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_setting_override_revisions" ADD CONSTRAINT "user_setting_override_revisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_setting_overrides" ADD CONSTRAINT "user_setting_overrides_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_skill_versions" ADD CONSTRAINT "platform_skill_versions_skill_id_platform_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."platform_skills"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_skills" ADD CONSTRAINT "platform_skills_current_version_same_skill_fk" FOREIGN KEY ("id","current_version_id") REFERENCES "public"."platform_skill_versions"("skill_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_tokens" ADD CONSTRAINT "push_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_chunk_id_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."chunks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embeddings" ADD CONSTRAINT "embeddings_chunk_id_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."chunks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embeddings" ADD CONSTRAINT "embeddings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embeddings" ADD CONSTRAINT "embeddings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unstructured_chunks" ADD CONSTRAINT "unstructured_chunks_composite_id_chunks_id_fk" FOREIGN KEY ("composite_id") REFERENCES "public"."chunks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unstructured_chunks" ADD CONSTRAINT "unstructured_chunks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unstructured_chunks" ADD CONSTRAINT "unstructured_chunks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unstructured_chunks" ADD CONSTRAINT "unstructured_chunks_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag_eval_dataset_records" ADD CONSTRAINT "rag_eval_dataset_records_dataset_id_rag_eval_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."rag_eval_datasets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag_eval_dataset_records" ADD CONSTRAINT "rag_eval_dataset_records_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag_eval_dataset_records" ADD CONSTRAINT "rag_eval_dataset_records_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag_eval_datasets" ADD CONSTRAINT "rag_eval_datasets_knowledge_base_id_knowledge_bases_id_fk" FOREIGN KEY ("knowledge_base_id") REFERENCES "public"."knowledge_bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag_eval_datasets" ADD CONSTRAINT "rag_eval_datasets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag_eval_datasets" ADD CONSTRAINT "rag_eval_datasets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag_eval_evaluations" ADD CONSTRAINT "rag_eval_evaluations_dataset_id_rag_eval_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."rag_eval_datasets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag_eval_evaluations" ADD CONSTRAINT "rag_eval_evaluations_knowledge_base_id_knowledge_bases_id_fk" FOREIGN KEY ("knowledge_base_id") REFERENCES "public"."knowledge_bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag_eval_evaluations" ADD CONSTRAINT "rag_eval_evaluations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag_eval_evaluations" ADD CONSTRAINT "rag_eval_evaluations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag_eval_evaluation_records" ADD CONSTRAINT "rag_eval_evaluation_records_question_embedding_id_embeddings_id_fk" FOREIGN KEY ("question_embedding_id") REFERENCES "public"."embeddings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag_eval_evaluation_records" ADD CONSTRAINT "rag_eval_evaluation_records_dataset_record_id_rag_eval_dataset_records_id_fk" FOREIGN KEY ("dataset_record_id") REFERENCES "public"."rag_eval_dataset_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag_eval_evaluation_records" ADD CONSTRAINT "rag_eval_evaluation_records_evaluation_id_rag_eval_evaluations_id_fk" FOREIGN KEY ("evaluation_id") REFERENCES "public"."rag_eval_evaluations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag_eval_evaluation_records" ADD CONSTRAINT "rag_eval_evaluation_records_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag_eval_evaluation_records" ADD CONSTRAINT "rag_eval_evaluation_records_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rbac_role_permissions" ADD CONSTRAINT "rbac_role_permissions_role_id_rbac_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."rbac_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rbac_role_permissions" ADD CONSTRAINT "rbac_role_permissions_permission_id_rbac_permissions_id_fk" FOREIGN KEY ("permission_id") REFERENCES "public"."rbac_permissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rbac_roles" ADD CONSTRAINT "rbac_roles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rbac_user_roles" ADD CONSTRAINT "rbac_user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rbac_user_roles" ADD CONSTRAINT "rbac_user_roles_role_id_rbac_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."rbac_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rbac_user_roles" ADD CONSTRAINT "rbac_user_roles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents_to_sessions" ADD CONSTRAINT "agents_to_sessions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents_to_sessions" ADD CONSTRAINT "agents_to_sessions_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents_to_sessions" ADD CONSTRAINT "agents_to_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents_to_sessions" ADD CONSTRAINT "agents_to_sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_chunks" ADD CONSTRAINT "file_chunks_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_chunks" ADD CONSTRAINT "file_chunks_chunk_id_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."chunks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_chunks" ADD CONSTRAINT "file_chunks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_chunks" ADD CONSTRAINT "file_chunks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files_to_sessions" ADD CONSTRAINT "files_to_sessions_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files_to_sessions" ADD CONSTRAINT "files_to_sessions_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files_to_sessions" ADD CONSTRAINT "files_to_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files_to_sessions" ADD CONSTRAINT "files_to_sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_groups" ADD CONSTRAINT "session_groups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_groups" ADD CONSTRAINT "session_groups_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_group_id_session_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."session_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "briefs" ADD CONSTRAINT "briefs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "briefs" ADD CONSTRAINT "briefs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "briefs" ADD CONSTRAINT "briefs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "briefs" ADD CONSTRAINT "briefs_cron_job_id_agent_cron_jobs_id_fk" FOREIGN KEY ("cron_job_id") REFERENCES "public"."agent_cron_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_author_agent_id_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_brief_id_briefs_id_fk" FOREIGN KEY ("brief_id") REFERENCES "public"."briefs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_depends_on_id_tasks_id_fk" FOREIGN KEY ("depends_on_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_documents" ADD CONSTRAINT "task_documents_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_documents" ADD CONSTRAINT "task_documents_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_documents" ADD CONSTRAINT "task_documents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_documents" ADD CONSTRAINT "task_documents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_topics" ADD CONSTRAINT "task_topics_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_topics" ADD CONSTRAINT "task_topics_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_topics" ADD CONSTRAINT "task_topics_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_topics" ADD CONSTRAINT "task_topics_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_user_id_users_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_agent_id_agents_id_fk" FOREIGN KEY ("assignee_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_current_topic_id_topics_id_fk" FOREIGN KEY ("current_topic_id") REFERENCES "public"."topics"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_task_id_tasks_id_fk" FOREIGN KEY ("parent_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_parent_thread_id_threads_id_fk" FOREIGN KEY ("parent_thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_group_id_chat_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."chat_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_documents" ADD CONSTRAINT "topic_documents_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_documents" ADD CONSTRAINT "topic_documents_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_documents" ADD CONSTRAINT "topic_documents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_documents" ADD CONSTRAINT "topic_documents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_shares" ADD CONSTRAINT "topic_shares_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_shares" ADD CONSTRAINT "topic_shares_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_shares" ADD CONSTRAINT "topic_shares_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_group_id_chat_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."chat_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_id_users_id_fk" FOREIGN KEY ("id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_memories" ADD CONSTRAINT "user_memories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_memories_activities" ADD CONSTRAINT "user_memories_activities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_memories_activities" ADD CONSTRAINT "user_memories_activities_user_memory_id_user_memories_id_fk" FOREIGN KEY ("user_memory_id") REFERENCES "public"."user_memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_memories_contexts" ADD CONSTRAINT "user_memories_contexts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_memories_experiences" ADD CONSTRAINT "user_memories_experiences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_memories_experiences" ADD CONSTRAINT "user_memories_experiences_user_memory_id_user_memories_id_fk" FOREIGN KEY ("user_memory_id") REFERENCES "public"."user_memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_memories_identities" ADD CONSTRAINT "user_memories_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_memories_identities" ADD CONSTRAINT "user_memories_identities_user_memory_id_user_memories_id_fk" FOREIGN KEY ("user_memory_id") REFERENCES "public"."user_memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_memories_preferences" ADD CONSTRAINT "user_memories_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_memories_preferences" ADD CONSTRAINT "user_memories_preferences_user_memory_id_user_memories_id_fk" FOREIGN KEY ("user_memory_id") REFERENCES "public"."user_memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_memory_persona_document_histories" ADD CONSTRAINT "user_memory_persona_document_histories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_memory_persona_document_histories" ADD CONSTRAINT "user_memory_persona_document_histories_persona_id_user_memory_persona_documents_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."user_memory_persona_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_memory_persona_documents" ADD CONSTRAINT "user_memory_persona_documents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verify_check_results" ADD CONSTRAINT "verify_check_results_verify_run_id_verify_runs_id_fk" FOREIGN KEY ("verify_run_id") REFERENCES "public"."verify_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verify_check_results" ADD CONSTRAINT "verify_check_results_operation_id_agent_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."agent_operations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verify_check_results" ADD CONSTRAINT "verify_check_results_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verify_check_results" ADD CONSTRAINT "verify_check_results_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verify_check_results" ADD CONSTRAINT "verify_check_results_verifier_operation_id_agent_operations_id_fk" FOREIGN KEY ("verifier_operation_id") REFERENCES "public"."agent_operations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verify_check_results" ADD CONSTRAINT "verify_check_results_verifier_tracing_id_llm_generation_tracing_id_fk" FOREIGN KEY ("verifier_tracing_id") REFERENCES "public"."llm_generation_tracing"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verify_check_results" ADD CONSTRAINT "verify_check_results_repair_operation_id_agent_operations_id_fk" FOREIGN KEY ("repair_operation_id") REFERENCES "public"."agent_operations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verify_criteria" ADD CONSTRAINT "verify_criteria_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verify_criteria" ADD CONSTRAINT "verify_criteria_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verify_criteria" ADD CONSTRAINT "verify_criteria_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verify_evidence" ADD CONSTRAINT "verify_evidence_check_result_id_verify_check_results_id_fk" FOREIGN KEY ("check_result_id") REFERENCES "public"."verify_check_results"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verify_evidence" ADD CONSTRAINT "verify_evidence_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verify_evidence" ADD CONSTRAINT "verify_evidence_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verify_evidence" ADD CONSTRAINT "verify_evidence_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verify_reports" ADD CONSTRAINT "verify_reports_verify_run_id_verify_runs_id_fk" FOREIGN KEY ("verify_run_id") REFERENCES "public"."verify_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verify_reports" ADD CONSTRAINT "verify_reports_operation_id_agent_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."agent_operations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verify_reports" ADD CONSTRAINT "verify_reports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verify_reports" ADD CONSTRAINT "verify_reports_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verify_rubric_criteria" ADD CONSTRAINT "verify_rubric_criteria_rubric_id_verify_rubrics_id_fk" FOREIGN KEY ("rubric_id") REFERENCES "public"."verify_rubrics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verify_rubric_criteria" ADD CONSTRAINT "verify_rubric_criteria_criterion_id_verify_criteria_id_fk" FOREIGN KEY ("criterion_id") REFERENCES "public"."verify_criteria"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verify_rubric_criteria" ADD CONSTRAINT "verify_rubric_criteria_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verify_rubric_criteria" ADD CONSTRAINT "verify_rubric_criteria_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verify_rubrics" ADD CONSTRAINT "verify_rubrics_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verify_rubrics" ADD CONSTRAINT "verify_rubrics_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verify_runs" ADD CONSTRAINT "verify_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verify_runs" ADD CONSTRAINT "verify_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verify_runs" ADD CONSTRAINT "verify_runs_operation_id_agent_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."agent_operations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_audit_logs" ADD CONSTRAINT "workspace_audit_logs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_inviter_id_users_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_primary_owner_id_users_id_fk" FOREIGN KEY ("primary_owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "client_id_user_id_unique" ON "agents" USING btree ("client_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_slug_user_id_unique" ON "agents" USING btree ("slug","user_id") WHERE "agents"."workspace_id" is null;--> statement-breakpoint
CREATE INDEX "agents_user_id_idx" ON "agents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "agents_title_idx" ON "agents" USING btree ("title");--> statement-breakpoint
CREATE INDEX "agents_description_idx" ON "agents" USING btree ("description");--> statement-breakpoint
CREATE INDEX "agents_session_group_id_idx" ON "agents" USING btree ("session_group_id");--> statement-breakpoint
CREATE INDEX "agents_workspace_id_idx" ON "agents" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "agents_workspace_visibility_idx" ON "agents" USING btree ("workspace_id","visibility","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_slug_workspace_id_unique" ON "agents" USING btree ("workspace_id","slug") WHERE "agents"."workspace_id" is not null;--> statement-breakpoint
CREATE INDEX "agents_files_agent_id_idx" ON "agents_files" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agents_files_file_id_idx" ON "agents_files" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "agents_files_user_id_idx" ON "agents_files" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "agents_files_workspace_id_idx" ON "agents_files" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "agents_knowledge_bases_agent_id_idx" ON "agents_knowledge_bases" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agents_knowledge_bases_knowledge_base_id_idx" ON "agents_knowledge_bases" USING btree ("knowledge_base_id");--> statement-breakpoint
CREATE INDEX "agents_knowledge_bases_user_id_idx" ON "agents_knowledge_bases" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "agents_knowledge_bases_workspace_id_idx" ON "agents_knowledge_bases" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_bot_providers_platform_app_id_unique" ON "agent_bot_providers" USING btree ("platform","application_id");--> statement-breakpoint
CREATE INDEX "agent_bot_providers_platform_idx" ON "agent_bot_providers" USING btree ("platform");--> statement-breakpoint
CREATE INDEX "agent_bot_providers_agent_id_idx" ON "agent_bot_providers" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_bot_providers_user_id_idx" ON "agent_bot_providers" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "agent_bot_providers_workspace_id_idx" ON "agent_bot_providers" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "agent_cron_jobs_agent_id_idx" ON "agent_cron_jobs" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_cron_jobs_group_id_idx" ON "agent_cron_jobs" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "agent_cron_jobs_user_id_idx" ON "agent_cron_jobs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "agent_cron_jobs_workspace_id_idx" ON "agent_cron_jobs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "agent_cron_jobs_enabled_idx" ON "agent_cron_jobs" USING btree ("enabled");--> statement-breakpoint
CREATE INDEX "agent_cron_jobs_remaining_executions_idx" ON "agent_cron_jobs" USING btree ("remaining_executions");--> statement-breakpoint
CREATE INDEX "agent_cron_jobs_last_executed_at_idx" ON "agent_cron_jobs" USING btree ("last_executed_at");--> statement-breakpoint
CREATE INDEX "agent_documents_workspace_id_idx" ON "agent_documents" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "agent_documents_user_id_idx" ON "agent_documents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "agent_documents_agent_id_idx" ON "agent_documents" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_documents_access_self_idx" ON "agent_documents" USING btree ("access_self");--> statement-breakpoint
CREATE INDEX "agent_documents_access_shared_idx" ON "agent_documents" USING btree ("access_shared");--> statement-breakpoint
CREATE INDEX "agent_documents_access_public_idx" ON "agent_documents" USING btree ("access_public");--> statement-breakpoint
CREATE INDEX "agent_documents_policy_load_idx" ON "agent_documents" USING btree ("policy_load");--> statement-breakpoint
CREATE INDEX "agent_documents_template_id_idx" ON "agent_documents" USING btree ("template_id");--> statement-breakpoint
CREATE INDEX "agent_documents_policy_load_position_idx" ON "agent_documents" USING btree ("policy_load_position");--> statement-breakpoint
CREATE INDEX "agent_documents_policy_load_format_idx" ON "agent_documents" USING btree ("policy_load_format");--> statement-breakpoint
CREATE INDEX "agent_documents_policy_load_rule_idx" ON "agent_documents" USING btree ("policy_load_rule");--> statement-breakpoint
CREATE INDEX "agent_documents_agent_load_position_idx" ON "agent_documents" USING btree ("agent_id","policy_load_position");--> statement-breakpoint
CREATE INDEX "agent_documents_deleted_at_idx" ON "agent_documents" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "agent_documents_agent_autoload_deleted_idx" ON "agent_documents" USING btree ("agent_id","deleted_at","policy_load");--> statement-breakpoint
CREATE INDEX "agent_documents_document_id_idx" ON "agent_documents" USING btree ("document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_documents_agent_document_user_unique" ON "agent_documents" USING btree ("agent_id","document_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_eval_benchmarks_identifier_user_id_unique" ON "agent_eval_benchmarks" USING btree ("identifier","user_id") WHERE "agent_eval_benchmarks"."workspace_id" is null;--> statement-breakpoint
CREATE INDEX "agent_eval_benchmarks_is_system_idx" ON "agent_eval_benchmarks" USING btree ("is_system");--> statement-breakpoint
CREATE INDEX "agent_eval_benchmarks_user_id_idx" ON "agent_eval_benchmarks" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "agent_eval_benchmarks_workspace_id_idx" ON "agent_eval_benchmarks" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_eval_benchmarks_identifier_workspace_id_unique" ON "agent_eval_benchmarks" USING btree ("workspace_id","identifier") WHERE "agent_eval_benchmarks"."workspace_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_eval_datasets_identifier_user_id_unique" ON "agent_eval_datasets" USING btree ("identifier","user_id") WHERE "agent_eval_datasets"."workspace_id" is null;--> statement-breakpoint
CREATE INDEX "agent_eval_datasets_benchmark_id_idx" ON "agent_eval_datasets" USING btree ("benchmark_id");--> statement-breakpoint
CREATE INDEX "agent_eval_datasets_source_experiment_id_idx" ON "agent_eval_datasets" USING btree ("source_experiment_id");--> statement-breakpoint
CREATE INDEX "agent_eval_datasets_user_id_idx" ON "agent_eval_datasets" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "agent_eval_datasets_workspace_id_idx" ON "agent_eval_datasets" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_eval_datasets_identifier_workspace_id_unique" ON "agent_eval_datasets" USING btree ("workspace_id","identifier") WHERE "agent_eval_datasets"."workspace_id" is not null;--> statement-breakpoint
CREATE INDEX "agent_eval_experiment_benchmarks_benchmark_id_idx" ON "agent_eval_experiment_benchmarks" USING btree ("benchmark_id");--> statement-breakpoint
CREATE INDEX "agent_eval_experiment_benchmarks_user_id_idx" ON "agent_eval_experiment_benchmarks" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "agent_eval_experiment_benchmarks_workspace_id_idx" ON "agent_eval_experiment_benchmarks" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "agent_eval_experiments_user_id_idx" ON "agent_eval_experiments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "agent_eval_experiments_workspace_id_idx" ON "agent_eval_experiments" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "agent_eval_run_topics_user_id_idx" ON "agent_eval_run_topics" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "agent_eval_run_topics_run_id_idx" ON "agent_eval_run_topics" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "agent_eval_run_topics_test_case_id_idx" ON "agent_eval_run_topics" USING btree ("test_case_id");--> statement-breakpoint
CREATE INDEX "agent_eval_run_topics_workspace_id_idx" ON "agent_eval_run_topics" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "agent_eval_runs_dataset_id_idx" ON "agent_eval_runs" USING btree ("dataset_id");--> statement-breakpoint
CREATE INDEX "agent_eval_runs_experiment_id_idx" ON "agent_eval_runs" USING btree ("experiment_id");--> statement-breakpoint
CREATE INDEX "agent_eval_runs_parent_run_id_idx" ON "agent_eval_runs" USING btree ("parent_run_id");--> statement-breakpoint
CREATE INDEX "agent_eval_runs_user_id_idx" ON "agent_eval_runs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "agent_eval_runs_status_idx" ON "agent_eval_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "agent_eval_runs_target_agent_id_idx" ON "agent_eval_runs" USING btree ("target_agent_id");--> statement-breakpoint
CREATE INDEX "agent_eval_runs_workspace_id_idx" ON "agent_eval_runs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "agent_eval_test_cases_user_id_idx" ON "agent_eval_test_cases" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "agent_eval_test_cases_dataset_id_idx" ON "agent_eval_test_cases" USING btree ("dataset_id");--> statement-breakpoint
CREATE INDEX "agent_eval_test_cases_sort_order_idx" ON "agent_eval_test_cases" USING btree ("sort_order");--> statement-breakpoint
CREATE INDEX "agent_eval_test_cases_workspace_id_idx" ON "agent_eval_test_cases" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "agent_operations_user_id_idx" ON "agent_operations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "agent_operations_workspace_id_idx" ON "agent_operations" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "agent_operations_agent_id_idx" ON "agent_operations" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_operations_topic_id_idx" ON "agent_operations" USING btree ("topic_id");--> statement-breakpoint
CREATE INDEX "agent_operations_thread_id_idx" ON "agent_operations" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "agent_operations_task_id_idx" ON "agent_operations" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "agent_operations_chat_group_id_idx" ON "agent_operations" USING btree ("chat_group_id");--> statement-breakpoint
CREATE INDEX "agent_operations_parent_operation_id_idx" ON "agent_operations" USING btree ("parent_operation_id");--> statement-breakpoint
CREATE INDEX "agent_operations_status_idx" ON "agent_operations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "agent_operations_user_id_created_at_idx" ON "agent_operations" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_operations_metadata_idx" ON "agent_operations" USING gin ("metadata");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_shares_agent_id_unique" ON "agent_shares" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_shares_visibility_idx" ON "agent_shares" USING btree ("visibility");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_skills_user_name_idx" ON "agent_skills" USING btree ("user_id","name") WHERE "agent_skills"."workspace_id" is null;--> statement-breakpoint
CREATE INDEX "agent_skills_identifier_idx" ON "agent_skills" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "agent_skills_user_id_idx" ON "agent_skills" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "agent_skills_source_idx" ON "agent_skills" USING btree ("source");--> statement-breakpoint
CREATE INDEX "agent_skills_zip_hash_idx" ON "agent_skills" USING btree ("zip_file_hash");--> statement-breakpoint
CREATE INDEX "agent_skills_workspace_id_idx" ON "agent_skills" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_skills_name_workspace_id_unique" ON "agent_skills" USING btree ("workspace_id","name") WHERE "agent_skills"."workspace_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_models_id_provider_id_user_id_unique" ON "ai_models" USING btree ("id","provider_id","user_id") WHERE "ai_models"."workspace_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_models_id_provider_id_user_id_workspace_id_unique" ON "ai_models" USING btree ("id","provider_id","user_id","workspace_id") WHERE "ai_models"."workspace_id" is not null;--> statement-breakpoint
CREATE INDEX "ai_models_user_id_idx" ON "ai_models" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ai_models_workspace_id_idx" ON "ai_models" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_providers_id_user_id_unique" ON "ai_providers" USING btree ("id","user_id") WHERE "ai_providers"."workspace_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_providers_id_user_id_workspace_id_unique" ON "ai_providers" USING btree ("id","user_id","workspace_id") WHERE "ai_providers"."workspace_id" is not null;--> statement-breakpoint
CREATE INDEX "ai_providers_user_id_idx" ON "ai_providers" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ai_providers_workspace_id_idx" ON "ai_providers" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "api_keys_user_id_idx" ON "api_keys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "api_keys_workspace_id_idx" ON "api_keys" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "async_tasks_user_id_idx" ON "async_tasks" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "async_tasks_parent_id_idx" ON "async_tasks" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "async_tasks_type_status_idx" ON "async_tasks" USING btree ("type","status");--> statement-breakpoint
CREATE INDEX "async_tasks_inference_id_idx" ON "async_tasks" USING btree ("inference_id");--> statement-breakpoint
CREATE INDEX "async_tasks_metadata_idx" ON "async_tasks" USING gin ("metadata");--> statement-breakpoint
CREATE INDEX "async_tasks_workspace_id_idx" ON "async_tasks" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "passkey_credential_id_unique" ON "passkey" USING btree ("credentialID");--> statement-breakpoint
CREATE INDEX "passkey_user_id_idx" ON "passkey" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "auth_session_userId_idx" ON "auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "two_factor_secret_idx" ON "two_factor" USING btree ("secret");--> statement-breakpoint
CREATE INDEX "two_factor_user_id_idx" ON "two_factor" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verifications" USING btree ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_groups_client_id_user_id_unique" ON "chat_groups" USING btree ("client_id","user_id");--> statement-breakpoint
CREATE INDEX "chat_groups_user_id_idx" ON "chat_groups" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "chat_groups_group_id_idx" ON "chat_groups" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "chat_groups_workspace_id_idx" ON "chat_groups" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "chat_groups_workspace_visibility_idx" ON "chat_groups" USING btree ("workspace_id","visibility","user_id");--> statement-breakpoint
CREATE INDEX "chat_groups_agents_user_id_idx" ON "chat_groups_agents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "chat_groups_agents_workspace_id_idx" ON "chat_groups_agents" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_connector_tools_connector_tool_unique" ON "user_connector_tools" USING btree ("user_connector_id","tool_name");--> statement-breakpoint
CREATE INDEX "user_connector_tools_user_id_idx" ON "user_connector_tools" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_connector_tools_connector_id_idx" ON "user_connector_tools" USING btree ("user_connector_id");--> statement-breakpoint
CREATE INDEX "user_connector_tools_workspace_id_idx" ON "user_connector_tools" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "user_connectors_personal_identifier_idx" ON "user_connectors" USING btree ("user_id","identifier") WHERE "user_connectors"."workspace_id" IS NULL AND "user_connectors"."agent_id" IS NULL;--> statement-breakpoint
CREATE INDEX "user_connectors_workspace_identifier_idx" ON "user_connectors" USING btree ("user_id","workspace_id","identifier") WHERE "user_connectors"."workspace_id" IS NOT NULL AND "user_connectors"."agent_id" IS NULL;--> statement-breakpoint
CREATE INDEX "user_connectors_agent_identifier_idx" ON "user_connectors" USING btree ("agent_id","identifier") WHERE "user_connectors"."agent_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "user_connectors_user_id_idx" ON "user_connectors" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_connectors_token_expires_at_idx" ON "user_connectors" USING btree ("token_expires_at");--> statement-breakpoint
CREATE INDEX "user_connectors_workspace_id_idx" ON "user_connectors" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "user_connectors_agent_id_idx" ON "user_connectors" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "user_installed_plugins_workspace_id_idx" ON "user_installed_plugins" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "devices_user_id_device_id_unique" ON "devices" USING btree ("user_id","device_id") WHERE "devices"."workspace_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "devices_workspace_id_device_id_unique" ON "devices" USING btree ("workspace_id","device_id") WHERE "devices"."workspace_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "devices_user_id_idx" ON "devices" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "devices_workspace_id_idx" ON "devices" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "document_histories_document_id_idx" ON "document_histories" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "document_histories_user_id_idx" ON "document_histories" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "document_histories_workspace_id_idx" ON "document_histories" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "document_histories_saved_at_idx" ON "document_histories" USING btree ("saved_at");--> statement-breakpoint
CREATE UNIQUE INDEX "document_shares_document_id_unique" ON "document_shares" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "document_shares_user_id_idx" ON "document_shares" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "document_shares_workspace_id_idx" ON "document_shares" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "documents_source_idx" ON "documents" USING btree ("source");--> statement-breakpoint
CREATE INDEX "documents_file_type_idx" ON "documents" USING btree ("file_type");--> statement-breakpoint
CREATE INDEX "documents_source_type_idx" ON "documents" USING btree ("source_type");--> statement-breakpoint
CREATE INDEX "documents_user_id_idx" ON "documents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "documents_file_id_idx" ON "documents" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "documents_parent_id_idx" ON "documents" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "documents_knowledge_base_id_idx" ON "documents" USING btree ("knowledge_base_id");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_client_id_user_id_unique" ON "documents" USING btree ("client_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_slug_user_id_unique" ON "documents" USING btree ("slug","user_id") WHERE "documents"."workspace_id" IS NULL AND "documents"."slug" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "documents_workspace_id_idx" ON "documents" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "documents_workspace_visibility_idx" ON "documents" USING btree ("workspace_id","visibility","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_slug_workspace_id_unique" ON "documents" USING btree ("workspace_id","slug") WHERE "documents"."workspace_id" is not null;--> statement-breakpoint
CREATE INDEX "file_hash_idx" ON "files" USING btree ("file_hash");--> statement-breakpoint
CREATE INDEX "files_user_id_idx" ON "files" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "files_parent_id_idx" ON "files" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "files_chunk_task_id_idx" ON "files" USING btree ("chunk_task_id");--> statement-breakpoint
CREATE INDEX "files_embedding_task_id_idx" ON "files" USING btree ("embedding_task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "files_client_id_user_id_unique" ON "files" USING btree ("client_id","user_id");--> statement-breakpoint
CREATE INDEX "files_workspace_id_idx" ON "files" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "files_workspace_visibility_idx" ON "files" USING btree ("workspace_id","visibility","user_id");--> statement-breakpoint
CREATE INDEX "global_files_creator_idx" ON "global_files" USING btree ("creator");--> statement-breakpoint
CREATE INDEX "knowledge_base_files_kb_id_idx" ON "knowledge_base_files" USING btree ("knowledge_base_id");--> statement-breakpoint
CREATE INDEX "knowledge_base_files_user_id_idx" ON "knowledge_base_files" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "knowledge_base_files_file_id_idx" ON "knowledge_base_files" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "knowledge_base_files_workspace_id_idx" ON "knowledge_base_files" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_bases_client_id_user_id_unique" ON "knowledge_bases" USING btree ("client_id","user_id");--> statement-breakpoint
CREATE INDEX "knowledge_bases_user_id_idx" ON "knowledge_bases" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "knowledge_bases_workspace_id_idx" ON "knowledge_bases" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "knowledge_bases_workspace_visibility_idx" ON "knowledge_bases" USING btree ("workspace_id","visibility","user_id");--> statement-breakpoint
CREATE INDEX "generation_batches_user_id_idx" ON "generation_batches" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "generation_batches_topic_id_idx" ON "generation_batches" USING btree ("generation_topic_id");--> statement-breakpoint
CREATE INDEX "generation_batches_workspace_id_idx" ON "generation_batches" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "generation_topics_user_id_idx" ON "generation_topics" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "generation_topics_workspace_id_idx" ON "generation_topics" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "generation_topics_workspace_visibility_idx" ON "generation_topics" USING btree ("workspace_id","visibility","user_id");--> statement-breakpoint
CREATE INDEX "generations_user_id_idx" ON "generations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "generations_batch_id_idx" ON "generations" USING btree ("generation_batch_id");--> statement-breakpoint
CREATE INDEX "generations_file_id_idx" ON "generations" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "generations_workspace_id_idx" ON "generations" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "llm_generation_tracing_scenario_idx" ON "llm_generation_tracing" USING btree ("scenario");--> statement-breakpoint
CREATE INDEX "llm_generation_tracing_prompt_version_idx" ON "llm_generation_tracing" USING btree ("prompt_version");--> statement-breakpoint
CREATE INDEX "llm_generation_tracing_user_id_idx" ON "llm_generation_tracing" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "llm_generation_tracing_agent_id_idx" ON "llm_generation_tracing" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "llm_generation_tracing_topic_id_idx" ON "llm_generation_tracing" USING btree ("topic_id");--> statement-breakpoint
CREATE INDEX "llm_generation_tracing_workspace_id_idx" ON "llm_generation_tracing" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "llm_generation_tracing_provider_idx" ON "llm_generation_tracing" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "llm_generation_tracing_model_idx" ON "llm_generation_tracing" USING btree ("model");--> statement-breakpoint
CREATE INDEX "llm_generation_tracing_success_idx" ON "llm_generation_tracing" USING btree ("success");--> statement-breakpoint
CREATE INDEX "llm_generation_tracing_error_code_idx" ON "llm_generation_tracing" USING btree ("error_code");--> statement-breakpoint
CREATE INDEX "llm_generation_tracing_validation_failed_idx" ON "llm_generation_tracing" USING btree ("validation_failed");--> statement-breakpoint
CREATE INDEX "llm_generation_tracing_feedback_signal_idx" ON "llm_generation_tracing" USING btree ("feedback_signal");--> statement-breakpoint
CREATE INDEX "llm_generation_tracing_created_at_idx" ON "llm_generation_tracing" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "message_chunks_user_id_idx" ON "message_chunks" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "message_chunks_message_id_idx" ON "message_chunks" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "message_chunks_workspace_id_idx" ON "message_chunks" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_groups_client_id_user_id_unique" ON "message_groups" USING btree ("client_id","user_id");--> statement-breakpoint
CREATE INDEX "message_groups_user_id_idx" ON "message_groups" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "message_groups_topic_id_idx" ON "message_groups" USING btree ("topic_id");--> statement-breakpoint
CREATE INDEX "message_groups_type_idx" ON "message_groups" USING btree ("type");--> statement-breakpoint
CREATE INDEX "message_groups_parent_group_id_idx" ON "message_groups" USING btree ("parent_group_id");--> statement-breakpoint
CREATE INDEX "message_groups_parent_message_id_idx" ON "message_groups" USING btree ("parent_message_id");--> statement-breakpoint
CREATE INDEX "message_groups_workspace_id_idx" ON "message_groups" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_plugins_client_id_user_id_unique" ON "message_plugins" USING btree ("client_id","user_id");--> statement-breakpoint
CREATE INDEX "message_plugins_user_id_idx" ON "message_plugins" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "message_plugins_tool_call_id_idx" ON "message_plugins" USING btree ("tool_call_id");--> statement-breakpoint
CREATE INDEX "message_plugins_workspace_id_idx" ON "message_plugins" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_queries_client_id_user_id_unique" ON "message_queries" USING btree ("client_id","user_id");--> statement-breakpoint
CREATE INDEX "message_queries_user_id_idx" ON "message_queries" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "message_queries_message_id_idx" ON "message_queries" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "message_queries_embeddings_id_idx" ON "message_queries" USING btree ("embeddings_id");--> statement-breakpoint
CREATE INDEX "message_queries_workspace_id_idx" ON "message_queries" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "message_query_chunks_user_id_idx" ON "message_query_chunks" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "message_query_chunks_message_id_idx" ON "message_query_chunks" USING btree ("id");--> statement-breakpoint
CREATE INDEX "message_query_chunks_query_id_idx" ON "message_query_chunks" USING btree ("query_id");--> statement-breakpoint
CREATE INDEX "message_query_chunks_workspace_id_idx" ON "message_query_chunks" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_tts_client_id_user_id_unique" ON "message_tts" USING btree ("client_id","user_id");--> statement-breakpoint
CREATE INDEX "message_tts_user_id_idx" ON "message_tts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "message_tts_workspace_id_idx" ON "message_tts" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_translates_client_id_user_id_unique" ON "message_translates" USING btree ("client_id","user_id");--> statement-breakpoint
CREATE INDEX "message_translates_user_id_idx" ON "message_translates" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "message_translates_workspace_id_idx" ON "message_translates" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "messages_created_at_idx" ON "messages" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "message_client_id_user_unique" ON "messages" USING btree ("client_id","user_id");--> statement-breakpoint
CREATE INDEX "messages_topic_id_idx" ON "messages" USING btree ("topic_id");--> statement-breakpoint
CREATE INDEX "messages_topic_id_updated_at_idx" ON "messages" USING btree ("topic_id","updated_at");--> statement-breakpoint
CREATE INDEX "messages_parent_id_idx" ON "messages" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "messages_quota_id_idx" ON "messages" USING btree ("quota_id");--> statement-breakpoint
CREATE INDEX "messages_user_id_idx" ON "messages" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "messages_session_id_idx" ON "messages" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "messages_thread_id_idx" ON "messages" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "messages_agent_id_idx" ON "messages" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "messages_group_id_idx" ON "messages" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "messages_message_group_id_idx" ON "messages" USING btree ("message_group_id");--> statement-breakpoint
CREATE INDEX "messages_user_id_topic_id_created_at_id_idx" ON "messages" USING btree ("user_id","topic_id","created_at","id");--> statement-breakpoint
CREATE INDEX "messages_role_created_at_idx" ON "messages" USING btree ("role","created_at");--> statement-breakpoint
CREATE INDEX "messages_usage_cost_idx" ON "messages" USING btree ((("usage"->>'cost')::numeric));--> statement-breakpoint
CREATE INDEX "messages_usage_total_tokens_idx" ON "messages" USING btree ((("usage"->>'totalTokens')::numeric));--> statement-breakpoint
CREATE INDEX "messages_workspace_id_idx" ON "messages" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "messages_files_user_id_idx" ON "messages_files" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "messages_files_message_id_idx" ON "messages_files" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "messages_files_workspace_id_idx" ON "messages_files" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messenger_account_links_platform_tenant_user_unique" ON "messenger_account_links" USING btree ("platform","tenant_id","platform_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messenger_account_links_user_platform_tenant_unique" ON "messenger_account_links" USING btree ("user_id","platform","tenant_id");--> statement-breakpoint
CREATE INDEX "messenger_account_links_active_agent_idx" ON "messenger_account_links" USING btree ("active_agent_id");--> statement-breakpoint
CREATE INDEX "messenger_account_links_workspace_id_idx" ON "messenger_account_links" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messenger_installations_platform_app_tenant_unique" ON "messenger_installations" USING btree ("platform","application_id","tenant_id");--> statement-breakpoint
CREATE INDEX "messenger_installations_platform_tenant_idx" ON "messenger_installations" USING btree ("platform","tenant_id");--> statement-breakpoint
CREATE INDEX "messenger_installations_token_expires_at_idx" ON "messenger_installations" USING btree ("token_expires_at");--> statement-breakpoint
CREATE INDEX "nextauth_accounts_user_id_idx" ON "nextauth_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "nextauth_sessions_user_id_idx" ON "nextauth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_deliveries_notification" ON "notification_deliveries" USING btree ("notification_id");--> statement-breakpoint
CREATE INDEX "idx_deliveries_channel" ON "notification_deliveries" USING btree ("channel");--> statement-breakpoint
CREATE INDEX "idx_deliveries_status" ON "notification_deliveries" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_notifications_user" ON "notifications" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_notifications_user_active" ON "notifications" USING btree ("user_id","created_at") WHERE "notifications"."is_archived" = false;--> statement-breakpoint
CREATE INDEX "idx_notifications_user_unread" ON "notifications" USING btree ("user_id") WHERE "notifications"."is_read" = false AND "notifications"."is_archived" = false;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_notifications_dedupe" ON "notifications" USING btree ("user_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "idx_notifications_archived_cleanup" ON "notifications" USING btree ("updated_at","created_at","id") WHERE "notifications"."is_archived" = true;--> statement-breakpoint
CREATE INDEX "oidc_access_tokens_user_id_idx" ON "oidc_access_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oidc_authorization_codes_user_id_idx" ON "oidc_authorization_codes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oidc_device_codes_user_id_idx" ON "oidc_device_codes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oidc_grants_user_id_idx" ON "oidc_grants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oidc_refresh_tokens_user_id_idx" ON "oidc_refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oidc_sessions_user_id_idx" ON "oidc_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "platform_admin_mutation_rate_windows_window_start_idx" ON "platform_admin_mutation_rate_windows" USING btree ("window_start");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_agent_assignments_agent_target_unique" ON "platform_agent_assignments" USING btree ("agent_id","target_type","target_id");--> statement-breakpoint
CREATE INDEX "platform_agent_assignments_agent_id_idx" ON "platform_agent_assignments" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "platform_agent_assignments_target_idx" ON "platform_agent_assignments" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "platform_agent_assignments_status_idx" ON "platform_agent_assignments" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_agent_versions_agent_id_version_unique" ON "platform_agent_versions" USING btree ("agent_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_agent_versions_agent_id_id_unique" ON "platform_agent_versions" USING btree ("agent_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_agent_versions_agent_id_id_checksum_unique" ON "platform_agent_versions" USING btree ("agent_id","id","checksum");--> statement-breakpoint
CREATE INDEX "platform_agent_versions_agent_id_idx" ON "platform_agent_versions" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_agents_agent_key_unique" ON "platform_agents" USING btree ("agent_key");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_agents_system_key_unique" ON "platform_agents" USING btree ("system_key") WHERE "platform_agents"."system_key" is not null;--> statement-breakpoint
CREATE INDEX "platform_agents_status_idx" ON "platform_agents" USING btree ("status");--> statement-breakpoint
CREATE INDEX "platform_agents_distribution_idx" ON "platform_agents" USING btree ("distribution");--> statement-breakpoint
CREATE INDEX "platform_agents_current_version_id_idx" ON "platform_agents" USING btree ("current_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_user_agent_mat_tombstones_local_agent_unique" ON "platform_user_agent_materialization_tombstones" USING btree ("materialized_agent_id");--> statement-breakpoint
CREATE INDEX "platform_user_agent_mat_tombstones_user_id_idx" ON "platform_user_agent_materialization_tombstones" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_user_agent_materializations_user_agent_unique" ON "platform_user_agent_materializations" USING btree ("user_id","platform_agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_user_agent_materializations_local_agent_unique" ON "platform_user_agent_materializations" USING btree ("materialized_agent_id") WHERE "platform_user_agent_materializations"."materialized_agent_id" is not null;--> statement-breakpoint
CREATE INDEX "platform_user_agent_materializations_user_id_idx" ON "platform_user_agent_materializations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "platform_user_agent_materializations_platform_agent_id_idx" ON "platform_user_agent_materializations" USING btree ("platform_agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_ai_models_provider_id_model_key_unique" ON "platform_ai_models" USING btree ("provider_id","model_key");--> statement-breakpoint
CREATE INDEX "platform_ai_models_enabled_sort_idx" ON "platform_ai_models" USING btree ("enabled","sort");--> statement-breakpoint
CREATE INDEX "platform_ai_models_status_idx" ON "platform_ai_models" USING btree ("status");--> statement-breakpoint
CREATE INDEX "platform_ai_models_provider_id_idx" ON "platform_ai_models" USING btree ("provider_id");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_ai_provider_secrets_provider_fingerprint_unique" ON "platform_ai_provider_secrets" USING btree ("provider_id","fingerprint");--> statement-breakpoint
CREATE INDEX "platform_ai_provider_secrets_provider_id_idx" ON "platform_ai_provider_secrets" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "platform_ai_provider_secrets_key_id_idx" ON "platform_ai_provider_secrets" USING btree ("key_id");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_ai_providers_provider_key_unique" ON "platform_ai_providers" USING btree ("provider_key");--> statement-breakpoint
CREATE INDEX "platform_ai_providers_status_idx" ON "platform_ai_providers" USING btree ("status");--> statement-breakpoint
CREATE INDEX "platform_ai_providers_enabled_sort_idx" ON "platform_ai_providers" USING btree ("enabled","sort");--> statement-breakpoint
CREATE INDEX "platform_ai_providers_secret_key_id_idx" ON "platform_ai_providers" USING btree ("secret_key_id");--> statement-breakpoint
CREATE INDEX "platform_audit_exports_status_created_at_idx" ON "platform_audit_exports" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "platform_audit_exports_kind_created_at_idx" ON "platform_audit_exports" USING btree ("kind","created_at");--> statement-breakpoint
CREATE INDEX "platform_audit_exports_requested_by_idx" ON "platform_audit_exports" USING btree ("requested_by");--> statement-breakpoint
CREATE INDEX "platform_audit_exports_expires_at_idx" ON "platform_audit_exports" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "platform_audit_exports_retention_sort_at_id_idx" ON "platform_audit_exports" USING btree (coalesce("finished_at", "created_at"),"id") WHERE "platform_audit_exports"."storage_key" IS NOT NULL AND "platform_audit_exports"."status" IN ('completed','expired');--> statement-breakpoint
CREATE INDEX "platform_audit_exports_purge_outbox_updated_at_id_v2_idx" ON "platform_audit_exports" USING btree ("updated_at","id") WHERE "platform_audit_exports"."storage_key" IS NULL AND "platform_audit_exports"."status" IN ('expired','failed','cancelled') AND (coalesce("platform_audit_exports"."error"->>'purgeStorageKey','') <> '' OR jsonb_typeof("platform_audit_exports"."error"->'purgeStorageKeys') = 'array');--> statement-breakpoint
CREATE INDEX "platform_audit_exports_purge_status_deleting_idx" ON "platform_audit_exports" USING btree ("id") WHERE coalesce("platform_audit_exports"."error"->>'purgeStatus', '') = 'deleting';--> statement-breakpoint
CREATE INDEX "platform_audit_exports_purge_storage_key_expr_v2_idx" ON "platform_audit_exports" USING btree (coalesce("error"->>'purgeStorageKey', '')) WHERE coalesce("platform_audit_exports"."error"->>'purgeStorageKey', '') <> '' OR (jsonb_typeof("platform_audit_exports"."error"->'purgeStorageKeys') = 'array' AND jsonb_array_length("platform_audit_exports"."error"->'purgeStorageKeys') > 0);--> statement-breakpoint
CREATE UNIQUE INDEX "platform_audit_exports_job_id_unique" ON "platform_audit_exports" USING btree ("job_id") WHERE "platform_audit_exports"."job_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "platform_audit_legal_holds_status_scope_idx" ON "platform_audit_legal_holds" USING btree ("status","scope_type","scope_id");--> statement-breakpoint
CREATE INDEX "platform_audit_legal_holds_scope_idx" ON "platform_audit_legal_holds" USING btree ("scope_type","scope_id");--> statement-breakpoint
CREATE INDEX "platform_audit_legal_holds_created_by_idx" ON "platform_audit_legal_holds" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "platform_audit_legal_holds_expires_at_idx" ON "platform_audit_legal_holds" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_audit_legal_holds_active_global_unique" ON "platform_audit_legal_holds" USING btree ("scope_type") WHERE "platform_audit_legal_holds"."status" = 'active' AND "platform_audit_legal_holds"."scope_type" = 'global';--> statement-breakpoint
CREATE UNIQUE INDEX "platform_audit_legal_holds_active_scope_unique" ON "platform_audit_legal_holds" USING btree ("scope_type","scope_id") WHERE "platform_audit_legal_holds"."status" = 'active' AND "platform_audit_legal_holds"."scope_type" <> 'global';--> statement-breakpoint
CREATE INDEX "platform_audit_retention_runs_status_created_at_idx" ON "platform_audit_retention_runs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "platform_audit_retention_runs_scope_created_at_idx" ON "platform_audit_retention_runs" USING btree ("scope","created_at");--> statement-breakpoint
CREATE INDEX "platform_audit_retention_runs_requested_by_idx" ON "platform_audit_retention_runs" USING btree ("requested_by");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_audit_retention_runs_job_id_unique" ON "platform_audit_retention_runs" USING btree ("job_id") WHERE "platform_audit_retention_runs"."job_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "platform_audit_logs_created_at_idx" ON "platform_audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "platform_audit_logs_actor_user_id_idx" ON "platform_audit_logs" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "platform_audit_logs_target_type_id_idx" ON "platform_audit_logs" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "platform_audit_logs_action_idx" ON "platform_audit_logs" USING btree ("action");--> statement-breakpoint
CREATE INDEX "platform_audit_logs_request_id_idx" ON "platform_audit_logs" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "platform_audit_logs_actor_created_at_id_idx" ON "platform_audit_logs" USING btree ("actor_user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "platform_audit_logs_action_created_at_id_idx" ON "platform_audit_logs" USING btree ("action","created_at","id");--> statement-breakpoint
CREATE INDEX "platform_audit_logs_result_created_at_id_idx" ON "platform_audit_logs" USING btree ("result","created_at","id");--> statement-breakpoint
CREATE INDEX "platform_audit_logs_created_at_id_idx" ON "platform_audit_logs" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "platform_branding_status_idx" ON "platform_branding" USING btree ("status");--> statement-breakpoint
CREATE INDEX "platform_branding_revision_idx" ON "platform_branding" USING btree ("revision");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_branding_assets_object_key_unique" ON "platform_branding_assets" USING btree ("object_key");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_branding_assets_request_lane_unique" ON "platform_branding_assets" USING btree ("request_actor_id","operation","request_id");--> statement-breakpoint
CREATE INDEX "platform_branding_assets_cleanup_idx" ON "platform_branding_assets" USING btree ("status","cleanup_after");--> statement-breakpoint
CREATE INDEX "platform_branding_assets_created_by_idx" ON "platform_branding_assets" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "platform_branding_assets_published_revision_idx" ON "platform_branding_assets" USING btree ("first_published_revision");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_branding_operations_request_lane_unique" ON "platform_branding_operations" USING btree ("actor_id","operation","resource","request_id");--> statement-breakpoint
CREATE INDEX "platform_branding_operations_pending_lease_idx" ON "platform_branding_operations" USING btree ("status","lease_until");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_connector_governance_resource_unique" ON "platform_connector_governance" USING btree ("resource");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_connector_oauth_states_state_id_unique" ON "platform_connector_oauth_states" USING btree ("state_id");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_connector_oauth_states_state_hash_unique" ON "platform_connector_oauth_states" USING btree ("state_hash");--> statement-breakpoint
CREATE INDEX "platform_connector_oauth_states_binding_created_idx" ON "platform_connector_oauth_states" USING btree ("binding_id","created_at");--> statement-breakpoint
CREATE INDEX "platform_connector_oauth_states_user_connector_idx" ON "platform_connector_oauth_states" USING btree ("user_id","connector_id");--> statement-breakpoint
CREATE INDEX "platform_connector_oauth_states_expires_idx" ON "platform_connector_oauth_states" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_connector_secrets_ref_unique" ON "platform_connector_secrets" USING btree ("ref");--> statement-breakpoint
CREATE INDEX "platform_connector_secrets_lookup_idx" ON "platform_connector_secrets" USING btree ("connector_id","slot","fingerprint","created_at");--> statement-breakpoint
CREATE INDEX "platform_connector_secrets_key_id_idx" ON "platform_connector_secrets" USING btree ("key_id");--> statement-breakpoint
CREATE INDEX "platform_connector_tools_connector_id_idx" ON "platform_connector_tools" USING btree ("connector_id");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_connector_tools_connector_id_tool_key_unique" ON "platform_connector_tools" USING btree ("connector_id","tool_key");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_connectors_connector_key_unique" ON "platform_connectors" USING btree ("connector_key");--> statement-breakpoint
CREATE INDEX "platform_connectors_status_idx" ON "platform_connectors" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_user_connector_bindings_user_connector_unique" ON "platform_user_connector_bindings" USING btree ("user_id","connector_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_user_connector_bindings_oauth_state_owner_unique" ON "platform_user_connector_bindings" USING btree ("id","user_id","connector_id");--> statement-breakpoint
CREATE INDEX "platform_user_connector_bindings_user_id_idx" ON "platform_user_connector_bindings" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "platform_user_connector_bindings_connector_id_idx" ON "platform_user_connector_bindings" USING btree ("connector_id");--> statement-breakpoint
CREATE INDEX "platform_user_connector_bindings_status_idx" ON "platform_user_connector_bindings" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_global_credential_secrets_ref_unique" ON "platform_global_credential_secrets" USING btree ("ref");--> statement-breakpoint
CREATE INDEX "platform_global_credential_secrets_lookup_idx" ON "platform_global_credential_secrets" USING btree ("credential_id","fingerprint","created_at");--> statement-breakpoint
CREATE INDEX "platform_global_credential_secrets_key_id_idx" ON "platform_global_credential_secrets" USING btree ("key_id");--> statement-breakpoint
CREATE INDEX "platform_global_credential_uploads_expires_at_idx" ON "platform_global_credential_uploads" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_global_credential_uploads_owner_hash_unique" ON "platform_global_credential_uploads" USING btree ("created_by","file_hash_id");--> statement-breakpoint
CREATE INDEX "platform_global_credential_uploads_created_by_idx" ON "platform_global_credential_uploads" USING btree ("created_by");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_global_credentials_key_unique" ON "platform_global_credentials" USING btree ("key");--> statement-breakpoint
CREATE INDEX "platform_global_credentials_type_idx" ON "platform_global_credentials" USING btree ("type");--> statement-breakpoint
CREATE INDEX "platform_global_credentials_enabled_idx" ON "platform_global_credentials" USING btree ("enabled");--> statement-breakpoint
CREATE INDEX "platform_identity_provider_instances_heartbeat_idx" ON "platform_identity_provider_instances" USING btree ("last_heartbeat");--> statement-breakpoint
CREATE INDEX "platform_identity_provider_instances_revision_idx" ON "platform_identity_provider_instances" USING btree ("active_identity_revision","last_heartbeat");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_identity_provider_restart_requests_token_unique" ON "platform_identity_provider_restart_requests" USING btree ("intent_token_hash");--> statement-breakpoint
CREATE INDEX "platform_identity_provider_restart_requests_instance_status_idx" ON "platform_identity_provider_restart_requests" USING btree ("target_instance_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_identity_provider_secrets_ref_unique" ON "platform_identity_provider_secrets" USING btree ("ref");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_identity_provider_secrets_provider_fingerprint_unique" ON "platform_identity_provider_secrets" USING btree ("provider_id","fingerprint");--> statement-breakpoint
CREATE INDEX "platform_identity_provider_secrets_lookup_idx" ON "platform_identity_provider_secrets" USING btree ("provider_id","fingerprint","created_at");--> statement-breakpoint
CREATE INDEX "platform_identity_provider_secrets_key_id_idx" ON "platform_identity_provider_secrets" USING btree ("key_id");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_identity_provider_test_attempts_state_hash_unique" ON "platform_identity_provider_test_attempts" USING btree ("state_hash");--> statement-breakpoint
CREATE INDEX "platform_identity_provider_test_attempts_user_provider_idx" ON "platform_identity_provider_test_attempts" USING btree ("user_id","provider_id","created_at");--> statement-breakpoint
CREATE INDEX "platform_identity_provider_test_attempts_expires_idx" ON "platform_identity_provider_test_attempts" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "platform_identity_provider_test_attempts_pkce_key_id_idx" ON "platform_identity_provider_test_attempts" USING btree ("pkce_key_id");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_identity_providers_provider_key_unique" ON "platform_identity_providers" USING btree ("provider_key");--> statement-breakpoint
CREATE INDEX "platform_identity_providers_status_idx" ON "platform_identity_providers" USING btree ("status");--> statement-breakpoint
CREATE INDEX "platform_identity_providers_enabled_status_idx" ON "platform_identity_providers" USING btree ("enabled","status");--> statement-breakpoint
CREATE INDEX "platform_instance_heartbeats_freshness_idx" ON "platform_instance_heartbeats" USING btree ("last_heartbeat_at");--> statement-breakpoint
CREATE INDEX "platform_instance_revision_states_domain_loaded_idx" ON "platform_instance_revision_states" USING btree ("domain","loaded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_jobs_type_idempotency_key_unique" ON "platform_jobs" USING btree ("type","idempotency_key");--> statement-breakpoint
CREATE INDEX "platform_jobs_status_lease_until_idx" ON "platform_jobs" USING btree ("status","lease_until");--> statement-breakpoint
CREATE INDEX "platform_jobs_type_status_idx" ON "platform_jobs" USING btree ("type","status");--> statement-breakpoint
CREATE INDEX "platform_jobs_secret_rewrap_failure_parent_domain_row_idx" ON "platform_jobs" USING btree (("input"->>'parentJobId'),("input"->>'domain'),("input"->>'rowId')) WHERE "platform_jobs"."type" = 'platform.secret.rewrap.failure.v1' AND "platform_jobs"."status" = 'failed';--> statement-breakpoint
CREATE UNIQUE INDEX "platform_jobs_secret_rewrap_single_active_unique" ON "platform_jobs" USING btree ("type") WHERE "platform_jobs"."type" = 'platform.secret.rewrap.v1' AND "platform_jobs"."status" IN ('pending', 'reserved', 'running');--> statement-breakpoint
CREATE INDEX "platform_jobs_rollout_agent_id_id_idx" ON "platform_jobs" USING btree (("input"->'snapshot'->>'agentId'),"id") WHERE "platform_jobs"."type" = 'platform.agent.rollout.v1';--> statement-breakpoint
CREATE INDEX "platform_jobs_rollout_transition_parent_status_user_idx" ON "platform_jobs" USING btree (("input"->>'parentJobId'),"status",("input"->>'userId')) WHERE "platform_jobs"."type" = 'platform.agent.rollout.transition.v1';--> statement-breakpoint
CREATE INDEX "platform_jobs_created_at_idx" ON "platform_jobs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "platform_jobs_requested_by_idx" ON "platform_jobs" USING btree ("requested_by");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_managed_resource_policies_resource_unique" ON "platform_managed_resource_policies" USING btree ("resource");--> statement-breakpoint
CREATE INDEX "platform_managed_resource_policies_status_idx" ON "platform_managed_resource_policies" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_resource_revisions_type_id_revision_unique" ON "platform_resource_revisions" USING btree ("resource_type","resource_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_resource_revisions_type_id_revision_checksum_unique" ON "platform_resource_revisions" USING btree ("resource_type","resource_id","revision","checksum");--> statement-breakpoint
CREATE INDEX "platform_resource_revisions_created_at_idx" ON "platform_resource_revisions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "platform_resource_revisions_type_id_idx" ON "platform_resource_revisions" USING btree ("resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "platform_resource_revisions_status_idx" ON "platform_resource_revisions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "platform_setting_policies_status_idx" ON "platform_setting_policies" USING btree ("status");--> statement-breakpoint
CREATE INDEX "platform_setting_policies_path_status_idx" ON "platform_setting_policies" USING btree ("path","status");--> statement-breakpoint
CREATE INDEX "platform_setting_policies_visibility_idx" ON "platform_setting_policies" USING btree ("visibility");--> statement-breakpoint
CREATE INDEX "user_setting_overrides_user_id_idx" ON "user_setting_overrides" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_setting_overrides_path_idx" ON "user_setting_overrides" USING btree ("path");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_skill_versions_skill_id_version_unique" ON "platform_skill_versions" USING btree ("skill_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_skill_versions_skill_id_id_unique" ON "platform_skill_versions" USING btree ("skill_id","id");--> statement-breakpoint
CREATE INDEX "platform_skill_versions_skill_id_idx" ON "platform_skill_versions" USING btree ("skill_id");--> statement-breakpoint
CREATE INDEX "platform_skill_versions_checksum_idx" ON "platform_skill_versions" USING btree ("checksum");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_skills_skill_key_unique" ON "platform_skills" USING btree ("skill_key");--> statement-breakpoint
CREATE INDEX "platform_skills_status_idx" ON "platform_skills" USING btree ("status");--> statement-breakpoint
CREATE INDEX "platform_skills_enabled_idx" ON "platform_skills" USING btree ("enabled");--> statement-breakpoint
CREATE INDEX "platform_skills_distribution_idx" ON "platform_skills" USING btree ("distribution");--> statement-breakpoint
CREATE INDEX "platform_skills_current_version_id_idx" ON "platform_skills" USING btree ("current_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_push_tokens_user_device" ON "push_tokens" USING btree ("user_id","device_id");--> statement-breakpoint
CREATE INDEX "idx_push_tokens_user" ON "push_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_push_tokens_last_seen" ON "push_tokens" USING btree ("last_seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "chunks_client_id_user_id_unique" ON "chunks" USING btree ("client_id","user_id");--> statement-breakpoint
CREATE INDEX "chunks_user_id_idx" ON "chunks" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "chunks_workspace_id_idx" ON "chunks" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "document_chunks_document_id_idx" ON "document_chunks" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "document_chunks_chunk_id_idx" ON "document_chunks" USING btree ("chunk_id");--> statement-breakpoint
CREATE INDEX "document_chunks_user_id_idx" ON "document_chunks" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "document_chunks_workspace_id_idx" ON "document_chunks" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "embeddings_client_id_user_id_unique" ON "embeddings" USING btree ("client_id","user_id");--> statement-breakpoint
CREATE INDEX "embeddings_chunk_id_idx" ON "embeddings" USING btree ("chunk_id");--> statement-breakpoint
CREATE INDEX "embeddings_user_id_idx" ON "embeddings" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "embeddings_workspace_id_idx" ON "embeddings" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "unstructured_chunks_client_id_user_id_unique" ON "unstructured_chunks" USING btree ("client_id","user_id");--> statement-breakpoint
CREATE INDEX "unstructured_chunks_user_id_idx" ON "unstructured_chunks" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "unstructured_chunks_composite_id_idx" ON "unstructured_chunks" USING btree ("composite_id");--> statement-breakpoint
CREATE INDEX "unstructured_chunks_file_id_idx" ON "unstructured_chunks" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "unstructured_chunks_workspace_id_idx" ON "unstructured_chunks" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "rag_eval_dataset_records_user_id_idx" ON "rag_eval_dataset_records" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "rag_eval_dataset_records_workspace_id_idx" ON "rag_eval_dataset_records" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "rag_eval_datasets_user_id_idx" ON "rag_eval_datasets" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "rag_eval_datasets_workspace_id_idx" ON "rag_eval_datasets" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "rag_eval_evaluations_user_id_idx" ON "rag_eval_evaluations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "rag_eval_evaluations_workspace_id_idx" ON "rag_eval_evaluations" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "rag_eval_evaluation_records_user_id_idx" ON "rag_eval_evaluation_records" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "rag_eval_evaluation_records_workspace_id_idx" ON "rag_eval_evaluation_records" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "rbac_role_permissions_role_id_idx" ON "rbac_role_permissions" USING btree ("role_id");--> statement-breakpoint
CREATE INDEX "rbac_role_permissions_permission_id_idx" ON "rbac_role_permissions" USING btree ("permission_id");--> statement-breakpoint
CREATE INDEX "rbac_roles_workspace_id_idx" ON "rbac_roles" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rbac_roles_name_workspace_unique" ON "rbac_roles" USING btree ("name",COALESCE("workspace_id", ''));--> statement-breakpoint
CREATE UNIQUE INDEX "rbac_user_roles_user_role_scope_unique" ON "rbac_user_roles" USING btree ("user_id","role_id",COALESCE("workspace_id", ''));--> statement-breakpoint
CREATE INDEX "rbac_user_roles_user_id_idx" ON "rbac_user_roles" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "rbac_user_roles_role_id_idx" ON "rbac_user_roles" USING btree ("role_id");--> statement-breakpoint
CREATE INDEX "rbac_user_roles_workspace_id_idx" ON "rbac_user_roles" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "agents_to_sessions_session_id_idx" ON "agents_to_sessions" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "agents_to_sessions_agent_id_idx" ON "agents_to_sessions" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agents_to_sessions_user_id_idx" ON "agents_to_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "agents_to_sessions_workspace_id_idx" ON "agents_to_sessions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "file_chunks_user_id_idx" ON "file_chunks" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "file_chunks_workspace_id_idx" ON "file_chunks" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "file_chunks_file_id_idx" ON "file_chunks" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "file_chunks_chunk_id_idx" ON "file_chunks" USING btree ("chunk_id");--> statement-breakpoint
CREATE INDEX "files_to_sessions_user_id_idx" ON "files_to_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "files_to_sessions_workspace_id_idx" ON "files_to_sessions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "files_to_sessions_file_id_idx" ON "files_to_sessions" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "files_to_sessions_session_id_idx" ON "files_to_sessions" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_groups_client_id_user_id_unique" ON "session_groups" USING btree ("client_id","user_id");--> statement-breakpoint
CREATE INDEX "session_groups_user_id_idx" ON "session_groups" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_groups_workspace_id_idx" ON "session_groups" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "session_groups_workspace_visibility_idx" ON "session_groups" USING btree ("workspace_id","visibility","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "slug_user_id_unique" ON "sessions" USING btree ("slug","user_id") WHERE "sessions"."workspace_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_client_id_user_id_unique" ON "sessions" USING btree ("client_id","user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_id_user_id_idx" ON "sessions" USING btree ("id","user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_id_updated_at_idx" ON "sessions" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "sessions_group_id_idx" ON "sessions" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "sessions_workspace_id_idx" ON "sessions" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_slug_workspace_id_unique" ON "sessions" USING btree ("workspace_id","slug") WHERE "sessions"."workspace_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "system_bot_providers_platform_unique" ON "system_bot_providers" USING btree ("platform");--> statement-breakpoint
CREATE INDEX "briefs_user_id_idx" ON "briefs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "briefs_task_id_idx" ON "briefs" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "briefs_cron_job_id_idx" ON "briefs" USING btree ("cron_job_id");--> statement-breakpoint
CREATE INDEX "briefs_agent_id_idx" ON "briefs" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "briefs_type_idx" ON "briefs" USING btree ("type");--> statement-breakpoint
CREATE INDEX "briefs_priority_idx" ON "briefs" USING btree ("priority");--> statement-breakpoint
CREATE INDEX "briefs_unresolved_idx" ON "briefs" USING btree ("user_id","resolved_at");--> statement-breakpoint
CREATE INDEX "briefs_trigger_idx" ON "briefs" USING btree ("trigger");--> statement-breakpoint
CREATE INDEX "briefs_workspace_id_idx" ON "briefs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "task_comments_task_id_idx" ON "task_comments" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "task_comments_user_id_idx" ON "task_comments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "task_comments_author_user_id_idx" ON "task_comments" USING btree ("author_user_id");--> statement-breakpoint
CREATE INDEX "task_comments_agent_id_idx" ON "task_comments" USING btree ("author_agent_id");--> statement-breakpoint
CREATE INDEX "task_comments_brief_id_idx" ON "task_comments" USING btree ("brief_id");--> statement-breakpoint
CREATE INDEX "task_comments_topic_id_idx" ON "task_comments" USING btree ("topic_id");--> statement-breakpoint
CREATE INDEX "task_comments_workspace_id_idx" ON "task_comments" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "task_comments_workspace_visibility_idx" ON "task_comments" USING btree ("workspace_id","visibility","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_deps_unique_idx" ON "task_dependencies" USING btree ("task_id","depends_on_id");--> statement-breakpoint
CREATE INDEX "task_deps_task_id_idx" ON "task_dependencies" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "task_deps_depends_on_id_idx" ON "task_dependencies" USING btree ("depends_on_id");--> statement-breakpoint
CREATE INDEX "task_deps_user_id_idx" ON "task_dependencies" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "task_dependencies_workspace_id_idx" ON "task_dependencies" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "task_deps_workspace_visibility_idx" ON "task_dependencies" USING btree ("workspace_id","visibility","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_docs_unique_idx" ON "task_documents" USING btree ("task_id","document_id");--> statement-breakpoint
CREATE INDEX "task_docs_task_id_idx" ON "task_documents" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "task_docs_document_id_idx" ON "task_documents" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "task_docs_user_id_idx" ON "task_documents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "task_documents_workspace_id_idx" ON "task_documents" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "task_docs_workspace_visibility_idx" ON "task_documents" USING btree ("workspace_id","visibility","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_topics_unique_idx" ON "task_topics" USING btree ("task_id","topic_id");--> statement-breakpoint
CREATE INDEX "task_topics_task_id_idx" ON "task_topics" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "task_topics_topic_id_idx" ON "task_topics" USING btree ("topic_id");--> statement-breakpoint
CREATE INDEX "task_topics_user_id_idx" ON "task_topics" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "task_topics_status_idx" ON "task_topics" USING btree ("task_id","status");--> statement-breakpoint
CREATE INDEX "task_topics_workspace_id_idx" ON "task_topics" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "task_topics_workspace_visibility_idx" ON "task_topics" USING btree ("workspace_id","visibility","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_identifier_idx" ON "tasks" USING btree ("identifier","created_by_user_id") WHERE "tasks"."workspace_id" is null;--> statement-breakpoint
CREATE INDEX "tasks_created_by_user_id_idx" ON "tasks" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "tasks_created_by_agent_id_idx" ON "tasks" USING btree ("created_by_agent_id");--> statement-breakpoint
CREATE INDEX "tasks_assignee_user_id_idx" ON "tasks" USING btree ("assignee_user_id");--> statement-breakpoint
CREATE INDEX "tasks_assignee_agent_id_idx" ON "tasks" USING btree ("assignee_agent_id");--> statement-breakpoint
CREATE INDEX "tasks_parent_task_id_idx" ON "tasks" USING btree ("parent_task_id");--> statement-breakpoint
CREATE INDEX "tasks_status_idx" ON "tasks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "tasks_priority_idx" ON "tasks" USING btree ("priority");--> statement-breakpoint
CREATE INDEX "tasks_automation_mode_idx" ON "tasks" USING btree ("automation_mode");--> statement-breakpoint
CREATE INDEX "tasks_heartbeat_idx" ON "tasks" USING btree ("status","last_heartbeat_at");--> statement-breakpoint
CREATE INDEX "tasks_workspace_id_idx" ON "tasks" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "tasks_workspace_visibility_idx" ON "tasks" USING btree ("workspace_id","visibility","created_by_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_identifier_workspace_id_unique" ON "tasks" USING btree ("workspace_id","identifier") WHERE "tasks"."workspace_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "threads_client_id_user_id_unique" ON "threads" USING btree ("client_id","user_id");--> statement-breakpoint
CREATE INDEX "threads_user_id_idx" ON "threads" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "threads_topic_id_idx" ON "threads" USING btree ("topic_id");--> statement-breakpoint
CREATE INDEX "threads_type_idx" ON "threads" USING btree ("type");--> statement-breakpoint
CREATE INDEX "threads_agent_id_idx" ON "threads" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "threads_group_id_idx" ON "threads" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "threads_parent_thread_id_idx" ON "threads" USING btree ("parent_thread_id");--> statement-breakpoint
CREATE INDEX "threads_workspace_id_idx" ON "threads" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "topic_documents_user_id_idx" ON "topic_documents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "topic_documents_topic_id_idx" ON "topic_documents" USING btree ("topic_id");--> statement-breakpoint
CREATE INDEX "topic_documents_document_id_idx" ON "topic_documents" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "topic_documents_workspace_id_idx" ON "topic_documents" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "topic_shares_topic_id_unique" ON "topic_shares" USING btree ("topic_id");--> statement-breakpoint
CREATE INDEX "topic_shares_user_id_idx" ON "topic_shares" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "topic_shares_workspace_id_idx" ON "topic_shares" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "topics_client_id_user_id_unique" ON "topics" USING btree ("client_id","user_id");--> statement-breakpoint
CREATE INDEX "topics_user_id_idx" ON "topics" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "topics_id_user_id_idx" ON "topics" USING btree ("id","user_id");--> statement-breakpoint
CREATE INDEX "topics_user_id_created_at_id_idx" ON "topics" USING btree ("user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "topics_retention_updated_at_id_idx" ON "topics" USING btree ("updated_at","id") WHERE "topics"."status" IS NULL OR "topics"."status" IN ('active','completed','failed','archived','unread');--> statement-breakpoint
CREATE INDEX "topics_session_id_idx" ON "topics" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "topics_group_id_idx" ON "topics" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "topics_agent_id_idx" ON "topics" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "topics_trigger_idx" ON "topics" USING btree ("trigger");--> statement-breakpoint
CREATE INDEX "topics_status_idx" ON "topics" USING btree ("status");--> statement-breakpoint
CREATE INDEX "topics_model_idx" ON "topics" USING btree ("model");--> statement-breakpoint
CREATE INDEX "topics_provider_idx" ON "topics" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "topics_user_id_completed_at_idx" ON "topics" USING btree ("user_id","completed_at");--> statement-breakpoint
CREATE INDEX "topics_sender_id_idx" ON "topics" USING btree ("sender_id");--> statement-breakpoint
CREATE INDEX "topics_workspace_id_idx" ON "topics" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "topics_extract_status_gin_idx" ON "topics" USING gin ((metadata->'userMemoryExtractStatus') jsonb_path_ops);--> statement-breakpoint
CREATE INDEX "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "users_username_idx" ON "users" USING btree ("username");--> statement-breakpoint
CREATE INDEX "users_created_at_idx" ON "users" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "users_banned_true_created_at_idx" ON "users" USING btree ("created_at") WHERE "users"."banned" = true;--> statement-breakpoint
CREATE INDEX "users_email_lower_pattern_idx" ON "users" USING btree (lower("email") text_pattern_ops);--> statement-breakpoint
CREATE INDEX "users_username_lower_pattern_idx" ON "users" USING btree (lower("username") text_pattern_ops);--> statement-breakpoint
CREATE INDEX "users_normalized_email_lower_pattern_idx" ON "users" USING btree (lower("normalized_email") text_pattern_ops);--> statement-breakpoint
CREATE INDEX "user_memories_summary_vector_1024_index" ON "user_memories" USING hnsw ("summary_vector_1024" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "user_memories_details_vector_1024_index" ON "user_memories" USING hnsw ("details_vector_1024" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "user_memories_user_id_index" ON "user_memories" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_memories_activities_narrative_vector_index" ON "user_memories_activities" USING hnsw ("narrative_vector" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "user_memories_activities_feedback_vector_index" ON "user_memories_activities" USING hnsw ("feedback_vector" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "user_memories_activities_type_index" ON "user_memories_activities" USING btree ("type");--> statement-breakpoint
CREATE INDEX "user_memories_activities_user_id_index" ON "user_memories_activities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_memories_activities_user_memory_id_index" ON "user_memories_activities" USING btree ("user_memory_id");--> statement-breakpoint
CREATE INDEX "user_memories_activities_status_index" ON "user_memories_activities" USING btree ("status");--> statement-breakpoint
CREATE INDEX "user_memories_contexts_description_vector_index" ON "user_memories_contexts" USING hnsw ("description_vector" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "user_memories_contexts_type_index" ON "user_memories_contexts" USING btree ("type");--> statement-breakpoint
CREATE INDEX "user_memories_contexts_user_id_index" ON "user_memories_contexts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_memories_experiences_situation_vector_index" ON "user_memories_experiences" USING hnsw ("situation_vector" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "user_memories_experiences_action_vector_index" ON "user_memories_experiences" USING hnsw ("action_vector" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "user_memories_experiences_key_learning_vector_index" ON "user_memories_experiences" USING hnsw ("key_learning_vector" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "user_memories_experiences_type_index" ON "user_memories_experiences" USING btree ("type");--> statement-breakpoint
CREATE INDEX "user_memories_experiences_user_id_index" ON "user_memories_experiences" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_memories_experiences_user_memory_id_index" ON "user_memories_experiences" USING btree ("user_memory_id");--> statement-breakpoint
CREATE INDEX "user_memories_identities_description_vector_index" ON "user_memories_identities" USING hnsw ("description_vector" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "user_memories_identities_type_index" ON "user_memories_identities" USING btree ("type");--> statement-breakpoint
CREATE INDEX "user_memories_identities_user_id_index" ON "user_memories_identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_memories_identities_user_memory_id_index" ON "user_memories_identities" USING btree ("user_memory_id");--> statement-breakpoint
CREATE INDEX "user_memories_preferences_conclusion_directives_vector_index" ON "user_memories_preferences" USING hnsw ("conclusion_directives_vector" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "user_memories_preferences_user_id_index" ON "user_memories_preferences" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_memories_preferences_user_memory_id_index" ON "user_memories_preferences" USING btree ("user_memory_id");--> statement-breakpoint
CREATE INDEX "user_persona_document_histories_persona_id_index" ON "user_memory_persona_document_histories" USING btree ("persona_id");--> statement-breakpoint
CREATE INDEX "user_persona_document_histories_user_id_index" ON "user_memory_persona_document_histories" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_persona_document_histories_profile_index" ON "user_memory_persona_document_histories" USING btree ("profile");--> statement-breakpoint
CREATE UNIQUE INDEX "user_persona_documents_user_id_profile_unique" ON "user_memory_persona_documents" USING btree ("user_id","profile");--> statement-breakpoint
CREATE INDEX "user_persona_documents_user_id_index" ON "user_memory_persona_documents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verify_check_results_verify_run_id_idx" ON "verify_check_results" USING btree ("verify_run_id");--> statement-breakpoint
CREATE INDEX "verify_check_results_operation_id_idx" ON "verify_check_results" USING btree ("operation_id");--> statement-breakpoint
CREATE INDEX "verify_check_results_user_id_idx" ON "verify_check_results" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "verify_check_results_verify_run_id_check_item_id_unique" ON "verify_check_results" USING btree ("verify_run_id","check_item_id");--> statement-breakpoint
CREATE INDEX "verify_check_results_verifier_type_idx" ON "verify_check_results" USING btree ("verifier_type");--> statement-breakpoint
CREATE INDEX "verify_check_results_verifier_operation_id_idx" ON "verify_check_results" USING btree ("verifier_operation_id");--> statement-breakpoint
CREATE INDEX "verify_check_results_verifier_tracing_id_idx" ON "verify_check_results" USING btree ("verifier_tracing_id");--> statement-breakpoint
CREATE INDEX "verify_check_results_status_idx" ON "verify_check_results" USING btree ("status");--> statement-breakpoint
CREATE INDEX "verify_check_results_verdict_idx" ON "verify_check_results" USING btree ("verdict");--> statement-breakpoint
CREATE INDEX "verify_check_results_repair_operation_id_idx" ON "verify_check_results" USING btree ("repair_operation_id");--> statement-breakpoint
CREATE INDEX "verify_check_results_workspace_id_idx" ON "verify_check_results" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "verify_criteria_user_id_idx" ON "verify_criteria" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verify_criteria_verifier_type_idx" ON "verify_criteria" USING btree ("verifier_type");--> statement-breakpoint
CREATE INDEX "verify_criteria_document_id_idx" ON "verify_criteria" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "verify_criteria_workspace_id_idx" ON "verify_criteria" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "verify_evidence_check_result_id_idx" ON "verify_evidence" USING btree ("check_result_id");--> statement-breakpoint
CREATE INDEX "verify_evidence_file_id_idx" ON "verify_evidence" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "verify_evidence_user_id_idx" ON "verify_evidence" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verify_evidence_workspace_id_idx" ON "verify_evidence" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "verify_reports_verify_run_id_unique" ON "verify_reports" USING btree ("verify_run_id");--> statement-breakpoint
CREATE INDEX "verify_reports_operation_id_idx" ON "verify_reports" USING btree ("operation_id");--> statement-breakpoint
CREATE INDEX "verify_reports_user_id_idx" ON "verify_reports" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verify_reports_workspace_id_idx" ON "verify_reports" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "verify_rubric_criteria_criterion_id_idx" ON "verify_rubric_criteria" USING btree ("criterion_id");--> statement-breakpoint
CREATE INDEX "verify_rubric_criteria_user_id_idx" ON "verify_rubric_criteria" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verify_rubric_criteria_workspace_id_idx" ON "verify_rubric_criteria" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "verify_rubrics_user_id_idx" ON "verify_rubrics" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verify_rubrics_workspace_id_idx" ON "verify_rubrics" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "verify_runs_user_id_idx" ON "verify_runs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verify_runs_workspace_id_idx" ON "verify_runs" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "verify_runs_operation_id_unique" ON "verify_runs" USING btree ("operation_id");--> statement-breakpoint
CREATE INDEX "verify_runs_source_idx" ON "verify_runs" USING btree ("source");--> statement-breakpoint
CREATE INDEX "workspace_audit_logs_workspace_id_idx" ON "workspace_audit_logs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "workspace_audit_logs_action_idx" ON "workspace_audit_logs" USING btree ("action");--> statement-breakpoint
CREATE INDEX "workspace_audit_logs_created_at_idx" ON "workspace_audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "workspace_invitations_workspace_id_idx" ON "workspace_invitations" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "workspace_invitations_email_idx" ON "workspace_invitations" USING btree ("email");--> statement-breakpoint
CREATE INDEX "workspace_invitations_token_idx" ON "workspace_invitations" USING btree ("token");--> statement-breakpoint
CREATE INDEX "workspace_members_user_id_idx" ON "workspace_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_slug_idx" ON "workspaces" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "workspaces_primary_owner_id_idx" ON "workspaces" USING btree ("primary_owner_id");
--> statement-breakpoint
-- Final-state BM25 search indexes
-- https://github.com/lobehub/lobe-chat/issues/8316
-- Custom SQL migration file, put your code below! --
-- All tables include user_id (keyword tokenizer + fast) for filter pushdown into tantivy index scan.
-- Enum/filter fields (type, status, role, etc.) use keyword+fast for the same reason.
-- Large tables (documents, messages) are placed last to avoid blocking smaller index builds.

-- 1. agents: title, description, slug, tags(jsonb), system_role, user_id
DROP INDEX IF EXISTS agents_bm25_idx;--> statement-breakpoint
CREATE INDEX agents_bm25_idx ON agents
USING bm25 (id, title, description, slug, tags, system_role, user_id)
WITH (
  key_field = 'id',
  text_fields = '{
    "title":       {"tokenizer": {"type": "icu", "stemmer": "English", "stopwords_language": "English"}},
    "description": {"tokenizer": {"type": "icu", "stemmer": "English", "stopwords_language": "English"}},
    "slug":        {"tokenizer": {"type": "icu"}},
    "system_role": {"tokenizer": {"type": "icu", "stemmer": "English", "stopwords_language": "English"}},
    "user_id":     {"fast": true, "tokenizer": {"type": "keyword"}}
  }',
  json_fields = '{
    "tags": {"tokenizer": {"type": "icu"}}
  }'
);--> statement-breakpoint

-- 2. topics: title, content, description, user_id
DROP INDEX IF EXISTS topics_bm25_idx;--> statement-breakpoint
CREATE INDEX topics_bm25_idx ON topics
USING bm25 (id, title, content, description, user_id)
WITH (
  key_field = 'id',
  text_fields = '{
    "title":       {"tokenizer": {"type": "icu", "stemmer": "English", "stopwords_language": "English"}},
    "content":     {"tokenizer": {"type": "icu", "stemmer": "English", "stopwords_language": "English"}},
    "description": {"tokenizer": {"type": "icu", "stemmer": "English", "stopwords_language": "English"}},
    "user_id":     {"fast": true, "tokenizer": {"type": "keyword"}}
  }'
);--> statement-breakpoint

-- 3. files: name, user_id, file_type
DROP INDEX IF EXISTS files_bm25_idx;--> statement-breakpoint
CREATE INDEX files_bm25_idx ON files
USING bm25 (id, name, user_id, file_type)
WITH (
  key_field = 'id',
  text_fields = '{
    "name":      {"tokenizer": {"type": "icu"}},
    "user_id":   {"fast": true, "tokenizer": {"type": "keyword"}},
    "file_type": {"fast": true, "tokenizer": {"type": "keyword"}}
  }'
);--> statement-breakpoint

-- 4. knowledge_bases: name, description, user_id
DROP INDEX IF EXISTS knowledge_bases_bm25_idx;--> statement-breakpoint
CREATE INDEX knowledge_bases_bm25_idx ON knowledge_bases
USING bm25 (id, name, description, user_id)
WITH (
  key_field = 'id',
  text_fields = '{
    "name":        {"tokenizer": {"type": "icu"}},
    "description": {"tokenizer": {"type": "icu", "stemmer": "English", "stopwords_language": "English"}},
    "user_id":     {"fast": true, "tokenizer": {"type": "keyword"}}
  }'
);--> statement-breakpoint

-- 5. user_memories: title, summary, details, memory_layer, memory_category, status, user_id
DROP INDEX IF EXISTS user_memories_bm25_idx;--> statement-breakpoint
CREATE INDEX user_memories_bm25_idx ON user_memories
USING bm25 (id, title, summary, details, memory_layer, memory_category, status, user_id)
WITH (
  key_field = 'id',
  text_fields = '{
    "title":           {"tokenizer": {"type": "icu", "stemmer": "English", "stopwords_language": "English"}},
    "summary":         {"tokenizer": {"type": "icu", "stemmer": "English", "stopwords_language": "English"}},
    "details":         {"tokenizer": {"type": "icu", "stemmer": "English", "stopwords_language": "English"}},
    "memory_layer":    {"fast": true, "tokenizer": {"type": "keyword"}},
    "memory_category": {"fast": true, "tokenizer": {"type": "keyword"}},
    "status":          {"fast": true, "tokenizer": {"type": "keyword"}},
    "user_id":         {"fast": true, "tokenizer": {"type": "keyword"}}
  }'
);--> statement-breakpoint

-- 6. chat_groups: title, description, content, user_id
DROP INDEX IF EXISTS chat_groups_bm25_idx;--> statement-breakpoint
CREATE INDEX chat_groups_bm25_idx ON chat_groups
USING bm25 (id, title, description, content, user_id)
WITH (
  key_field = 'id',
  text_fields = '{
    "title":       {"tokenizer": {"type": "icu", "stemmer": "English", "stopwords_language": "English"}},
    "description": {"tokenizer": {"type": "icu", "stemmer": "English", "stopwords_language": "English"}},
    "content":     {"tokenizer": {"type": "icu", "stemmer": "English", "stopwords_language": "English"}},
    "user_id":     {"fast": true, "tokenizer": {"type": "keyword"}}
  }'
);--> statement-breakpoint

-- 7. user_memories_contexts: title, description, current_status, type, user_id
DROP INDEX IF EXISTS user_memories_contexts_bm25_idx;--> statement-breakpoint
CREATE INDEX user_memories_contexts_bm25_idx ON user_memories_contexts
USING bm25 (id, title, description, current_status, type, user_id)
WITH (
  key_field = 'id',
  text_fields = '{
    "title":          {"tokenizer": {"type": "icu", "stemmer": "English", "stopwords_language": "English"}},
    "description":    {"tokenizer": {"type": "icu", "stemmer": "English", "stopwords_language": "English"}},
    "current_status": {"tokenizer": {"type": "icu", "stemmer": "English", "stopwords_language": "English"}},
    "type":           {"fast": true, "tokenizer": {"type": "keyword"}},
    "user_id":        {"fast": true, "tokenizer": {"type": "keyword"}}
  }'
);--> statement-breakpoint

-- 8. user_memories_preferences: conclusion_directives, suggestions, type, user_id
DROP INDEX IF EXISTS user_memories_preferences_bm25_idx;--> statement-breakpoint
CREATE INDEX user_memories_preferences_bm25_idx ON user_memories_preferences
USING bm25 (id, conclusion_directives, suggestions, type, user_id)
WITH (
  key_field = 'id',
  text_fields = '{
    "conclusion_directives": {"tokenizer": {"type": "icu", "stemmer": "English", "stopwords_language": "English"}},
    "suggestions":           {"tokenizer": {"type": "icu", "stemmer": "English", "stopwords_language": "English"}},
    "type":                  {"fast": true, "tokenizer": {"type": "keyword"}},
    "user_id":               {"fast": true, "tokenizer": {"type": "keyword"}}
  }'
);--> statement-breakpoint

-- 9. user_memories_activities: notes, narrative, feedback, type, status, user_id
DROP INDEX IF EXISTS user_memories_activities_bm25_idx;--> statement-breakpoint
CREATE INDEX user_memories_activities_bm25_idx ON user_memories_activities
USING bm25 (id, notes, narrative, feedback, type, status, user_id)
WITH (
  key_field = 'id',
  text_fields = '{
    "notes":     {"tokenizer": {"type": "icu", "stemmer": "English", "stopwords_language": "English"}},
    "narrative": {"tokenizer": {"type": "icu", "stemmer": "English", "stopwords_language": "English"}},
    "feedback":  {"tokenizer": {"type": "icu", "stemmer": "English", "stopwords_language": "English"}},
    "type":      {"fast": true, "tokenizer": {"type": "keyword"}},
    "status":    {"fast": true, "tokenizer": {"type": "keyword"}},
    "user_id":   {"fast": true, "tokenizer": {"type": "keyword"}}
  }'
);--> statement-breakpoint

-- 10. user_memories_identities: description, role, type, relationship, user_id
DROP INDEX IF EXISTS user_memories_identities_bm25_idx;--> statement-breakpoint
CREATE INDEX user_memories_identities_bm25_idx ON user_memories_identities
USING bm25 (id, description, role, type, relationship, user_id)
WITH (
  key_field = 'id',
  text_fields = '{
    "description":  {"tokenizer": {"type": "icu", "stemmer": "English", "stopwords_language": "English"}},
    "role":         {"tokenizer": {"type": "icu", "stemmer": "English", "stopwords_language": "English"}},
    "type":         {"fast": true, "tokenizer": {"type": "keyword"}},
    "relationship": {"fast": true, "tokenizer": {"type": "keyword"}},
    "user_id":      {"fast": true, "tokenizer": {"type": "keyword"}}
  }'
);--> statement-breakpoint

-- 11. user_memories_experiences: situation, reasoning, possible_outcome, action, key_learning, type, user_id
DROP INDEX IF EXISTS user_memories_experiences_bm25_idx;--> statement-breakpoint
CREATE INDEX user_memories_experiences_bm25_idx ON user_memories_experiences
USING bm25 (id, situation, reasoning, possible_outcome, action, key_learning, type, user_id)
WITH (
  key_field = 'id',
  text_fields = '{
    "situation":        {"tokenizer": {"type": "icu", "stemmer": "English", "stopwords_language": "English"}},
    "reasoning":        {"tokenizer": {"type": "icu", "stemmer": "English", "stopwords_language": "English"}},
    "possible_outcome": {"tokenizer": {"type": "icu", "stemmer": "English", "stopwords_language": "English"}},
    "action":           {"tokenizer": {"type": "icu", "stemmer": "English", "stopwords_language": "English"}},
    "key_learning":     {"tokenizer": {"type": "icu", "stemmer": "English", "stopwords_language": "English"}},
    "type":             {"fast": true, "tokenizer": {"type": "keyword"}},
    "user_id":          {"fast": true, "tokenizer": {"type": "keyword"}}
  }'
);--> statement-breakpoint

-- 12. user_memory_persona_documents: tagline, persona, user_id
DROP INDEX IF EXISTS user_memory_persona_documents_bm25_idx;--> statement-breakpoint
CREATE INDEX user_memory_persona_documents_bm25_idx ON user_memory_persona_documents
USING bm25 (id, tagline, persona, user_id)
WITH (
  key_field = 'id',
  text_fields = '{
    "tagline": {"tokenizer": {"type": "icu", "stemmer": "English", "stopwords_language": "English"}},
    "persona": {"tokenizer": {"type": "icu", "stemmer": "English", "stopwords_language": "English"}},
    "user_id": {"fast": true, "tokenizer": {"type": "keyword"}}
  }'
);--> statement-breakpoint

-- 13. documents (large table): title, description, content, slug, user_id, file_type, source_type
DROP INDEX IF EXISTS documents_bm25_idx;--> statement-breakpoint
CREATE INDEX documents_bm25_idx ON documents
USING bm25 (id, title, description, content, slug, user_id, file_type, source_type)
WITH (
  key_field = 'id',
  text_fields = '{
    "title":       {"tokenizer": {"type": "icu", "stemmer": "English", "stopwords_language": "English"}},
    "description": {"tokenizer": {"type": "icu", "stemmer": "English", "stopwords_language": "English"}},
    "content":     {"tokenizer": {"type": "icu", "stemmer": "English", "stopwords_language": "English"}},
    "slug":        {"tokenizer": {"type": "icu"}},
    "user_id":     {"fast": true, "tokenizer": {"type": "keyword"}},
    "file_type":   {"fast": true, "tokenizer": {"type": "keyword"}},
    "source_type": {"fast": true, "tokenizer": {"type": "keyword"}}
  }'
);--> statement-breakpoint

-- 14. messages (largest table): content, summary, user_id, role
DROP INDEX IF EXISTS messages_bm25_idx;--> statement-breakpoint
CREATE INDEX messages_bm25_idx ON messages
USING bm25 (id, content, summary, user_id, role)
WITH (
  key_field = 'id',
  text_fields = '{
    "content": {"tokenizer": {"type": "icu", "stemmer": "English", "stopwords_language": "English"}},
    "summary": {"tokenizer": {"type": "icu", "stemmer": "English", "stopwords_language": "English"}},
    "user_id": {"fast": true, "tokenizer": {"type": "keyword"}},
    "role":    {"fast": true, "tokenizer": {"type": "keyword"}}
  }'
);
--> statement-breakpoint
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
--> statement-breakpoint
-- Final-state guarded platform Agent version deletion
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
--> statement-breakpoint
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
--> statement-breakpoint
-- Final-state guarded platform Skill validation updates
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
DROP TRIGGER IF EXISTS "platform_skill_versions_immutable" ON "platform_skill_versions";
--> statement-breakpoint
CREATE TRIGGER "platform_skill_versions_immutable"
BEFORE UPDATE OR DELETE ON "platform_skill_versions"
FOR EACH ROW EXECUTE FUNCTION "prevent_platform_skill_version_mutation"();
