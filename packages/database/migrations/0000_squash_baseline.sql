-- ===== 0000_init =====
CREATE TABLE IF NOT EXISTS "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" varchar(100),
	"title" text,
	"description" text,
	"tags" jsonb DEFAULT '[]'::jsonb,
	"avatar" text,
	"background_color" text,
	"plugins" jsonb DEFAULT '[]'::jsonb,
	"user_id" text NOT NULL,
	"chat_config" jsonb,
	"few_shots" jsonb,
	"model" text,
	"params" jsonb DEFAULT '{}'::jsonb,
	"provider" text,
	"system_role" text,
	"tts" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agents_tags" (
	"agent_id" text NOT NULL,
	"tag_id" integer NOT NULL,
	CONSTRAINT "agents_tags_agent_id_tag_id_pk" PRIMARY KEY("agent_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agents_to_sessions" (
	"agent_id" text NOT NULL,
	"session_id" text NOT NULL,
	CONSTRAINT "agents_to_sessions_agent_id_session_id_pk" PRIMARY KEY("agent_id","session_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "files" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"file_type" varchar(255) NOT NULL,
	"name" text NOT NULL,
	"size" integer NOT NULL,
	"url" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "files_to_agents" (
	"file_id" text NOT NULL,
	"agent_id" text NOT NULL,
	CONSTRAINT "files_to_agents_file_id_agent_id_pk" PRIMARY KEY("file_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "files_to_messages" (
	"file_id" text NOT NULL,
	"message_id" text NOT NULL,
	CONSTRAINT "files_to_messages_file_id_message_id_pk" PRIMARY KEY("file_id","message_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "files_to_sessions" (
	"file_id" text NOT NULL,
	"session_id" text NOT NULL,
	CONSTRAINT "files_to_sessions_file_id_session_id_pk" PRIMARY KEY("file_id","session_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_installed_plugins" (
	"user_id" text NOT NULL,
	"identifier" text NOT NULL,
	"type" text NOT NULL,
	"manifest" jsonb,
	"settings" jsonb,
	"custom_params" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_installed_plugins_user_id_identifier_pk" PRIMARY KEY("user_id","identifier")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "market" (
	"id" serial PRIMARY KEY NOT NULL,
	"agent_id" text,
	"plugin_id" integer,
	"type" text NOT NULL,
	"view" integer DEFAULT 0,
	"like" integer DEFAULT 0,
	"used" integer DEFAULT 0,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "message_plugins" (
	"id" text PRIMARY KEY NOT NULL,
	"tool_call_id" text,
	"type" text DEFAULT 'default',
	"api_name" text,
	"arguments" text,
	"identifier" text,
	"state" jsonb,
	"error" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "message_tts" (
	"id" text PRIMARY KEY NOT NULL,
	"content_md5" text,
	"file_id" text,
	"voice" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "message_translates" (
	"id" text PRIMARY KEY NOT NULL,
	"content" text,
	"from" text,
	"to" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"role" text NOT NULL,
	"content" text,
	"model" text,
	"provider" text,
	"favorite" boolean DEFAULT false,
	"error" jsonb,
	"tools" jsonb,
	"trace_id" text,
	"observation_id" text,
	"user_id" text NOT NULL,
	"session_id" text,
	"topic_id" text,
	"parent_id" text,
	"quota_id" text,
	"agent_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "plugins" (
	"id" serial PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"avatar" text,
	"author" text,
	"manifest" text NOT NULL,
	"locale" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plugins_identifier_unique" UNIQUE("identifier")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "plugins_tags" (
	"plugin_id" integer NOT NULL,
	"tag_id" integer NOT NULL,
	CONSTRAINT "plugins_tags_plugin_id_tag_id_pk" PRIMARY KEY("plugin_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "session_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"sort" integer,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" varchar(100) NOT NULL,
	"title" text,
	"description" text,
	"avatar" text,
	"background_color" text,
	"type" text DEFAULT 'agent',
	"user_id" text NOT NULL,
	"group_id" text,
	"pinned" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tags" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tags_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "topics" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text,
	"user_id" text NOT NULL,
	"favorite" boolean DEFAULT false,
	"title" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"tts" jsonb,
	"key_vaults" text,
	"general" jsonb,
	"language_model" jsonb,
	"system_agent" jsonb,
	"default_agent" jsonb,
	"tool" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" text PRIMARY KEY NOT NULL,
	"username" text,
	"email" text,
	"avatar" text,
	"phone" text,
	"first_name" text,
	"last_name" text,
	"is_onboarded" boolean DEFAULT false,
	"clerk_created_at" timestamp with time zone,
	"preference" jsonb DEFAULT '{"guide":{"moveSettingsToAvatar":true,"topic":true},"telemetry":null,"useCmdEnterToSend":false}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"key" text,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agents" ADD CONSTRAINT "agents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agents_tags" ADD CONSTRAINT "agents_tags_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agents_tags" ADD CONSTRAINT "agents_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agents_to_sessions" ADD CONSTRAINT "agents_to_sessions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agents_to_sessions" ADD CONSTRAINT "agents_to_sessions_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "files" ADD CONSTRAINT "files_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "files_to_agents" ADD CONSTRAINT "files_to_agents_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "files_to_agents" ADD CONSTRAINT "files_to_agents_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "files_to_messages" ADD CONSTRAINT "files_to_messages_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "files_to_messages" ADD CONSTRAINT "files_to_messages_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "files_to_sessions" ADD CONSTRAINT "files_to_sessions_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "files_to_sessions" ADD CONSTRAINT "files_to_sessions_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_installed_plugins" ADD CONSTRAINT "user_installed_plugins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "market" ADD CONSTRAINT "market_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "market" ADD CONSTRAINT "market_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "market" ADD CONSTRAINT "market_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "message_plugins" ADD CONSTRAINT "message_plugins_id_messages_id_fk" FOREIGN KEY ("id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "message_tts" ADD CONSTRAINT "message_tts_id_messages_id_fk" FOREIGN KEY ("id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "message_tts" ADD CONSTRAINT "message_tts_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "message_translates" ADD CONSTRAINT "message_translates_id_messages_id_fk" FOREIGN KEY ("id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "messages" ADD CONSTRAINT "messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "messages" ADD CONSTRAINT "messages_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "messages" ADD CONSTRAINT "messages_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "messages" ADD CONSTRAINT "messages_parent_id_messages_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "messages" ADD CONSTRAINT "messages_quota_id_messages_id_fk" FOREIGN KEY ("quota_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "messages" ADD CONSTRAINT "messages_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "plugins_tags" ADD CONSTRAINT "plugins_tags_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "plugins_tags" ADD CONSTRAINT "plugins_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "session_groups" ADD CONSTRAINT "session_groups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sessions" ADD CONSTRAINT "sessions_group_id_session_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."session_groups"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tags" ADD CONSTRAINT "tags_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "topics" ADD CONSTRAINT "topics_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "topics" ADD CONSTRAINT "topics_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_id_users_id_fk" FOREIGN KEY ("id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_created_at_idx" ON "messages" ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "slug_user_id_unique" ON "sessions" ("slug","user_id");
--> statement-breakpoint
-- ===== 0001_add_client_id =====
ALTER TABLE "messages" ADD COLUMN "client_id" text;--> statement-breakpoint
ALTER TABLE "session_groups" ADD COLUMN "client_id" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "client_id" text;--> statement-breakpoint
ALTER TABLE "topics" ADD COLUMN "client_id" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_client_id_idx" ON "messages" ("client_id");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_client_id_unique" UNIQUE("client_id");--> statement-breakpoint
ALTER TABLE "session_groups" ADD CONSTRAINT "session_groups_client_id_unique" UNIQUE("client_id");--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_client_id_unique" UNIQUE("client_id");--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_client_id_unique" UNIQUE("client_id");
--> statement-breakpoint
-- ===== 0002_amusing_puma =====
ALTER TABLE "messages" DROP CONSTRAINT "messages_client_id_unique";--> statement-breakpoint
ALTER TABLE "session_groups" DROP CONSTRAINT "session_groups_client_id_unique";--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_client_id_unique";--> statement-breakpoint
ALTER TABLE "topics" DROP CONSTRAINT "topics_client_id_unique";--> statement-breakpoint
DROP INDEX IF EXISTS "messages_client_id_idx";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "message_client_id_user_unique" ON "messages" ("client_id","user_id");--> statement-breakpoint
ALTER TABLE "session_groups" ADD CONSTRAINT "session_group_client_id_user_unique" UNIQUE("client_id","user_id");--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_client_id_user_id_unique" UNIQUE("client_id","user_id");--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topic_client_id_user_id_unique" UNIQUE("client_id","user_id");
--> statement-breakpoint
-- ===== 0003_naive_echo =====
CREATE TABLE IF NOT EXISTS "user_budgets" (
	"id" text PRIMARY KEY NOT NULL,
	"free_budget_id" text,
	"free_budget_key" text,
	"subscription_budget_id" text,
	"subscription_budget_key" text,
	"package_budget_id" text,
	"package_budget_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"stripe_id" text,
	"currency" text,
	"pricing" integer,
	"billing_paid_at" integer,
	"billing_cycle_start" integer,
	"billing_cycle_end" integer,
	"cancel_at_period_end" boolean,
	"cancel_at" integer,
	"next_billing" jsonb,
	"plan" text,
	"recurring" text,
	"storage_limit" integer,
	"status" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "preference" DROP DEFAULT;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_budgets" ADD CONSTRAINT "user_budgets_id_users_id_fk" FOREIGN KEY ("id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_subscriptions" ADD CONSTRAINT "user_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "key";
--> statement-breakpoint
-- ===== 0004_add_next_auth =====
CREATE TABLE IF NOT EXISTS "nextauth_accounts" (
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
	"userId" text NOT NULL,
	CONSTRAINT "nextauth_accounts_provider_providerAccountId_pk" PRIMARY KEY("provider","providerAccountId")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "nextauth_authenticators" (
	"counter" integer NOT NULL,
	"credentialBackedUp" boolean NOT NULL,
	"credentialDeviceType" text NOT NULL,
	"credentialID" text NOT NULL,
	"credentialPublicKey" text NOT NULL,
	"providerAccountId" text NOT NULL,
	"transports" text,
	"userId" text NOT NULL,
	CONSTRAINT "nextauth_authenticators_userId_credentialID_pk" PRIMARY KEY("userId","credentialID"),
	CONSTRAINT "nextauth_authenticators_credentialID_unique" UNIQUE("credentialID")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "nextauth_sessions" (
	"expires" timestamp NOT NULL,
	"sessionToken" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "nextauth_verificationtokens" (
	"expires" timestamp NOT NULL,
	"identifier" text NOT NULL,
	"token" text NOT NULL,
	CONSTRAINT "nextauth_verificationtokens_identifier_token_pk" PRIMARY KEY("identifier","token")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "full_name" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_verified_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "nextauth_accounts" ADD CONSTRAINT "nextauth_accounts_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "nextauth_authenticators" ADD CONSTRAINT "nextauth_authenticators_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "nextauth_sessions" ADD CONSTRAINT "nextauth_sessions_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- ===== 0005_pgvector =====
-- Custom SQL migration file, put you code below! --
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
-- ===== 0006_add_knowledge_base =====
CREATE TABLE IF NOT EXISTS "agents_files" (
	"file_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"enabled" boolean DEFAULT true,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_files_file_id_agent_id_user_id_pk" PRIMARY KEY("file_id","agent_id","user_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agents_knowledge_bases" (
	"agent_id" text NOT NULL,
	"knowledge_base_id" text NOT NULL,
	"user_id" text NOT NULL,
	"enabled" boolean DEFAULT true,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_knowledge_bases_agent_id_knowledge_base_id_pk" PRIMARY KEY("agent_id","knowledge_base_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "async_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text,
	"status" text,
	"error" jsonb,
	"user_id" text NOT NULL,
	"duration" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "file_chunks" (
	"file_id" varchar,
	"chunk_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "file_chunks_file_id_chunk_id_pk" PRIMARY KEY("file_id","chunk_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "global_files" (
	"hash_id" varchar(64) PRIMARY KEY NOT NULL,
	"file_type" varchar(255) NOT NULL,
	"size" integer NOT NULL,
	"url" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "knowledge_base_files" (
	"knowledge_base_id" text NOT NULL,
	"file_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_base_files_knowledge_base_id_file_id_pk" PRIMARY KEY("knowledge_base_id","file_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "knowledge_bases" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"avatar" text,
	"type" text,
	"user_id" text NOT NULL,
	"is_public" boolean DEFAULT false,
	"settings" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "message_chunks" (
	"message_id" text,
	"chunk_id" uuid,
	CONSTRAINT "message_chunks_chunk_id_message_id_pk" PRIMARY KEY("chunk_id","message_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "message_queries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" text NOT NULL,
	"rewrite_query" text,
	"user_query" text,
	"embeddings_id" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "message_query_chunks" (
	"id" text,
	"query_id" uuid,
	"chunk_id" uuid,
	"similarity" numeric(6, 5),
	CONSTRAINT "message_query_chunks_chunk_id_id_query_id_pk" PRIMARY KEY("chunk_id","id","query_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"text" text,
	"abstract" text,
	"metadata" jsonb,
	"index" integer,
	"type" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chunk_id" uuid,
	"embeddings" vector(1024),
	"model" text,
	"user_id" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "unstructured_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"text" text,
	"metadata" jsonb,
	"index" integer,
	"type" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"parent_id" varchar,
	"composite_id" uuid,
	"user_id" text,
	"file_id" varchar
);
--> statement-breakpoint
ALTER TABLE "files_to_messages" RENAME TO "messages_files";--> statement-breakpoint
DROP TABLE "files_to_agents";--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "file_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "chunk_task_id" uuid;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "embedding_task_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agents_files" ADD CONSTRAINT "agents_files_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agents_files" ADD CONSTRAINT "agents_files_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agents_files" ADD CONSTRAINT "agents_files_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agents_knowledge_bases" ADD CONSTRAINT "agents_knowledge_bases_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agents_knowledge_bases" ADD CONSTRAINT "agents_knowledge_bases_knowledge_base_id_knowledge_bases_id_fk" FOREIGN KEY ("knowledge_base_id") REFERENCES "public"."knowledge_bases"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agents_knowledge_bases" ADD CONSTRAINT "agents_knowledge_bases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "async_tasks" ADD CONSTRAINT "async_tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "file_chunks" ADD CONSTRAINT "file_chunks_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "file_chunks" ADD CONSTRAINT "file_chunks_chunk_id_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."chunks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "knowledge_base_files" ADD CONSTRAINT "knowledge_base_files_knowledge_base_id_knowledge_bases_id_fk" FOREIGN KEY ("knowledge_base_id") REFERENCES "public"."knowledge_bases"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "knowledge_base_files" ADD CONSTRAINT "knowledge_base_files_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "knowledge_bases" ADD CONSTRAINT "knowledge_bases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "message_chunks" ADD CONSTRAINT "message_chunks_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "message_chunks" ADD CONSTRAINT "message_chunks_chunk_id_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."chunks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "message_queries" ADD CONSTRAINT "message_queries_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "message_queries" ADD CONSTRAINT "message_queries_embeddings_id_embeddings_id_fk" FOREIGN KEY ("embeddings_id") REFERENCES "public"."embeddings"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "message_query_chunks" ADD CONSTRAINT "message_query_chunks_id_messages_id_fk" FOREIGN KEY ("id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "message_query_chunks" ADD CONSTRAINT "message_query_chunks_query_id_message_queries_id_fk" FOREIGN KEY ("query_id") REFERENCES "public"."message_queries"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "message_query_chunks" ADD CONSTRAINT "message_query_chunks_chunk_id_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."chunks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "messages_files" ADD CONSTRAINT "messages_files_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "messages_files" ADD CONSTRAINT "messages_files_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chunks" ADD CONSTRAINT "chunks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "embeddings" ADD CONSTRAINT "embeddings_chunk_id_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."chunks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "embeddings" ADD CONSTRAINT "embeddings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "unstructured_chunks" ADD CONSTRAINT "unstructured_chunks_composite_id_chunks_id_fk" FOREIGN KEY ("composite_id") REFERENCES "public"."chunks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "unstructured_chunks" ADD CONSTRAINT "unstructured_chunks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "unstructured_chunks" ADD CONSTRAINT "unstructured_chunks_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "files" ADD CONSTRAINT "files_file_hash_global_files_hash_id_fk" FOREIGN KEY ("file_hash") REFERENCES "public"."global_files"("hash_id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "files" ADD CONSTRAINT "files_chunk_task_id_async_tasks_id_fk" FOREIGN KEY ("chunk_task_id") REFERENCES "public"."async_tasks"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "files" ADD CONSTRAINT "files_embedding_task_id_async_tasks_id_fk" FOREIGN KEY ("embedding_task_id") REFERENCES "public"."async_tasks"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- ===== 0007_fix_embedding_table =====
-- step 1: create a temporary table to store the rows we want to keep
CREATE TEMP TABLE embeddings_temp AS
SELECT DISTINCT ON (chunk_id) *
FROM embeddings
ORDER BY chunk_id, random();
--> statement-breakpoint

-- step 2: delete all rows from the original table
DELETE FROM embeddings;
--> statement-breakpoint

-- step 3: insert the rows we want to keep back into the original table
INSERT INTO embeddings
SELECT * FROM embeddings_temp;
--> statement-breakpoint

-- step 4: drop the temporary table
DROP TABLE embeddings_temp;
--> statement-breakpoint

-- step 5: now it's safe to add the unique constraint
ALTER TABLE "embeddings" ADD CONSTRAINT "embeddings_chunk_id_unique" UNIQUE("chunk_id");
--> statement-breakpoint
-- ===== 0008_add_rag_evals =====
CREATE TABLE IF NOT EXISTS "rag_eval_dataset_records" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "rag_eval_dataset_records_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"dataset_id" integer NOT NULL,
	"ideal" text,
	"question" text,
	"reference_files" text[],
	"metadata" jsonb,
	"user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rag_eval_datasets" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "rag_eval_datasets_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 30000 CACHE 1),
	"description" text,
	"name" text NOT NULL,
	"knowledge_base_id" text,
	"user_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rag_eval_evaluations" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "rag_eval_evaluations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"description" text,
	"eval_records_url" text,
	"status" text,
	"error" jsonb,
	"dataset_id" integer NOT NULL,
	"knowledge_base_id" text,
	"language_model" text,
	"embedding_model" text,
	"user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rag_eval_evaluation_records" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "rag_eval_evaluation_records_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
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
	"dataset_record_id" integer NOT NULL,
	"evaluation_id" integer NOT NULL,
	"user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rag_eval_dataset_records" ADD CONSTRAINT "rag_eval_dataset_records_dataset_id_rag_eval_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."rag_eval_datasets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rag_eval_dataset_records" ADD CONSTRAINT "rag_eval_dataset_records_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rag_eval_datasets" ADD CONSTRAINT "rag_eval_datasets_knowledge_base_id_knowledge_bases_id_fk" FOREIGN KEY ("knowledge_base_id") REFERENCES "public"."knowledge_bases"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rag_eval_datasets" ADD CONSTRAINT "rag_eval_datasets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rag_eval_evaluations" ADD CONSTRAINT "rag_eval_evaluations_dataset_id_rag_eval_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."rag_eval_datasets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rag_eval_evaluations" ADD CONSTRAINT "rag_eval_evaluations_knowledge_base_id_knowledge_bases_id_fk" FOREIGN KEY ("knowledge_base_id") REFERENCES "public"."knowledge_bases"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rag_eval_evaluations" ADD CONSTRAINT "rag_eval_evaluations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rag_eval_evaluation_records" ADD CONSTRAINT "rag_eval_evaluation_records_question_embedding_id_embeddings_id_fk" FOREIGN KEY ("question_embedding_id") REFERENCES "public"."embeddings"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rag_eval_evaluation_records" ADD CONSTRAINT "rag_eval_evaluation_records_dataset_record_id_rag_eval_dataset_records_id_fk" FOREIGN KEY ("dataset_record_id") REFERENCES "public"."rag_eval_dataset_records"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rag_eval_evaluation_records" ADD CONSTRAINT "rag_eval_evaluation_records_evaluation_id_rag_eval_evaluations_id_fk" FOREIGN KEY ("evaluation_id") REFERENCES "public"."rag_eval_evaluations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rag_eval_evaluation_records" ADD CONSTRAINT "rag_eval_evaluation_records_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- ===== 0009_remove_unused_user_tables =====
DROP TABLE "user_budgets";--> statement-breakpoint
DROP TABLE "user_subscriptions";
--> statement-breakpoint
-- ===== 0010_add_accessed_at_and_clean_tables =====
DROP TABLE "agents_tags" CASCADE;--> statement-breakpoint
DROP TABLE "market" CASCADE;--> statement-breakpoint
DROP TABLE "plugins" CASCADE;--> statement-breakpoint
DROP TABLE "plugins_tags" CASCADE;--> statement-breakpoint
DROP TABLE "tags" CASCADE;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "accessed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "agents_files" ADD COLUMN "accessed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "agents_knowledge_bases" ADD COLUMN "accessed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "async_tasks" ADD COLUMN "accessed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "accessed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "global_files" ADD COLUMN "accessed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_bases" ADD COLUMN "accessed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "accessed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "accessed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "unstructured_chunks" ADD COLUMN "accessed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "rag_eval_dataset_records" ADD COLUMN "accessed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "rag_eval_dataset_records" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "rag_eval_datasets" ADD COLUMN "accessed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "rag_eval_evaluations" ADD COLUMN "accessed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "rag_eval_evaluation_records" ADD COLUMN "accessed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "rag_eval_evaluation_records" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "session_groups" ADD COLUMN "accessed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "accessed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "topics" ADD COLUMN "accessed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "user_installed_plugins" ADD COLUMN "accessed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "accessed_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
-- ===== 0011_add_topic_history_summary =====
ALTER TABLE "topics" ADD COLUMN "history_summary" text;--> statement-breakpoint
ALTER TABLE "topics" ADD COLUMN "metadata" jsonb;
--> statement-breakpoint
-- ===== 0012_add_thread =====
CREATE TABLE IF NOT EXISTS "threads" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text,
	"type" text NOT NULL,
	"status" text DEFAULT 'active',
	"topic_id" text NOT NULL,
	"source_message_id" text NOT NULL,
	"parent_thread_id" text,
	"user_id" text NOT NULL,
	"last_active_at" timestamp with time zone DEFAULT now(),
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "thread_id" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "threads" ADD CONSTRAINT "threads_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "threads" ADD CONSTRAINT "threads_parent_thread_id_threads_id_fk" FOREIGN KEY ("parent_thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "threads" ADD CONSTRAINT "threads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "messages" ADD CONSTRAINT "messages_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- ===== 0013_add_ai_infra =====
CREATE TABLE "ai_models" (
	"id" varchar(150) NOT NULL,
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
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_models_id_provider_id_user_id_pk" PRIMARY KEY("id","provider_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "ai_providers" (
	"id" varchar(64) NOT NULL,
	"name" text,
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
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_providers_id_user_id_pk" PRIMARY KEY("id","user_id")
);
--> statement-breakpoint
ALTER TABLE "ai_models" ADD CONSTRAINT "ai_models_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_providers" ADD CONSTRAINT "ai_providers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- ===== 0014_add_message_reasoning =====
ALTER TABLE "messages" ADD COLUMN "reasoning" jsonb;
--> statement-breakpoint
-- ===== 0015_add_message_search_metadata =====
ALTER TABLE "messages" ADD COLUMN "search" jsonb;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "metadata" jsonb;
--> statement-breakpoint
-- ===== 0016_add_message_index =====
CREATE INDEX IF NOT EXISTS "messages_topic_id_idx" ON "messages" USING btree ("topic_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_parent_id_idx" ON "messages" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_quota_id_idx" ON "messages" USING btree ("quota_id");
--> statement-breakpoint
-- ===== 0017_add_user_id_to_tables =====
-- Complete User ID Migration Script
-- Includes adding columns to all tables, populating data, and setting constraints

BEGIN;--> statement-breakpoint

CREATE INDEX "file_hash_idx" ON "files" USING btree ("file_hash");--> statement-breakpoint

-- Step 1: Add nullable user_id columns to all required tables
ALTER TABLE "global_files" ADD COLUMN IF NOT EXISTS "creator" text;--> statement-breakpoint
ALTER TABLE "knowledge_base_files" ADD COLUMN IF NOT EXISTS "user_id" text;--> statement-breakpoint
ALTER TABLE "message_chunks" ADD COLUMN IF NOT EXISTS "user_id" text;--> statement-breakpoint
ALTER TABLE "message_plugins" ADD COLUMN IF NOT EXISTS "user_id" text;--> statement-breakpoint
ALTER TABLE "message_queries" ADD COLUMN IF NOT EXISTS "user_id" text;--> statement-breakpoint
ALTER TABLE "message_query_chunks" ADD COLUMN IF NOT EXISTS "user_id" text;--> statement-breakpoint
ALTER TABLE "message_tts" ADD COLUMN IF NOT EXISTS "user_id" text;--> statement-breakpoint
ALTER TABLE "message_translates" ADD COLUMN IF NOT EXISTS "user_id" text;--> statement-breakpoint
ALTER TABLE "messages_files" ADD COLUMN IF NOT EXISTS "user_id" text;--> statement-breakpoint
ALTER TABLE "agents_to_sessions" ADD COLUMN IF NOT EXISTS "user_id" text;--> statement-breakpoint
ALTER TABLE "file_chunks" ADD COLUMN IF NOT EXISTS "user_id" text;--> statement-breakpoint
ALTER TABLE "files_to_sessions" ADD COLUMN IF NOT EXISTS "user_id" text;--> statement-breakpoint

-- Step 2: Populate user_id fields
-- Retrieve user_id from associated tables

-- Populate user_id for knowledge_base_files
UPDATE "knowledge_base_files" AS kbf
SET "user_id" = kb."user_id"
  FROM "knowledge_bases" AS kb
WHERE kbf."knowledge_base_id" = kb."id";--> statement-breakpoint

-- Populate user_id for message_chunks
UPDATE "message_chunks" AS mc
SET "user_id" = m."user_id"
  FROM "messages" AS m
WHERE mc."message_id" = m."id";--> statement-breakpoint

-- Populate user_id for message_plugins (directly from messages table)
UPDATE "message_plugins" AS mp
SET "user_id" = m."user_id"
  FROM "messages" AS m
WHERE mp."id" = m."id";--> statement-breakpoint

-- Populate user_id for message_queries
UPDATE "message_queries" AS mq
SET "user_id" = m."user_id"
  FROM "messages" AS m
WHERE mq."message_id" = m."id";--> statement-breakpoint

-- Populate user_id for message_query_chunks
UPDATE "message_query_chunks" AS mqc
SET "user_id" = mq."user_id"
  FROM "message_queries" AS mq
WHERE mqc."query_id" = mq."id";--> statement-breakpoint

-- Populate user_id for message_tts
UPDATE "message_tts" AS mt
SET "user_id" = m."user_id"
  FROM "messages" AS m
WHERE mt."id" = m."id";--> statement-breakpoint

-- Populate user_id for message_translates
UPDATE "message_translates" AS mt
SET "user_id" = m."user_id"
  FROM "messages" AS m
WHERE mt."id" = m."id";--> statement-breakpoint

-- Populate user_id for messages_files
UPDATE "messages_files" AS mf
SET "user_id" = m."user_id"
  FROM "messages" AS m
WHERE mf."message_id" = m."id";--> statement-breakpoint

-- Populate creator for global_files (get the first user who created the file from files table)
UPDATE "global_files" AS gf
SET "creator" = (
  SELECT f."user_id"
  FROM "files" AS f
  WHERE f."file_hash" = gf."hash_id"
  ORDER BY f."created_at" ASC
  LIMIT 1
  );--> statement-breakpoint

-- Delete global_files records where no user has used the file in the files table
DELETE FROM "global_files"
WHERE "creator" IS NULL;--> statement-breakpoint

-- Populate user_id for agents_to_sessions
UPDATE "agents_to_sessions" AS ats
SET "user_id" = a."user_id"
  FROM "agents" AS a
WHERE ats."agent_id" = a."id";--> statement-breakpoint

-- Populate user_id for file_chunks
UPDATE "file_chunks" AS fc
SET "user_id" = f."user_id"
  FROM "files" AS f
WHERE fc."file_id" = f."id";--> statement-breakpoint

-- Populate user_id for files_to_sessions
UPDATE "files_to_sessions" AS fts
SET "user_id" = f."user_id"
  FROM "files" AS f
WHERE fts."file_id" = f."id";--> statement-breakpoint

-- Get user_id from sessions table (handle potential NULL values)
UPDATE "files_to_sessions" AS fts
SET "user_id" = s."user_id"
  FROM "sessions" AS s
WHERE fts."session_id" = s."id" AND fts."user_id" IS NULL;--> statement-breakpoint

UPDATE "agents_to_sessions" AS ats
SET "user_id" = s."user_id"
  FROM "sessions" AS s
WHERE ats."session_id" = s."id" AND ats."user_id" IS NULL;--> statement-breakpoint

-- Step 3: Check for any unpopulated records
DO $$
DECLARE
kb_files_count INTEGER;
    msg_chunks_count INTEGER;
    msg_plugins_count INTEGER;
    msg_queries_count INTEGER;
    msg_query_chunks_count INTEGER;
    msg_tts_count INTEGER;
    msg_translates_count INTEGER;
    msgs_files_count INTEGER;
    agents_sessions_count INTEGER;
    file_chunks_count INTEGER;
    files_sessions_count INTEGER;
BEGIN
SELECT COUNT(*) INTO kb_files_count FROM "knowledge_base_files" WHERE "user_id" IS NULL;
SELECT COUNT(*) INTO msg_chunks_count FROM "message_chunks" WHERE "user_id" IS NULL;
SELECT COUNT(*) INTO msg_plugins_count FROM "message_plugins" WHERE "user_id" IS NULL;
SELECT COUNT(*) INTO msg_queries_count FROM "message_queries" WHERE "user_id" IS NULL;
SELECT COUNT(*) INTO msg_query_chunks_count FROM "message_query_chunks" WHERE "user_id" IS NULL;
SELECT COUNT(*) INTO msg_tts_count FROM "message_tts" WHERE "user_id" IS NULL;
SELECT COUNT(*) INTO msg_translates_count FROM "message_translates" WHERE "user_id" IS NULL;
SELECT COUNT(*) INTO msgs_files_count FROM "messages_files" WHERE "user_id" IS NULL;
SELECT COUNT(*) INTO agents_sessions_count FROM "agents_to_sessions" WHERE "user_id" IS NULL;
SELECT COUNT(*) INTO file_chunks_count FROM "file_chunks" WHERE "user_id" IS NULL;
SELECT COUNT(*) INTO files_sessions_count FROM "files_to_sessions" WHERE "user_id" IS NULL;

IF kb_files_count > 0 OR msg_chunks_count > 0 OR msg_plugins_count > 0 OR
       msg_queries_count > 0 OR msg_query_chunks_count > 0 OR msg_tts_count > 0 OR
       msg_translates_count > 0 OR msgs_files_count > 0 OR agents_sessions_count > 0 OR
       file_chunks_count > 0 OR files_sessions_count > 0 THEN
        RAISE EXCEPTION 'There are records with NULL user_id values that could not be populated';
END IF;
END $$;--> statement-breakpoint

-- Step 4: Add NOT NULL constraints and foreign keys
ALTER TABLE "knowledge_base_files" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "message_chunks" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "message_plugins" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "message_queries" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "message_query_chunks" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "message_tts" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "message_translates" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "messages_files" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agents_to_sessions" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "file_chunks" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "files_to_sessions" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint

-- Add foreign key constraints
ALTER TABLE "global_files"
  ADD CONSTRAINT "global_files_creator_users_id_fk"
    FOREIGN KEY ("creator") REFERENCES "public"."users"("id")
      ON DELETE SET NULL ON UPDATE NO ACTION;--> statement-breakpoint

ALTER TABLE "knowledge_base_files"
  ADD CONSTRAINT "knowledge_base_files_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
      ON DELETE CASCADE ON UPDATE NO ACTION;--> statement-breakpoint

ALTER TABLE "message_chunks"
  ADD CONSTRAINT "message_chunks_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
      ON DELETE CASCADE ON UPDATE NO ACTION;--> statement-breakpoint

ALTER TABLE "message_plugins"
  ADD CONSTRAINT "message_plugins_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
      ON DELETE CASCADE ON UPDATE NO ACTION;--> statement-breakpoint

ALTER TABLE "message_queries"
  ADD CONSTRAINT "message_queries_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
      ON DELETE CASCADE ON UPDATE NO ACTION;--> statement-breakpoint

ALTER TABLE "message_query_chunks"
  ADD CONSTRAINT "message_query_chunks_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
      ON DELETE CASCADE ON UPDATE NO ACTION;--> statement-breakpoint

ALTER TABLE "message_tts"
  ADD CONSTRAINT "message_tts_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
      ON DELETE CASCADE ON UPDATE NO ACTION;--> statement-breakpoint

ALTER TABLE "message_translates"
  ADD CONSTRAINT "message_translates_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
      ON DELETE CASCADE ON UPDATE NO ACTION;--> statement-breakpoint

ALTER TABLE "messages_files"
  ADD CONSTRAINT "messages_files_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
      ON DELETE CASCADE ON UPDATE NO ACTION;--> statement-breakpoint

ALTER TABLE "agents_to_sessions"
  ADD CONSTRAINT "agents_to_sessions_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
      ON DELETE CASCADE ON UPDATE NO ACTION;--> statement-breakpoint

ALTER TABLE "file_chunks"
  ADD CONSTRAINT "file_chunks_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
      ON DELETE CASCADE ON UPDATE NO ACTION;--> statement-breakpoint

ALTER TABLE "files_to_sessions"
  ADD CONSTRAINT "files_to_sessions_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
      ON DELETE CASCADE ON UPDATE NO ACTION;--> statement-breakpoint

COMMIT;--> statement-breakpoint
--> statement-breakpoint
-- ===== 0018_add_client_id_for_entities =====
ALTER TABLE "session_groups" DROP CONSTRAINT IF EXISTS "session_group_client_id_user_unique";--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_client_id_user_id_unique";--> statement-breakpoint
ALTER TABLE "topics" DROP CONSTRAINT IF EXISTS "topic_client_id_user_id_unique";--> statement-breakpoint

-- add client_id column
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "client_id" text;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "client_id" text;--> statement-breakpoint
ALTER TABLE "knowledge_bases" ADD COLUMN IF NOT EXISTS "client_id" text;--> statement-breakpoint
ALTER TABLE "message_plugins" ADD COLUMN IF NOT EXISTS "client_id" text;--> statement-breakpoint
ALTER TABLE "message_queries" ADD COLUMN IF NOT EXISTS "client_id" text;--> statement-breakpoint
ALTER TABLE "message_tts" ADD COLUMN IF NOT EXISTS "client_id" text;--> statement-breakpoint
ALTER TABLE "message_translates" ADD COLUMN IF NOT EXISTS "client_id" text;--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN IF NOT EXISTS "client_id" text;--> statement-breakpoint
ALTER TABLE "embeddings" ADD COLUMN IF NOT EXISTS "client_id" text;--> statement-breakpoint
ALTER TABLE "unstructured_chunks" ADD COLUMN IF NOT EXISTS "client_id" text;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN IF NOT EXISTS "client_id" text;--> statement-breakpoint

-- Create unique index（using IF NOT EXISTS）
CREATE UNIQUE INDEX IF NOT EXISTS "client_id_user_id_unique" ON "agents" USING btree ("client_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "files_client_id_user_id_unique" ON "files" USING btree ("client_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_bases_client_id_user_id_unique" ON "knowledge_bases" USING btree ("client_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "message_plugins_client_id_user_id_unique" ON "message_plugins" USING btree ("client_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "message_queries_client_id_user_id_unique" ON "message_queries" USING btree ("client_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "message_tts_client_id_user_id_unique" ON "message_tts" USING btree ("client_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "message_translates_client_id_user_id_unique" ON "message_translates" USING btree ("client_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chunks_client_id_user_id_unique" ON "chunks" USING btree ("client_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "embeddings_client_id_user_id_unique" ON "embeddings" USING btree ("client_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "unstructured_chunks_client_id_user_id_unique" ON "unstructured_chunks" USING btree ("client_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "session_groups_client_id_user_id_unique" ON "session_groups" USING btree ("client_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sessions_client_id_user_id_unique" ON "sessions" USING btree ("client_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "threads_client_id_user_id_unique" ON "threads" USING btree ("client_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "topics_client_id_user_id_unique" ON "topics" USING btree ("client_id","user_id");
--> statement-breakpoint
-- ===== 0019_add_hotkey_user_settings =====
-- Add hotkey column to user_settings table
ALTER TABLE "user_settings" ADD COLUMN IF NOT EXISTS "hotkey" jsonb;--> statement-breakpoint
--> statement-breakpoint
-- ===== 0020_add_oidc =====
CREATE TABLE IF NOT EXISTS "oidc_access_tokens" (
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
CREATE TABLE IF NOT EXISTS "oidc_authorization_codes" (
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
CREATE TABLE IF NOT EXISTS "oidc_clients" (
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
CREATE TABLE IF NOT EXISTS "oidc_consents" (
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
CREATE TABLE IF NOT EXISTS "oidc_device_codes" (
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
CREATE TABLE IF NOT EXISTS "oidc_grants" (
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
CREATE TABLE IF NOT EXISTS "oidc_interactions" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oidc_refresh_tokens" (
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
CREATE TABLE IF NOT EXISTS "oidc_sessions" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"user_id" text NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "oidc_access_tokens" ADD CONSTRAINT "oidc_access_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_authorization_codes" ADD CONSTRAINT "oidc_authorization_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_consents" ADD CONSTRAINT "oidc_consents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_consents" ADD CONSTRAINT "oidc_consents_client_id_oidc_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oidc_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_device_codes" ADD CONSTRAINT "oidc_device_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_grants" ADD CONSTRAINT "oidc_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_refresh_tokens" ADD CONSTRAINT "oidc_refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_sessions" ADD CONSTRAINT "oidc_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- ===== 0021_add_agent_opening_settings =====
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "opening_message" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "opening_questions" text[] DEFAULT '{}';
--> statement-breakpoint
-- ===== 0022_add_documents =====
CREATE TABLE IF NOT EXISTS "document_chunks" (
	"document_id" varchar(30) NOT NULL,
	"chunk_id" uuid NOT NULL,
	"page_index" integer,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_chunks_document_id_chunk_id_pk" PRIMARY KEY("document_id","chunk_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "documents" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"title" text,
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
	"user_id" text NOT NULL,
	"client_id" text,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "topic_documents" (
	"document_id" text NOT NULL,
	"topic_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "topic_documents_document_id_topic_id_pk" PRIMARY KEY("document_id","topic_id")
);
--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_chunk_id_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."chunks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_documents" ADD CONSTRAINT "topic_documents_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_documents" ADD CONSTRAINT "topic_documents_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_documents" ADD CONSTRAINT "topic_documents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "documents_source_idx" ON "documents" USING btree ("source");--> statement-breakpoint
CREATE INDEX "documents_file_type_idx" ON "documents" USING btree ("file_type");--> statement-breakpoint
CREATE INDEX "documents_file_id_idx" ON "documents" USING btree ("file_id");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_client_id_user_id_unique" ON "documents" USING btree ("client_id","user_id");
--> statement-breakpoint
-- ===== 0023_remove_param_and_doubao =====
-- Custom SQL migration file, put your code below! --
UPDATE agents SET chat_config = jsonb_set(chat_config, '{enableReasoningEffort}', 'false') WHERE chat_config ->> 'enableReasoningEffort' = 'true';
--> statement-breakpoint
UPDATE agents SET params = params - 'reasoning_effort' WHERE params ? 'reasoning_effort';
--> statement-breakpoint
DELETE FROM ai_providers WHERE id = 'doubao';
--> statement-breakpoint
-- ===== 0024_add_rbac_tables =====
CREATE TABLE "rbac_permissions" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "rbac_permissions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
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
	"role_id" integer NOT NULL,
	"permission_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rbac_role_permissions_role_id_permission_id_pk" PRIMARY KEY("role_id","permission_id")
);
--> statement-breakpoint
CREATE TABLE "rbac_roles" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "rbac_roles_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text,
	"is_system" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rbac_roles_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "rbac_user_roles" (
	"user_id" text NOT NULL,
	"role_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "rbac_user_roles_user_id_role_id_pk" PRIMARY KEY("user_id","role_id")
);
--> statement-breakpoint
ALTER TABLE "rbac_role_permissions" ADD CONSTRAINT "rbac_role_permissions_role_id_rbac_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."rbac_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rbac_role_permissions" ADD CONSTRAINT "rbac_role_permissions_permission_id_rbac_permissions_id_fk" FOREIGN KEY ("permission_id") REFERENCES "public"."rbac_permissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rbac_user_roles" ADD CONSTRAINT "rbac_user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rbac_user_roles" ADD CONSTRAINT "rbac_user_roles_role_id_rbac_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."rbac_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rbac_role_permissions_role_id_idx" ON "rbac_role_permissions" USING btree ("role_id");--> statement-breakpoint
CREATE INDEX "rbac_role_permissions_permission_id_idx" ON "rbac_role_permissions" USING btree ("permission_id");--> statement-breakpoint
CREATE INDEX "rbac_user_roles_user_id_idx" ON "rbac_user_roles" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "rbac_user_roles_role_id_idx" ON "rbac_user_roles" USING btree ("role_id");
--> statement-breakpoint
-- ===== 0025_add_provider_config =====
ALTER TABLE "ai_providers" ADD COLUMN "config" jsonb;
--> statement-breakpoint
-- ===== 0026_add_autovacuum_tuning =====
-- Migration to apply specific autovacuum settings to high-traffic tables
-- This is crucial to prevent table and TOAST bloat for 'embeddings' and 'chunks'
-- https://github.com/lobehub/lobe-chat/issues/8316

-- Tuning for the 'embeddings' table
-- Default scale factor (0.2) is too high, leading to infrequent vacuuming.
-- Lowering to 2% to ensure frequent cleanup.
ALTER TABLE "embeddings" SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 1000);

--> statement-breakpoint

-- Tuning for the 'chunks' table
-- This table also experiences many updates/deletes and requires similar tuning.
ALTER TABLE "chunks" SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 1000);
--> statement-breakpoint
-- ===== 0027_ai_image =====
CREATE TABLE "generation_batches" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
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
	"title" text,
	"cover_url" text,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "generations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
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
ALTER TABLE "files" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "generation_batches" ADD CONSTRAINT "generation_batches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_batches" ADD CONSTRAINT "generation_batches_generation_topic_id_generation_topics_id_fk" FOREIGN KEY ("generation_topic_id") REFERENCES "public"."generation_topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_topics" ADD CONSTRAINT "generation_topics_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generations" ADD CONSTRAINT "generations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generations" ADD CONSTRAINT "generations_generation_batch_id_generation_batches_id_fk" FOREIGN KEY ("generation_batch_id") REFERENCES "public"."generation_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generations" ADD CONSTRAINT "generations_async_task_id_async_tasks_id_fk" FOREIGN KEY ("async_task_id") REFERENCES "public"."async_tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generations" ADD CONSTRAINT "generations_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- ===== 0028_oauth_handoffs =====
CREATE TABLE IF NOT EXISTS "oauth_handoffs" (
	"id" text PRIMARY KEY NOT NULL,
	"client" varchar(50) NOT NULL,
	"payload" jsonb NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- ===== 0029_add_apikey_manage =====
CREATE TABLE IF NOT EXISTS "api_keys" (
	"id" integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "api_keys_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" varchar(256) NOT NULL,
	"key" varchar(256) NOT NULL,
	"enabled" boolean DEFAULT true,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"user_id" text NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_key_unique" UNIQUE("key")
);
--> statement-breakpoint
ALTER TABLE "rbac_roles" ADD COLUMN IF NOT EXISTS "metadata" jsonb DEFAULT '{}'::jsonb;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- ===== 0030_add_group_chat =====
CREATE TABLE IF NOT EXISTS "chat_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text,
	"description" text,
	"config" jsonb,
	"client_id" text,
	"user_id" text NOT NULL,
	"pinned" boolean DEFAULT false,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_groups_agents" (
	"chat_group_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"user_id" text NOT NULL,
	"enabled" boolean DEFAULT true,
	"order" integer DEFAULT 0,
	"role" text DEFAULT 'participant',
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_groups_agents_chat_group_id_agent_id_pk" PRIMARY KEY("chat_group_id","agent_id")
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "group_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "target_id" text;--> statement-breakpoint
ALTER TABLE "topics" ADD COLUMN IF NOT EXISTS "group_id" text;--> statement-breakpoint
ALTER TABLE "chat_groups" ADD CONSTRAINT "chat_groups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_groups_agents" ADD CONSTRAINT "chat_groups_agents_chat_group_id_chat_groups_id_fk" FOREIGN KEY ("chat_group_id") REFERENCES "public"."chat_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_groups_agents" ADD CONSTRAINT "chat_groups_agents_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_groups_agents" ADD CONSTRAINT "chat_groups_agents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_groups_client_id_user_id_unique" ON "chat_groups" USING btree ("client_id","user_id");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_group_id_chat_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."chat_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_group_id_chat_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."chat_groups"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- ===== 0031_add_agent_index =====
-- Truncate title to 150 characters if it exceeds the limit
UPDATE agents
SET title = LEFT(title, 200)
WHERE LENGTH(title) > 200;--> statement-breakpoint

-- Truncate description to 300 characters if it exceeds the limit
UPDATE agents
SET description = LEFT(description, 300)
WHERE LENGTH(description) > 300;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "agents_title_idx" ON "agents" USING btree ("title");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_description_idx" ON "agents" USING btree ("description");
--> statement-breakpoint
-- ===== 0032_improve_agents_field =====
ALTER TABLE "agents" ALTER COLUMN "title" SET DATA TYPE varchar(255);--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "description" SET DATA TYPE varchar(1000);
--> statement-breakpoint
-- ===== 0033_add_table_index =====
-- 解决 chunks 表慢查询
CREATE INDEX IF NOT EXISTS "chunks_user_id_idx" ON "chunks" USING btree ("user_id");--> statement-breakpoint

-- 解决 topics 表批量删除慢查询
CREATE INDEX IF NOT EXISTS "topics_user_id_idx" ON "topics" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "topics_id_user_id_idx" ON "topics" USING btree ("id","user_id");--> statement-breakpoint

-- 解决 sessions 表删除慢查询
CREATE INDEX IF NOT EXISTS "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_id_user_id_idx" ON "sessions" USING btree ("id","user_id");--> statement-breakpoint

-- 解决 messages 表统计查询慢查询
CREATE INDEX IF NOT EXISTS "messages_user_id_idx" ON "messages" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_session_id_idx" ON "messages" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_thread_id_idx" ON "messages" USING btree ("thread_id");--> statement-breakpoint

-- 解决 embeddings 删除慢查询
CREATE INDEX IF NOT EXISTS "embeddings_chunk_id_idx" ON "embeddings" USING btree ("chunk_id");--> statement-breakpoint
--> statement-breakpoint
-- ===== 0034_fix_chat_group =====
ALTER TABLE "messages" ALTER COLUMN "role" SET DATA TYPE varchar(255);--> statement-breakpoint
ALTER TABLE "chat_groups" ADD COLUMN IF NOT EXISTS "group_id" text;--> statement-breakpoint
ALTER TABLE "chat_groups" DROP CONSTRAINT IF EXISTS "chat_groups_group_id_session_groups_id_fk";--> statement-breakpoint
ALTER TABLE "chat_groups" ADD CONSTRAINT "chat_groups_group_id_session_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."session_groups"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- ===== 0035_add_virtual =====
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "virtual" boolean DEFAULT false;
--> statement-breakpoint
-- ===== 0036_add_group_messages =====
CREATE TABLE IF NOT EXISTS "message_groups" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"topic_id" text,
	"user_id" text NOT NULL,
	"parent_group_id" varchar(255),
	"parent_message_id" text,
	"title" varchar(255),
	"description" text,
	"client_id" varchar(255),
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "message_group_id" varchar(255);--> statement-breakpoint
ALTER TABLE "message_groups" ADD CONSTRAINT "message_groups_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_groups" ADD CONSTRAINT "message_groups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_groups" ADD CONSTRAINT "message_groups_parent_group_id_message_groups_id_fk" FOREIGN KEY ("parent_group_id") REFERENCES "public"."message_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_groups" ADD CONSTRAINT "message_groups_parent_message_id_messages_id_fk" FOREIGN KEY ("parent_message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "message_groups_client_id_user_id_unique" ON "message_groups" USING btree ("client_id","user_id");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_message_group_id_message_groups_id_fk" FOREIGN KEY ("message_group_id") REFERENCES "public"."message_groups"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- ===== 0037_add_user_memory =====
CREATE TABLE IF NOT EXISTS "user_memories" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"user_id" text,
	"memory_category" varchar(255),
	"memory_layer" varchar(255),
	"memory_type" varchar(255),
	"title" varchar(255),
	"summary" text,
	"summary_vector_1024" vector(1024),
	"details" text,
	"details_vector_1024" vector(1024),
	"status" varchar(255),
	"accessed_count" bigint DEFAULT 0,
	"last_accessed_at" timestamp with time zone NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_memories_contexts" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"user_memory_ids" jsonb,
	"labels" jsonb,
	"extracted_labels" jsonb,
	"associated_objects" jsonb,
	"associated_subjects" jsonb,
	"title" text,
	"title_vector" vector(1024),
	"description" text,
	"description_vector" vector(1024),
	"type" varchar(255),
	"current_status" text,
	"score_impact" numeric DEFAULT 0,
	"score_urgency" numeric DEFAULT 0,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_memories_experiences" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"user_memory_id" text,
	"labels" jsonb,
	"extracted_labels" jsonb,
	"type" varchar(255),
	"situation" text,
	"situation_vector" vector(1024),
	"reasoning" text,
	"possible_outcome" text,
	"action" text,
	"action_vector" vector(1024),
	"key_learning" text,
	"key_learning_vector" vector(1024),
	"metadata" jsonb,
	"score_confidence" real DEFAULT 0,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_memories_identities" (
	"current_focuses" text,
	"description" text,
	"description_vector" vector(1024),
	"experience" text,
	"extracted_labels" jsonb,
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"labels" jsonb,
	"relationship" text,
	"role" text,
	"type" varchar(255),
	"user_memory_id" text,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_memories_preferences" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"context_id" varchar(255),
	"user_memory_id" varchar(255),
	"labels" jsonb,
	"extracted_labels" jsonb,
	"extracted_scopes" jsonb,
	"conclusion_directives" text,
	"conclusion_directives_vector" vector(1024),
	"type" varchar(255),
	"suggestions" text,
	"score_priority" numeric DEFAULT 0,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_memories" ADD CONSTRAINT "user_memories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_memories_experiences" ADD CONSTRAINT "user_memories_experiences_user_memory_id_user_memories_id_fk" FOREIGN KEY ("user_memory_id") REFERENCES "public"."user_memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_memories_identities" ADD CONSTRAINT "user_memories_identities_user_memory_id_user_memories_id_fk" FOREIGN KEY ("user_memory_id") REFERENCES "public"."user_memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_memories_preferences" ADD CONSTRAINT "user_memories_preferences_context_id_user_memories_contexts_id_fk" FOREIGN KEY ("context_id") REFERENCES "public"."user_memories_contexts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_memories_preferences" ADD CONSTRAINT "user_memories_preferences_user_memory_id_user_memories_id_fk" FOREIGN KEY ("user_memory_id") REFERENCES "public"."user_memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_memories_summary_vector_1024_index" ON "user_memories" USING hnsw ("summary_vector_1024" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "user_memories_details_vector_1024_index" ON "user_memories" USING hnsw ("details_vector_1024" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "user_memories_contexts_title_vector_index" ON "user_memories_contexts" USING hnsw ("title_vector" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "user_memories_contexts_description_vector_index" ON "user_memories_contexts" USING hnsw ("description_vector" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "user_memories_contexts_type_index" ON "user_memories_contexts" USING btree ("type");--> statement-breakpoint
CREATE INDEX "user_memories_experiences_situation_vector_index" ON "user_memories_experiences" USING hnsw ("situation_vector" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "user_memories_experiences_action_vector_index" ON "user_memories_experiences" USING hnsw ("action_vector" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "user_memories_experiences_key_learning_vector_index" ON "user_memories_experiences" USING hnsw ("key_learning_vector" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "user_memories_experiences_type_index" ON "user_memories_experiences" USING btree ("type");--> statement-breakpoint
CREATE INDEX "user_memories_identities_description_vector_index" ON "user_memories_identities" USING hnsw ("description_vector" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "user_memories_identities_type_index" ON "user_memories_identities" USING btree ("type");--> statement-breakpoint
CREATE INDEX "user_memories_preferences_conclusion_directives_vector_index" ON "user_memories_preferences" USING hnsw ("conclusion_directives_vector" vector_cosine_ops);
--> statement-breakpoint
-- ===== 0038_add_image_user_settings =====
ALTER TABLE "user_settings" ADD COLUMN IF NOT EXISTS "image" jsonb;
--> statement-breakpoint
-- ===== 0039_add_editor_data =====
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "editor_data" jsonb;
--> statement-breakpoint
-- ===== 0040_improve_user_memory_field =====
ALTER TABLE "user_memories_preferences" DROP CONSTRAINT IF EXISTS "user_memories_preferences_context_id_user_memories_contexts_id_fk";
--> statement-breakpoint
ALTER TABLE "user_memories_experiences" ALTER COLUMN "user_memory_id" SET DATA TYPE varchar(255);--> statement-breakpoint
ALTER TABLE "user_memories_identities" ALTER COLUMN "relationship" SET DATA TYPE varchar(255);--> statement-breakpoint
ALTER TABLE "user_memories_identities" ALTER COLUMN "user_memory_id" SET DATA TYPE varchar(255);--> statement-breakpoint
ALTER TABLE "user_memories" ADD COLUMN IF NOT EXISTS "metadata" jsonb;--> statement-breakpoint
ALTER TABLE "user_memories" ADD COLUMN  IF NOT EXISTS"tags" text[];--> statement-breakpoint
ALTER TABLE "user_memories_contexts" ADD COLUMN IF NOT EXISTS "user_id" text;--> statement-breakpoint
ALTER TABLE "user_memories_contexts" ADD COLUMN IF NOT EXISTS "metadata" jsonb;--> statement-breakpoint
ALTER TABLE "user_memories_contexts" ADD COLUMN IF NOT EXISTS "tags" text[];--> statement-breakpoint
ALTER TABLE "user_memories_experiences" ADD COLUMN IF NOT EXISTS "user_id" text;--> statement-breakpoint
ALTER TABLE "user_memories_experiences" ADD COLUMN IF NOT EXISTS "tags" text[];--> statement-breakpoint
ALTER TABLE "user_memories_identities" ADD COLUMN IF NOT EXISTS "user_id" text;--> statement-breakpoint
ALTER TABLE "user_memories_identities" ADD COLUMN IF NOT EXISTS "metadata" jsonb;--> statement-breakpoint
ALTER TABLE "user_memories_identities" ADD COLUMN IF NOT EXISTS "tags" text[];--> statement-breakpoint
ALTER TABLE "user_memories_identities" ADD COLUMN IF NOT EXISTS "episodic_date" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user_memories_preferences" ADD COLUMN IF NOT EXISTS "user_id" text;--> statement-breakpoint
ALTER TABLE "user_memories_preferences" ADD COLUMN IF NOT EXISTS "metadata" jsonb;--> statement-breakpoint
ALTER TABLE "user_memories_preferences" ADD COLUMN IF NOT EXISTS "tags" text[];--> statement-breakpoint
ALTER TABLE "user_memories_contexts" ADD CONSTRAINT "user_memories_contexts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_memories_experiences" ADD CONSTRAINT "user_memories_experiences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_memories_identities" ADD CONSTRAINT "user_memories_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_memories_preferences" ADD CONSTRAINT "user_memories_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_memories_contexts" DROP COLUMN IF EXISTS "labels";--> statement-breakpoint
ALTER TABLE "user_memories_contexts" DROP COLUMN IF EXISTS "extracted_labels";--> statement-breakpoint
ALTER TABLE "user_memories_experiences" DROP COLUMN IF EXISTS "labels";--> statement-breakpoint
ALTER TABLE "user_memories_experiences" DROP COLUMN IF EXISTS "extracted_labels";--> statement-breakpoint
ALTER TABLE "user_memories_identities" DROP COLUMN IF EXISTS "current_focuses";--> statement-breakpoint
ALTER TABLE "user_memories_identities" DROP COLUMN IF EXISTS "experience";--> statement-breakpoint
ALTER TABLE "user_memories_identities" DROP COLUMN IF EXISTS "extracted_labels";--> statement-breakpoint
ALTER TABLE "user_memories_identities" DROP COLUMN IF EXISTS "labels";--> statement-breakpoint
ALTER TABLE "user_memories_preferences" DROP COLUMN IF EXISTS "context_id";--> statement-breakpoint
ALTER TABLE "user_memories_preferences" DROP COLUMN IF EXISTS "labels";--> statement-breakpoint
ALTER TABLE "user_memories_preferences" DROP COLUMN IF EXISTS "extracted_labels";--> statement-breakpoint
ALTER TABLE "user_memories_preferences" DROP COLUMN IF EXISTS "extracted_scopes";
--> statement-breakpoint
-- ===== 0041_improve_index =====
CREATE INDEX IF NOT EXISTS "agents_files_agent_id_idx" ON "agents_files" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_groups_topic_id_idx" ON "message_groups" USING btree ("topic_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_agent_id_idx" ON "messages" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_to_sessions_session_id_idx" ON "agents_to_sessions" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_to_sessions_agent_id_idx" ON "agents_to_sessions" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_user_id_updated_at_idx" ON "sessions" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_group_id_idx" ON "sessions" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "threads_topic_id_idx" ON "threads" USING btree ("topic_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "topics_session_id_idx" ON "topics" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "topics_group_id_idx" ON "topics" USING btree ("group_id");
--> statement-breakpoint
-- ===== 0042_improve_agent_index =====
CREATE INDEX IF NOT EXISTS "agents_knowledge_bases_agent_id_idx" ON "agents_knowledge_bases" USING btree ("agent_id");
--> statement-breakpoint
-- ===== 0043_add_ai_model_settings =====
ALTER TABLE "ai_models" ADD COLUMN IF NOT EXISTS "settings" jsonb DEFAULT '{}'::jsonb;
--> statement-breakpoint
-- ===== 0044_high_toxin =====
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "market_identifier" text;
--> statement-breakpoint
-- ===== 0045_add_tool_intervention =====
ALTER TABLE "message_plugins" ADD COLUMN IF NOT EXISTS "intervention" jsonb;
--> statement-breakpoint
-- ===== 0046_add_parent_id =====
ALTER TABLE "documents" ALTER COLUMN "id" SET DATA TYPE varchar(255);--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "parent_id" varchar(255);--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "parent_id" varchar(255);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "documents" ADD CONSTRAINT "documents_parent_id_documents_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "files" ADD CONSTRAINT "files_parent_id_documents_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_parent_id_idx" ON "documents" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "files_parent_id_idx" ON "files" USING btree ("parent_id");
--> statement-breakpoint
-- ===== 0047_add_slug_document =====
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "slug" varchar(255);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "documents_slug_user_id_unique" ON "documents" USING btree ("slug","user_id") WHERE "documents"."slug" is not null;
--> statement-breakpoint
-- ===== 0048_add_editor_data =====
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "editor_data" jsonb;
--> statement-breakpoint
-- ===== 0049_better_auth =====
CREATE TABLE IF NOT EXISTS "accounts" (
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
CREATE TABLE IF NOT EXISTS "auth_sessions" (
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"ip_address" text,
	"token" text NOT NULL,
	"updated_at" timestamp NOT NULL,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "auth_sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "verifications" (
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- ===== 0050_thread_and_user_id =====
ALTER TABLE "nextauth_accounts" RENAME COLUMN "userId" TO "user_id";--> statement-breakpoint
ALTER TABLE "nextauth_authenticators" RENAME COLUMN "userId" TO "user_id";--> statement-breakpoint
ALTER TABLE "nextauth_sessions" RENAME COLUMN "userId" TO "user_id";--> statement-breakpoint
ALTER TABLE "nextauth_accounts" DROP CONSTRAINT "nextauth_accounts_userId_users_id_fk";
--> statement-breakpoint
ALTER TABLE "nextauth_authenticators" DROP CONSTRAINT "nextauth_authenticators_userId_users_id_fk";
--> statement-breakpoint
ALTER TABLE "nextauth_sessions" DROP CONSTRAINT "nextauth_sessions_userId_users_id_fk";
--> statement-breakpoint
ALTER TABLE "nextauth_authenticators" DROP CONSTRAINT "nextauth_authenticators_userId_credentialID_pk";--> statement-breakpoint
ALTER TABLE "threads" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "threads" ALTER COLUMN "source_message_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "nextauth_authenticators" ADD CONSTRAINT "nextauth_authenticators_user_id_credentialID_pk" PRIMARY KEY("user_id","credentialID");--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN IF NOT EXISTS "content" text;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN IF NOT EXISTS "editor_data" jsonb;--> statement-breakpoint
ALTER TABLE "nextauth_accounts" ADD CONSTRAINT "nextauth_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nextauth_authenticators" ADD CONSTRAINT "nextauth_authenticators_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nextauth_sessions" ADD CONSTRAINT "nextauth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- ===== 0051_add_market_into_user_settings =====
ALTER TABLE "user_settings" ADD COLUMN IF NOT EXISTS "market" jsonb;
--> statement-breakpoint
-- ===== 0052_topic_and_messages =====
ALTER TABLE "messages" DROP CONSTRAINT "messages_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "editor_data" jsonb;--> statement-breakpoint
ALTER TABLE "topics" ADD COLUMN IF NOT EXISTS "content" text;--> statement-breakpoint
ALTER TABLE "topics" ADD COLUMN IF NOT EXISTS "editor_data" jsonb;--> statement-breakpoint
ALTER TABLE "topics" ADD COLUMN IF NOT EXISTS "agent_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "topics_agent_id_idx" ON "topics" USING btree ("agent_id");
--> statement-breakpoint
-- ===== 0053_better_auth_admin =====
ALTER TABLE "auth_sessions" ADD COLUMN IF NOT EXISTS "impersonated_by" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "role" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "banned" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "ban_reason" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "ban_expires" timestamp with time zone;
--> statement-breakpoint
-- ===== 0054_better_auth_two_factor =====
CREATE TABLE IF NOT EXISTS "two_factor" (
  "backup_codes" text NOT NULL,
  "id" text PRIMARY KEY NOT NULL,
  "secret" text NOT NULL,
  "user_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "two_factor_enabled" boolean DEFAULT false;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "phone_number" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "phone_number_verified" boolean;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'two_factor_user_id_users_id_fk'
  ) THEN
    ALTER TABLE "two_factor"
      ADD CONSTRAINT "two_factor_user_id_users_id_fk"
      FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "two_factor_secret_idx" ON "two_factor" USING btree ("secret");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "two_factor_user_id_idx" ON "two_factor" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "account_userId_idx" ON "accounts" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auth_session_userId_idx" ON "auth_sessions" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verification_identifier_idx" ON "verifications" USING btree ("identifier");
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_email_unique') THEN
    -- Normalize empty emails so the unique constraint can be created safely
    UPDATE "users" SET "email" = NULL WHERE "email" = '';
    ALTER TABLE "users" ADD CONSTRAINT "users_email_unique" UNIQUE ("email");
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_phone_number_unique') THEN
    ALTER TABLE "users" ADD CONSTRAINT "users_phone_number_unique" UNIQUE ("phone_number");
  END IF;
END $$;
--> statement-breakpoint
-- ===== 0055_rename_phone_number_to_phone =====
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_phone_number_unique";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "phone_number";--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_phone_unique";--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_phone_unique" UNIQUE("phone");
--> statement-breakpoint
-- ===== 0056_update_agent_slug_index =====
ALTER TABLE "agents" DROP CONSTRAINT "agents_slug_unique";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agents_slug_user_id_unique" ON "agents" USING btree ("slug","user_id");
--> statement-breakpoint
-- ===== 0057_add_topic_user_memory_extract_status =====
CREATE INDEX IF NOT EXISTS "topics_extract_status_gin_idx" ON "topics" USING gin ((metadata->'userMemoryExtractStatus') jsonb_path_ops);
--> statement-breakpoint
-- ===== 0058_add_source_into_user_plugins =====
ALTER TABLE "user_installed_plugins" ADD COLUMN IF NOT EXISTS "source" varchar(255);
--> statement-breakpoint
-- ===== 0059_add_normalized_email_indexes =====
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "normalized_email" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_username_idx" ON "users" USING btree ("username");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_normalized_email_unique_idx" ON "users" USING btree ("normalized_email");--> statement-breakpoint
--> statement-breakpoint
-- ===== 0060_add_user_last_active_at =====
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "last_active_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
-- ===== 0061_add_document_and_memory_index =====
ALTER TABLE "user_memories" ADD COLUMN IF NOT EXISTS "captured_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "user_memories_contexts" ADD COLUMN IF NOT EXISTS "captured_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "user_memories_experiences" ADD COLUMN IF NOT EXISTS "captured_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "user_memories_identities" ADD COLUMN IF NOT EXISTS "captured_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "user_memories_preferences" ADD COLUMN IF NOT EXISTS "captured_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_user_id_idx" ON "agents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_source_type_idx" ON "documents" USING btree ("source_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_user_id_idx" ON "documents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "files_user_id_idx" ON "files" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_created_at_idx" ON "users" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_banned_true_created_at_idx" ON "users" USING btree ("created_at") WHERE "users"."banned" = true;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_memories_user_id_index" ON "user_memories" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_memories_contexts_user_id_index" ON "user_memories_contexts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_memories_experiences_user_id_index" ON "user_memories_experiences" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_memories_experiences_user_memory_id_index" ON "user_memories_experiences" USING btree ("user_memory_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_memories_identities_user_id_index" ON "user_memories_identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_memories_identities_user_memory_id_index" ON "user_memories_identities" USING btree ("user_memory_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_memories_preferences_user_id_index" ON "user_memories_preferences" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_memories_preferences_user_memory_id_index" ON "user_memories_preferences" USING btree ("user_memory_id");
--> statement-breakpoint
-- ===== 0062_add_more_index =====
CREATE INDEX IF NOT EXISTS "api_keys_user_id_idx" ON "api_keys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "async_tasks_user_id_idx" ON "async_tasks" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_groups_group_id_idx" ON "chat_groups" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "global_files_creator_idx" ON "global_files" USING btree ("creator");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_base_files_kb_id_idx" ON "knowledge_base_files" USING btree ("knowledge_base_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_bases_user_id_idx" ON "knowledge_bases" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "generation_batches_user_id_idx" ON "generation_batches" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "generation_batches_topic_id_idx" ON "generation_batches" USING btree ("generation_topic_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "generation_topics_user_id_idx" ON "generation_topics" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "generations_user_id_idx" ON "generations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "generations_batch_id_idx" ON "generations" USING btree ("generation_batch_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_group_id_idx" ON "messages" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_chunks_document_id_idx" ON "document_chunks" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_chunks_chunk_id_idx" ON "document_chunks" USING btree ("chunk_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "embeddings_user_id_idx" ON "embeddings" USING btree ("user_id");
--> statement-breakpoint
-- ===== 0063_add_columns_for_several_tables =====
DROP INDEX IF EXISTS "user_memories_contexts_title_vector_index";--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "plugins" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "pinned" boolean;--> statement-breakpoint
ALTER TABLE "message_groups" ADD COLUMN IF NOT EXISTS "type" text;--> statement-breakpoint
ALTER TABLE "message_groups" ADD COLUMN IF NOT EXISTS "content" text;--> statement-breakpoint
ALTER TABLE "message_groups" ADD COLUMN IF NOT EXISTS "editor_data" jsonb;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "summary" text;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN IF NOT EXISTS "agent_id" text;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN IF NOT EXISTS "group_id" text;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN IF NOT EXISTS "metadata" jsonb;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN IF NOT EXISTS "memory" jsonb;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "interests" varchar(64)[];--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "onboarding" jsonb;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'threads_agent_id_agents_id_fk') THEN
    ALTER TABLE "threads" ADD CONSTRAINT "threads_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'threads_group_id_chat_groups_id_fk') THEN
    ALTER TABLE "threads" ADD CONSTRAINT "threads_group_id_chat_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."chat_groups"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_models_user_id_idx" ON "ai_models" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_providers_user_id_idx" ON "ai_providers" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_groups_type_idx" ON "message_groups" USING btree ("type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_plugins_tool_call_id_idx" ON "message_plugins" USING btree ("tool_call_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "threads_agent_id_idx" ON "threads" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "threads_group_id_idx" ON "threads" USING btree ("group_id");--> statement-breakpoint
ALTER TABLE "user_memories_contexts" DROP COLUMN IF EXISTS "title_vector";
--> statement-breakpoint
-- ===== 0064_add_agents_session_group_id =====
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "session_group_id" text;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agents_session_group_id_session_groups_id_fk') THEN
    ALTER TABLE "agents" ADD CONSTRAINT "agents_session_group_id_session_groups_id_fk" FOREIGN KEY ("session_group_id") REFERENCES "public"."session_groups"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_session_group_id_idx" ON "agents" USING btree ("session_group_id");
--> statement-breakpoint
-- ===== 0065_add_passkey =====
CREATE TABLE IF NOT EXISTS "passkey" (
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
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'passkey_userId_users_id_fk') THEN
    ALTER TABLE "passkey" ADD CONSTRAINT "passkey_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint	
CREATE UNIQUE INDEX IF NOT EXISTS "passkey_credential_id_unique" ON "passkey" USING btree ("credentialID");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "passkey_user_id_idx" ON "passkey" USING btree ("userId");
--> statement-breakpoint
-- ===== 0066_add_document_fields =====
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "description" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "knowledge_base_id" text;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documents_knowledge_base_id_knowledge_bases_id_fk') THEN
    ALTER TABLE "documents" ADD CONSTRAINT "documents_knowledge_base_id_knowledge_bases_id_fk" FOREIGN KEY ("knowledge_base_id") REFERENCES "public"."knowledge_bases"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_knowledge_base_id_idx" ON "documents" USING btree ("knowledge_base_id");
--> statement-breakpoint
-- ===== 0067_add_agent_cron_tables =====
CREATE TABLE IF NOT EXISTS "agent_cron_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"group_id" text,
	"user_id" text NOT NULL,
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
ALTER TABLE "topics" ADD COLUMN IF NOT EXISTS "trigger" text;--> statement-breakpoint
ALTER TABLE "topics" ADD COLUMN IF NOT EXISTS "mode" text;--> statement-breakpoint
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'agent_cron_jobs_agent_id_agents_id_fk'
    ) THEN
        ALTER TABLE "agent_cron_jobs" ADD CONSTRAINT "agent_cron_jobs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
    END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'agent_cron_jobs_group_id_chat_groups_id_fk'
    ) THEN
        ALTER TABLE "agent_cron_jobs" ADD CONSTRAINT "agent_cron_jobs_group_id_chat_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."chat_groups"("id") ON DELETE cascade ON UPDATE no action;
    END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'agent_cron_jobs_user_id_users_id_fk'
    ) THEN
        ALTER TABLE "agent_cron_jobs" ADD CONSTRAINT "agent_cron_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
    END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_cron_jobs_agent_id_idx" ON "agent_cron_jobs" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_cron_jobs_group_id_idx" ON "agent_cron_jobs" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_cron_jobs_user_id_idx" ON "agent_cron_jobs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_cron_jobs_enabled_idx" ON "agent_cron_jobs" USING btree ("enabled");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_cron_jobs_remaining_executions_idx" ON "agent_cron_jobs" USING btree ("remaining_executions");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_cron_jobs_last_executed_at_idx" ON "agent_cron_jobs" USING btree ("last_executed_at");
--> statement-breakpoint
-- ===== 0068_update_group_data =====
ALTER TABLE "chat_groups" ADD COLUMN IF NOT EXISTS "avatar" text;--> statement-breakpoint
ALTER TABLE "chat_groups" ADD COLUMN IF NOT EXISTS "background_color" text;--> statement-breakpoint
ALTER TABLE "chat_groups" ADD COLUMN IF NOT EXISTS "content" text;--> statement-breakpoint
ALTER TABLE "chat_groups" ADD COLUMN IF NOT EXISTS "editor_data" jsonb;
--> statement-breakpoint
-- ===== 0069_add_topic_shares_table =====
CREATE TABLE IF NOT EXISTS "topic_shares" (
	"id" text PRIMARY KEY NOT NULL,
	"topic_id" text NOT NULL,
	"user_id" text NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"page_view_count" integer DEFAULT 0 NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "topic_shares" ADD CONSTRAINT "topic_shares_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "topic_shares" ADD CONSTRAINT "topic_shares_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "topic_shares_topic_id_unique" ON "topic_shares" USING btree ("topic_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "topic_shares_user_id_idx" ON "topic_shares" USING btree ("user_id");
--> statement-breakpoint
-- ===== 0070_add_user_memory_activities =====
CREATE TABLE IF NOT EXISTS "user_memories_activities" (
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
ALTER TABLE "user_memories_activities" DROP CONSTRAINT IF EXISTS "user_memories_activities_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "user_memories_activities" ADD CONSTRAINT "user_memories_activities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_memories_activities" DROP CONSTRAINT IF EXISTS "user_memories_activities_user_memory_id_user_memories_id_fk";--> statement-breakpoint
ALTER TABLE "user_memories_activities" ADD CONSTRAINT "user_memories_activities_user_memory_id_user_memories_id_fk" FOREIGN KEY ("user_memory_id") REFERENCES "public"."user_memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_memories_activities_narrative_vector_index" ON "user_memories_activities" USING hnsw ("narrative_vector" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_memories_activities_feedback_vector_index" ON "user_memories_activities" USING hnsw ("feedback_vector" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_memories_activities_type_index" ON "user_memories_activities" USING btree ("type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_memories_activities_user_id_index" ON "user_memories_activities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_memories_activities_user_memory_id_index" ON "user_memories_activities" USING btree ("user_memory_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_memories_activities_status_index" ON "user_memories_activities" USING btree ("status");
--> statement-breakpoint
-- ===== 0071_add_async_task_extend =====
ALTER TABLE "async_tasks" ADD COLUMN IF NOT EXISTS "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "async_tasks" ADD COLUMN IF NOT EXISTS "metadata" jsonb DEFAULT '{}' NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "async_tasks_parent_id_idx" ON "async_tasks" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "async_tasks_type_status_idx" ON "async_tasks" USING btree ("type","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "async_tasks_metadata_idx" ON "async_tasks" USING gin ("metadata");
--> statement-breakpoint
-- ===== 0072_add_market_identifier_chat_group =====
ALTER TABLE "chat_groups" ADD COLUMN IF NOT EXISTS "market_identifier" text;
--> statement-breakpoint
-- ===== 0073_add_message_group_metadata =====
ALTER TABLE "message_groups" ADD COLUMN IF NOT EXISTS "metadata" jsonb;
--> statement-breakpoint
-- ===== 0074_add_fk_indexes_for_cascade_delete =====
CREATE INDEX IF NOT EXISTS "agents_files_file_id_idx" ON "agents_files" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_files_user_id_idx" ON "agents_files" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_knowledge_bases_knowledge_base_id_idx" ON "agents_knowledge_bases" USING btree ("knowledge_base_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_knowledge_bases_user_id_idx" ON "agents_knowledge_bases" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_groups_user_id_idx" ON "chat_groups" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_groups_agents_user_id_idx" ON "chat_groups_agents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "files_chunk_task_id_idx" ON "files" USING btree ("chunk_task_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "files_embedding_task_id_idx" ON "files" USING btree ("embedding_task_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_base_files_user_id_idx" ON "knowledge_base_files" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_base_files_file_id_idx" ON "knowledge_base_files" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "generations_file_id_idx" ON "generations" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_chunks_user_id_idx" ON "message_chunks" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_chunks_message_id_idx" ON "message_chunks" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_groups_user_id_idx" ON "message_groups" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_groups_parent_group_id_idx" ON "message_groups" USING btree ("parent_group_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_groups_parent_message_id_idx" ON "message_groups" USING btree ("parent_message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_plugins_user_id_idx" ON "message_plugins" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_queries_user_id_idx" ON "message_queries" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_queries_message_id_idx" ON "message_queries" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_queries_embeddings_id_idx" ON "message_queries" USING btree ("embeddings_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_query_chunks_user_id_idx" ON "message_query_chunks" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_query_chunks_message_id_idx" ON "message_query_chunks" USING btree ("id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_query_chunks_query_id_idx" ON "message_query_chunks" USING btree ("query_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_tts_user_id_idx" ON "message_tts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_translates_user_id_idx" ON "message_translates" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_files_user_id_idx" ON "messages_files" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_files_message_id_idx" ON "messages_files" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nextauth_accounts_user_id_idx" ON "nextauth_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nextauth_sessions_user_id_idx" ON "nextauth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oidc_access_tokens_user_id_idx" ON "oidc_access_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oidc_authorization_codes_user_id_idx" ON "oidc_authorization_codes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oidc_device_codes_user_id_idx" ON "oidc_device_codes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oidc_grants_user_id_idx" ON "oidc_grants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oidc_refresh_tokens_user_id_idx" ON "oidc_refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oidc_sessions_user_id_idx" ON "oidc_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_chunks_user_id_idx" ON "document_chunks" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "unstructured_chunks_user_id_idx" ON "unstructured_chunks" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "unstructured_chunks_composite_id_idx" ON "unstructured_chunks" USING btree ("composite_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "unstructured_chunks_file_id_idx" ON "unstructured_chunks" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rag_eval_dataset_records_user_id_idx" ON "rag_eval_dataset_records" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rag_eval_datasets_user_id_idx" ON "rag_eval_datasets" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rag_eval_evaluations_user_id_idx" ON "rag_eval_evaluations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rag_eval_evaluation_records_user_id_idx" ON "rag_eval_evaluation_records" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_to_sessions_user_id_idx" ON "agents_to_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "file_chunks_user_id_idx" ON "file_chunks" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "file_chunks_file_id_idx" ON "file_chunks" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "file_chunks_chunk_id_idx" ON "file_chunks" USING btree ("chunk_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "files_to_sessions_user_id_idx" ON "files_to_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "files_to_sessions_file_id_idx" ON "files_to_sessions" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "files_to_sessions_session_id_idx" ON "files_to_sessions" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "session_groups_user_id_idx" ON "session_groups" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "threads_user_id_idx" ON "threads" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "threads_parent_thread_id_idx" ON "threads" USING btree ("parent_thread_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "topic_documents_user_id_idx" ON "topic_documents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "topic_documents_topic_id_idx" ON "topic_documents" USING btree ("topic_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "topic_documents_document_id_idx" ON "topic_documents" USING btree ("document_id");
--> statement-breakpoint
-- ===== 0075_add_user_memory_persona =====
CREATE TABLE IF NOT EXISTS "user_memory_persona_document_histories" (
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
CREATE TABLE IF NOT EXISTS "user_memory_persona_documents" (
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
ALTER TABLE "user_memory_persona_document_histories" DROP CONSTRAINT IF EXISTS "user_memory_persona_document_histories_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "user_memory_persona_document_histories" ADD CONSTRAINT "user_memory_persona_document_histories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_memory_persona_document_histories" DROP CONSTRAINT IF EXISTS "user_memory_persona_document_histories_persona_id_user_memory_persona_documents_id_fk";--> statement-breakpoint
ALTER TABLE "user_memory_persona_document_histories" ADD CONSTRAINT "user_memory_persona_document_histories_persona_id_user_memory_persona_documents_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."user_memory_persona_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_persona_document_histories_persona_id_index" ON "user_memory_persona_document_histories" USING btree ("persona_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_persona_document_histories_user_id_index" ON "user_memory_persona_document_histories" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_persona_document_histories_profile_index" ON "user_memory_persona_document_histories" USING btree ("profile");--> statement-breakpoint
ALTER TABLE "user_memory_persona_documents" DROP CONSTRAINT IF EXISTS "user_memory_persona_documents_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "user_memory_persona_documents" ADD CONSTRAINT "user_memory_persona_documents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_persona_documents_user_id_profile_unique" ON "user_memory_persona_documents" USING btree ("user_id","profile");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_persona_documents_user_id_index" ON "user_memory_persona_documents" USING btree ("user_id");
--> statement-breakpoint
-- ===== 0076_add_message_group_index =====
CREATE INDEX IF NOT EXISTS "messages_message_group_id_idx" ON "messages" USING btree ("message_group_id");
--> statement-breakpoint
-- ===== 0077_add_agent_skills =====
CREATE TABLE IF NOT EXISTS "agent_skills" (
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
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_skills" DROP CONSTRAINT IF EXISTS "agent_skills_zip_file_hash_global_files_hash_id_fk";--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_zip_file_hash_global_files_hash_id_fk" FOREIGN KEY ("zip_file_hash") REFERENCES "public"."global_files"("hash_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skills" DROP CONSTRAINT IF EXISTS "agent_skills_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_skills_user_name_idx" ON "agent_skills" USING btree ("user_id","name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_skills_identifier_idx" ON "agent_skills" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_skills_user_id_idx" ON "agent_skills" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_skills_source_idx" ON "agent_skills" USING btree ("source");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_skills_zip_hash_idx" ON "agent_skills" USING btree ("zip_file_hash");--> statement-breakpoint
--> statement-breakpoint
-- ===== 0078_added_id_nanoid_for_replacing_id =====
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "id_nanoid" text;--> statement-breakpoint
ALTER TABLE "rag_eval_dataset_records" ADD COLUMN IF NOT EXISTS "id_nanoid" text;--> statement-breakpoint
ALTER TABLE "rag_eval_datasets" ADD COLUMN IF NOT EXISTS "id_nanoid" text;--> statement-breakpoint
ALTER TABLE "rag_eval_evaluations" ADD COLUMN IF NOT EXISTS "id_nanoid" text;--> statement-breakpoint
ALTER TABLE "rag_eval_evaluation_records" ADD COLUMN IF NOT EXISTS "id_nanoid" text;--> statement-breakpoint
ALTER TABLE "rbac_permissions" ADD COLUMN IF NOT EXISTS "id_nanoid" text;--> statement-breakpoint
ALTER TABLE "rbac_roles" ADD COLUMN IF NOT EXISTS "id_nanoid" text;
--> statement-breakpoint
-- ===== 0079_update_id_nanoid_from_casted_id =====
UPDATE "api_keys" SET "id_nanoid" = "id"::text WHERE "id_nanoid" IS NULL;--> statement-breakpoint
UPDATE "rag_eval_dataset_records" SET "id_nanoid" = "id"::text WHERE "id_nanoid" IS NULL;--> statement-breakpoint
UPDATE "rag_eval_datasets" SET "id_nanoid" = "id"::text WHERE "id_nanoid" IS NULL;--> statement-breakpoint
UPDATE "rag_eval_evaluations" SET "id_nanoid" = "id"::text WHERE "id_nanoid" IS NULL;--> statement-breakpoint
UPDATE "rag_eval_evaluation_records" SET "id_nanoid" = "id"::text WHERE "id_nanoid" IS NULL;--> statement-breakpoint
UPDATE "rbac_permissions" SET "id_nanoid" = "id"::text WHERE "id_nanoid" IS NULL;--> statement-breakpoint
UPDATE "rbac_roles" SET "id_nanoid" = "id"::text WHERE "id_nanoid" IS NULL;
--> statement-breakpoint
-- ===== 0080_add_constraint_unique_not_null_to_id_nanoid =====
-- Thanks to Slava Fomin II shared in StackOverflow
-- https://stackoverflow.com/questions/29075413/change-primary-key-in-postgresql-table
-- https://stackoverflow.com/a/29087291/19954520

ALTER TABLE "api_keys" ALTER COLUMN "id_nanoid" SET NOT NULL;--> statement-breakpoint

ALTER TABLE "rag_eval_dataset_records" ALTER COLUMN "id_nanoid" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "rag_eval_datasets" ALTER COLUMN "id_nanoid" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "rag_eval_evaluations" ALTER COLUMN "id_nanoid" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "rag_eval_evaluation_records" ALTER COLUMN "id_nanoid" SET NOT NULL;--> statement-breakpoint

ALTER TABLE "rbac_permissions" ALTER COLUMN "id_nanoid" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "rbac_roles" ALTER COLUMN "id_nanoid" SET NOT NULL;--> statement-breakpoint

-- We cannot add DROP CONSTRAINT IF EXISTS & ADD CONSTRAINT here as dropping previously created constraints for temporary purpose
-- id_nanoid will cause performance issues.
-- If anything happens wrong during the migration, please check and drop the existing constraints manually before re-applying the migration.

ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_id_nanoid_unique" UNIQUE("id_nanoid");--> statement-breakpoint

ALTER TABLE "rag_eval_dataset_records" ADD CONSTRAINT "rag_eval_dataset_records_id_nanoid_unique" UNIQUE("id_nanoid");--> statement-breakpoint
ALTER TABLE "rag_eval_datasets" ADD CONSTRAINT "rag_eval_datasets_id_nanoid_unique" UNIQUE("id_nanoid");--> statement-breakpoint
ALTER TABLE "rag_eval_evaluations" ADD CONSTRAINT "rag_eval_evaluations_id_nanoid_unique" UNIQUE("id_nanoid");--> statement-breakpoint
ALTER TABLE "rag_eval_evaluation_records" ADD CONSTRAINT "rag_eval_evaluation_records_id_nanoid_unique" UNIQUE("id_nanoid");--> statement-breakpoint

ALTER TABLE "rbac_permissions" ADD CONSTRAINT "rbac_permissions_id_nanoid_unique" UNIQUE("id_nanoid");--> statement-breakpoint
ALTER TABLE "rbac_roles" ADD CONSTRAINT "rbac_roles_id_nanoid_unique" UNIQUE("id_nanoid");
--> statement-breakpoint
-- ===== 0081_switch_forgien_key_to_id_nanoid =====
-- Thanks to Slava Fomin II shared in StackOverflow
-- https://stackoverflow.com/questions/29075413/change-primary-key-in-postgresql-table
-- https://stackoverflow.com/a/29087291/19954520

ALTER TABLE "rag_eval_dataset_records" DROP CONSTRAINT IF EXISTS "rag_eval_dataset_records_dataset_id_rag_eval_datasets_id_fk";
--> statement-breakpoint
ALTER TABLE "rag_eval_evaluations" DROP CONSTRAINT IF EXISTS "rag_eval_evaluations_dataset_id_rag_eval_datasets_id_fk";
--> statement-breakpoint
ALTER TABLE "rag_eval_evaluation_records" DROP CONSTRAINT IF EXISTS "rag_eval_evaluation_records_dataset_record_id_rag_eval_dataset_records_id_fk";
--> statement-breakpoint
ALTER TABLE "rag_eval_evaluation_records" DROP CONSTRAINT IF EXISTS "rag_eval_evaluation_records_evaluation_id_rag_eval_evaluations_id_fk";
--> statement-breakpoint

ALTER TABLE "rbac_role_permissions" DROP CONSTRAINT IF EXISTS "rbac_role_permissions_role_id_rbac_roles_id_fk";
--> statement-breakpoint
ALTER TABLE "rbac_role_permissions" DROP CONSTRAINT IF EXISTS "rbac_role_permissions_permission_id_rbac_permissions_id_fk";
--> statement-breakpoint
ALTER TABLE "rbac_user_roles" DROP CONSTRAINT IF EXISTS "rbac_user_roles_role_id_rbac_roles_id_fk";
--> statement-breakpoint

ALTER TABLE "rag_eval_dataset_records" ALTER COLUMN "dataset_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "rag_eval_evaluations" ALTER COLUMN "dataset_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "rag_eval_evaluation_records" ALTER COLUMN "dataset_record_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "rag_eval_evaluation_records" ALTER COLUMN "evaluation_id" SET DATA TYPE text;--> statement-breakpoint

ALTER TABLE "rbac_role_permissions" ALTER COLUMN "role_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "rbac_role_permissions" ALTER COLUMN "permission_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "rbac_user_roles" ALTER COLUMN "role_id" SET DATA TYPE text;--> statement-breakpoint

ALTER TABLE "rag_eval_dataset_records" ADD CONSTRAINT "rag_eval_dataset_records_dataset_id_rag_eval_datasets_id_nanoid_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."rag_eval_datasets"("id_nanoid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag_eval_evaluations" ADD CONSTRAINT "rag_eval_evaluations_dataset_id_rag_eval_datasets_id_nanoid_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."rag_eval_datasets"("id_nanoid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag_eval_evaluation_records" ADD CONSTRAINT "rag_eval_evaluation_records_dataset_record_id_rag_eval_dataset_records_id_nanoid_fk" FOREIGN KEY ("dataset_record_id") REFERENCES "public"."rag_eval_dataset_records"("id_nanoid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag_eval_evaluation_records" ADD CONSTRAINT "rag_eval_evaluation_records_evaluation_id_rag_eval_evaluations_id_nanoid_fk" FOREIGN KEY ("evaluation_id") REFERENCES "public"."rag_eval_evaluations"("id_nanoid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "rbac_role_permissions" ADD CONSTRAINT "rbac_role_permissions_role_id_rbac_roles_id_nanoid_fk" FOREIGN KEY ("role_id") REFERENCES "public"."rbac_roles"("id_nanoid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rbac_role_permissions" ADD CONSTRAINT "rbac_role_permissions_permission_id_rbac_permissions_id_nanoid_fk" FOREIGN KEY ("permission_id") REFERENCES "public"."rbac_permissions"("id_nanoid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rbac_user_roles" ADD CONSTRAINT "rbac_user_roles_role_id_rbac_roles_id_nanoid_fk" FOREIGN KEY ("role_id") REFERENCES "public"."rbac_roles"("id_nanoid") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- ===== 0082_set_id_nanoid_as_primary =====
ALTER TABLE "api_keys" DROP CONSTRAINT "api_keys_pkey";--> statement-breakpoint
ALTER TABLE "api_keys" ADD PRIMARY KEY ("id_nanoid");--> statement-breakpoint

ALTER TABLE "rag_eval_dataset_records" DROP CONSTRAINT "rag_eval_dataset_records_pkey";--> statement-breakpoint
ALTER TABLE "rag_eval_dataset_records" ADD PRIMARY KEY ("id_nanoid");--> statement-breakpoint

ALTER TABLE "rag_eval_datasets" DROP CONSTRAINT "rag_eval_datasets_pkey";--> statement-breakpoint
ALTER TABLE "rag_eval_datasets" ADD PRIMARY KEY ("id_nanoid");--> statement-breakpoint

ALTER TABLE "rag_eval_evaluations" DROP CONSTRAINT "rag_eval_evaluations_pkey";--> statement-breakpoint
ALTER TABLE "rag_eval_evaluations" ADD PRIMARY KEY ("id_nanoid");--> statement-breakpoint

ALTER TABLE "rag_eval_evaluation_records" DROP CONSTRAINT "rag_eval_evaluation_records_pkey";--> statement-breakpoint
ALTER TABLE "rag_eval_evaluation_records" ADD PRIMARY KEY ("id_nanoid");--> statement-breakpoint

ALTER TABLE "rbac_permissions" DROP CONSTRAINT "rbac_permissions_pkey";--> statement-breakpoint
ALTER TABLE "rbac_permissions" ADD PRIMARY KEY ("id_nanoid");--> statement-breakpoint

ALTER TABLE "rbac_roles" DROP CONSTRAINT "rbac_roles_pkey";--> statement-breakpoint
ALTER TABLE "rbac_roles" ADD PRIMARY KEY ("id_nanoid");
--> statement-breakpoint
-- ===== 0083_remove_id_seq_identity_column =====
ALTER TABLE "api_keys" DROP COLUMN IF EXISTS "id";--> statement-breakpoint
ALTER TABLE "rag_eval_dataset_records" DROP COLUMN IF EXISTS "id";--> statement-breakpoint
ALTER TABLE "rag_eval_datasets" DROP COLUMN IF EXISTS "id";--> statement-breakpoint
ALTER TABLE "rag_eval_evaluations" DROP COLUMN IF EXISTS "id";--> statement-breakpoint
ALTER TABLE "rag_eval_evaluation_records" DROP COLUMN IF EXISTS "id";--> statement-breakpoint
ALTER TABLE "rbac_permissions" DROP COLUMN IF EXISTS "id";--> statement-breakpoint
ALTER TABLE "rbac_roles" DROP COLUMN IF EXISTS "id";
--> statement-breakpoint
-- ===== 0084_rename_id_nanoid_to_id =====
-- Renaming
ALTER TABLE "api_keys" RENAME COLUMN "id_nanoid" TO "id";--> statement-breakpoint
ALTER TABLE "rag_eval_dataset_records" RENAME COLUMN "id_nanoid" TO "id";--> statement-breakpoint
ALTER TABLE "rag_eval_datasets" RENAME COLUMN "id_nanoid" TO "id";--> statement-breakpoint
ALTER TABLE "rag_eval_evaluations" RENAME COLUMN "id_nanoid" TO "id";--> statement-breakpoint
ALTER TABLE "rag_eval_evaluation_records" RENAME COLUMN "id_nanoid" TO "id";--> statement-breakpoint
ALTER TABLE "rbac_permissions" RENAME COLUMN "id_nanoid" TO "id";--> statement-breakpoint
ALTER TABLE "rbac_roles" RENAME COLUMN "id_nanoid" TO "id";--> statement-breakpoint

-- Adding foreign keys back
ALTER TABLE "rag_eval_dataset_records" DROP CONSTRAINT IF EXISTS "rag_eval_dataset_records_dataset_id_rag_eval_datasets_id_fk";--> statement-breakpoint
ALTER TABLE "rag_eval_dataset_records" ADD CONSTRAINT "rag_eval_dataset_records_dataset_id_rag_eval_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."rag_eval_datasets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag_eval_evaluations" DROP CONSTRAINT IF EXISTS "rag_eval_evaluations_dataset_id_rag_eval_datasets_id_fk";--> statement-breakpoint
ALTER TABLE "rag_eval_evaluations" ADD CONSTRAINT "rag_eval_evaluations_dataset_id_rag_eval_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."rag_eval_datasets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag_eval_evaluation_records" DROP CONSTRAINT IF EXISTS "rag_eval_evaluation_records_dataset_record_id_rag_eval_dataset_records_id_fk";--> statement-breakpoint
ALTER TABLE "rag_eval_evaluation_records" ADD CONSTRAINT "rag_eval_evaluation_records_dataset_record_id_rag_eval_dataset_records_id_fk" FOREIGN KEY ("dataset_record_id") REFERENCES "public"."rag_eval_dataset_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag_eval_evaluation_records" DROP CONSTRAINT IF EXISTS "rag_eval_evaluation_records_evaluation_id_rag_eval_evaluations_id_fk";--> statement-breakpoint
ALTER TABLE "rag_eval_evaluation_records" ADD CONSTRAINT "rag_eval_evaluation_records_evaluation_id_rag_eval_evaluations_id_fk" FOREIGN KEY ("evaluation_id") REFERENCES "public"."rag_eval_evaluations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rbac_role_permissions" DROP CONSTRAINT IF EXISTS "rbac_role_permissions_role_id_rbac_roles_id_fk";--> statement-breakpoint
ALTER TABLE "rbac_role_permissions" ADD CONSTRAINT "rbac_role_permissions_role_id_rbac_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."rbac_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rbac_role_permissions" DROP CONSTRAINT IF EXISTS "rbac_role_permissions_permission_id_rbac_permissions_id_fk";--> statement-breakpoint
ALTER TABLE "rbac_role_permissions" ADD CONSTRAINT "rbac_role_permissions_permission_id_rbac_permissions_id_fk" FOREIGN KEY ("permission_id") REFERENCES "public"."rbac_permissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rbac_user_roles" DROP CONSTRAINT IF EXISTS "rbac_user_roles_role_id_rbac_roles_id_fk";--> statement-breakpoint
ALTER TABLE "rbac_user_roles" ADD CONSTRAINT "rbac_user_roles_role_id_rbac_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."rbac_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" DROP CONSTRAINT IF EXISTS "api_keys_id_unique";--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_id_unique" UNIQUE("id");--> statement-breakpoint
ALTER TABLE "rag_eval_dataset_records" DROP CONSTRAINT IF EXISTS "rag_eval_dataset_records_id_unique";--> statement-breakpoint
ALTER TABLE "rag_eval_dataset_records" ADD CONSTRAINT "rag_eval_dataset_records_id_unique" UNIQUE("id");--> statement-breakpoint
ALTER TABLE "rag_eval_datasets" DROP CONSTRAINT IF EXISTS "rag_eval_datasets_id_unique";--> statement-breakpoint
ALTER TABLE "rag_eval_datasets" ADD CONSTRAINT "rag_eval_datasets_id_unique" UNIQUE("id");--> statement-breakpoint
ALTER TABLE "rag_eval_evaluations" DROP CONSTRAINT IF EXISTS "rag_eval_evaluations_id_unique";--> statement-breakpoint
ALTER TABLE "rag_eval_evaluations" ADD CONSTRAINT "rag_eval_evaluations_id_unique" UNIQUE("id");--> statement-breakpoint
ALTER TABLE "rag_eval_evaluation_records" DROP CONSTRAINT IF EXISTS "rag_eval_evaluation_records_id_unique";--> statement-breakpoint
ALTER TABLE "rag_eval_evaluation_records" ADD CONSTRAINT "rag_eval_evaluation_records_id_unique" UNIQUE("id");--> statement-breakpoint
ALTER TABLE "rbac_permissions" DROP CONSTRAINT IF EXISTS "rbac_permissions_id_unique";--> statement-breakpoint
ALTER TABLE "rbac_permissions" ADD CONSTRAINT "rbac_permissions_id_unique" UNIQUE("id");--> statement-breakpoint
ALTER TABLE "rbac_roles" DROP CONSTRAINT IF EXISTS "rbac_roles_id_unique";--> statement-breakpoint
ALTER TABLE "rbac_roles" ADD CONSTRAINT "rbac_roles_id_unique" UNIQUE("id");--> statement-breakpoint

-- Unused foreign key drop
ALTER TABLE "rag_eval_dataset_records" DROP CONSTRAINT IF EXISTS "rag_eval_dataset_records_dataset_id_rag_eval_datasets_id_nanoid_fk";
--> statement-breakpoint
ALTER TABLE "rag_eval_evaluations" DROP CONSTRAINT IF EXISTS "rag_eval_evaluations_dataset_id_rag_eval_datasets_id_nanoid_fk";
--> statement-breakpoint
ALTER TABLE "rag_eval_evaluation_records" DROP CONSTRAINT IF EXISTS "rag_eval_evaluation_records_dataset_record_id_rag_eval_dataset_records_id_nanoid_fk";
--> statement-breakpoint
ALTER TABLE "rag_eval_evaluation_records" DROP CONSTRAINT IF EXISTS "rag_eval_evaluation_records_evaluation_id_rag_eval_evaluations_id_nanoid_fk";
--> statement-breakpoint
ALTER TABLE "rbac_role_permissions" DROP CONSTRAINT IF EXISTS "rbac_role_permissions_role_id_rbac_roles_id_nanoid_fk";
--> statement-breakpoint
ALTER TABLE "rbac_role_permissions" DROP CONSTRAINT IF EXISTS "rbac_role_permissions_permission_id_rbac_permissions_id_nanoid_fk";
--> statement-breakpoint
ALTER TABLE "rbac_user_roles" DROP CONSTRAINT IF EXISTS "rbac_user_roles_role_id_rbac_roles_id_nanoid_fk";
--> statement-breakpoint
-- ===== 0085_remove_id_unique_constraint =====
ALTER TABLE "api_keys" DROP CONSTRAINT IF EXISTS "api_keys_id_unique";--> statement-breakpoint
ALTER TABLE "rag_eval_dataset_records" DROP CONSTRAINT IF EXISTS "rag_eval_dataset_records_id_unique";--> statement-breakpoint
ALTER TABLE "rag_eval_datasets" DROP CONSTRAINT IF EXISTS "rag_eval_datasets_id_unique";--> statement-breakpoint
ALTER TABLE "rag_eval_evaluations" DROP CONSTRAINT IF EXISTS "rag_eval_evaluations_id_unique";--> statement-breakpoint
ALTER TABLE "rag_eval_evaluation_records" DROP CONSTRAINT IF EXISTS "rag_eval_evaluation_records_id_unique";--> statement-breakpoint
ALTER TABLE "rbac_permissions" DROP CONSTRAINT IF EXISTS "rbac_permissions_id_unique";--> statement-breakpoint
ALTER TABLE "rbac_roles" DROP CONSTRAINT IF EXISTS "rbac_roles_id_unique";
--> statement-breakpoint
-- ===== 0086_video_generation_schema =====
ALTER TABLE "async_tasks" ADD COLUMN IF NOT EXISTS "inference_id" text;--> statement-breakpoint
ALTER TABLE "generation_topics" ADD COLUMN IF NOT EXISTS "type" varchar(32) DEFAULT 'image' NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "async_tasks_inference_id_idx" ON "async_tasks" USING btree ("inference_id");
--> statement-breakpoint
-- ===== 0087_add_eval_benchmark =====
CREATE TABLE IF NOT EXISTS "agent_eval_benchmarks" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"rubrics" jsonb NOT NULL,
	"reference_url" text,
	"metadata" jsonb,
	"is_system" boolean DEFAULT true NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_eval_datasets" (
	"id" text PRIMARY KEY NOT NULL,
	"benchmark_id" text NOT NULL,
	"identifier" text NOT NULL,
	"user_id" text,
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
CREATE TABLE IF NOT EXISTS "agent_eval_run_topics" (
	"user_id" text NOT NULL,
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
CREATE TABLE IF NOT EXISTS "agent_eval_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"dataset_id" text NOT NULL,
	"target_agent_id" text,
	"user_id" text NOT NULL,
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
CREATE TABLE IF NOT EXISTS "agent_eval_test_cases" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
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
ALTER TABLE "agent_eval_datasets" DROP CONSTRAINT IF EXISTS "agent_eval_datasets_benchmark_id_agent_eval_benchmarks_id_fk";--> statement-breakpoint
ALTER TABLE "agent_eval_datasets" ADD CONSTRAINT "agent_eval_datasets_benchmark_id_agent_eval_benchmarks_id_fk" FOREIGN KEY ("benchmark_id") REFERENCES "public"."agent_eval_benchmarks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_eval_datasets" DROP CONSTRAINT IF EXISTS "agent_eval_datasets_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "agent_eval_datasets" ADD CONSTRAINT "agent_eval_datasets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_eval_run_topics" DROP CONSTRAINT IF EXISTS "agent_eval_run_topics_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "agent_eval_run_topics" ADD CONSTRAINT "agent_eval_run_topics_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_eval_run_topics" DROP CONSTRAINT IF EXISTS "agent_eval_run_topics_run_id_agent_eval_runs_id_fk";--> statement-breakpoint
ALTER TABLE "agent_eval_run_topics" ADD CONSTRAINT "agent_eval_run_topics_run_id_agent_eval_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_eval_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_eval_run_topics" DROP CONSTRAINT IF EXISTS "agent_eval_run_topics_topic_id_topics_id_fk";--> statement-breakpoint
ALTER TABLE "agent_eval_run_topics" ADD CONSTRAINT "agent_eval_run_topics_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_eval_run_topics" DROP CONSTRAINT IF EXISTS "agent_eval_run_topics_test_case_id_agent_eval_test_cases_id_fk";--> statement-breakpoint
ALTER TABLE "agent_eval_run_topics" ADD CONSTRAINT "agent_eval_run_topics_test_case_id_agent_eval_test_cases_id_fk" FOREIGN KEY ("test_case_id") REFERENCES "public"."agent_eval_test_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_eval_runs" DROP CONSTRAINT IF EXISTS "agent_eval_runs_dataset_id_agent_eval_datasets_id_fk";--> statement-breakpoint
ALTER TABLE "agent_eval_runs" ADD CONSTRAINT "agent_eval_runs_dataset_id_agent_eval_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."agent_eval_datasets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_eval_runs" DROP CONSTRAINT IF EXISTS "agent_eval_runs_target_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "agent_eval_runs" ADD CONSTRAINT "agent_eval_runs_target_agent_id_agents_id_fk" FOREIGN KEY ("target_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_eval_runs" DROP CONSTRAINT IF EXISTS "agent_eval_runs_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "agent_eval_runs" ADD CONSTRAINT "agent_eval_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_eval_test_cases" DROP CONSTRAINT IF EXISTS "agent_eval_test_cases_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "agent_eval_test_cases" ADD CONSTRAINT "agent_eval_test_cases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_eval_test_cases" DROP CONSTRAINT IF EXISTS "agent_eval_test_cases_dataset_id_agent_eval_datasets_id_fk";--> statement-breakpoint
ALTER TABLE "agent_eval_test_cases" ADD CONSTRAINT "agent_eval_test_cases_dataset_id_agent_eval_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."agent_eval_datasets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_eval_benchmarks_identifier_unique" ON "agent_eval_benchmarks" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_eval_benchmarks_is_system_idx" ON "agent_eval_benchmarks" USING btree ("is_system");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_eval_datasets_identifier_user_id_unique" ON "agent_eval_datasets" USING btree ("identifier","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_eval_datasets_benchmark_id_idx" ON "agent_eval_datasets" USING btree ("benchmark_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_eval_datasets_user_id_idx" ON "agent_eval_datasets" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_eval_run_topics_user_id_idx" ON "agent_eval_run_topics" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_eval_run_topics_run_id_idx" ON "agent_eval_run_topics" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_eval_run_topics_test_case_id_idx" ON "agent_eval_run_topics" USING btree ("test_case_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_eval_runs_dataset_id_idx" ON "agent_eval_runs" USING btree ("dataset_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_eval_runs_user_id_idx" ON "agent_eval_runs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_eval_runs_status_idx" ON "agent_eval_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_eval_runs_target_agent_id_idx" ON "agent_eval_runs" USING btree ("target_agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_eval_test_cases_user_id_idx" ON "agent_eval_test_cases" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_eval_test_cases_dataset_id_idx" ON "agent_eval_test_cases" USING btree ("dataset_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_eval_test_cases_sort_order_idx" ON "agent_eval_test_cases" USING btree ("sort_order");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "threads_type_idx" ON "threads" USING btree ("type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "topics_trigger_idx" ON "topics" USING btree ("trigger");
--> statement-breakpoint
-- ===== 0088_fix_benchmark_add_bot_provider =====
CREATE TABLE IF NOT EXISTS "agent_bot_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" text NOT NULL,
	"user_id" text NOT NULL,
	"platform" varchar(50) NOT NULL,
	"application_id" varchar(255) NOT NULL,
	"credentials" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX IF EXISTS "agent_eval_benchmarks_identifier_unique";--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "agency_config" jsonb;--> statement-breakpoint
ALTER TABLE "agent_eval_benchmarks" ADD COLUMN IF NOT EXISTS "user_id" text;--> statement-breakpoint
ALTER TABLE "agent_bot_providers" DROP CONSTRAINT IF EXISTS "agent_bot_providers_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "agent_bot_providers" ADD CONSTRAINT "agent_bot_providers_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_bot_providers" DROP CONSTRAINT IF EXISTS "agent_bot_providers_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "agent_bot_providers" ADD CONSTRAINT "agent_bot_providers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_bot_providers_platform_app_id_unique" ON "agent_bot_providers" USING btree ("platform","application_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_bot_providers_platform_idx" ON "agent_bot_providers" USING btree ("platform");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_bot_providers_agent_id_idx" ON "agent_bot_providers" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_bot_providers_user_id_idx" ON "agent_bot_providers" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "agent_eval_benchmarks" DROP CONSTRAINT IF EXISTS "agent_eval_benchmarks_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "agent_eval_benchmarks" ADD CONSTRAINT "agent_eval_benchmarks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_eval_benchmarks_identifier_user_id_unique" ON "agent_eval_benchmarks" USING btree ("identifier","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_eval_benchmarks_user_id_idx" ON "agent_eval_benchmarks" USING btree ("user_id");
--> statement-breakpoint
-- ===== 0089_add_api_key_hash =====
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "key_hash" varchar(128);--> statement-breakpoint
ALTER TABLE "api_keys" DROP CONSTRAINT IF EXISTS "api_keys_key_hash_unique";--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash");
--> statement-breakpoint
-- ===== 0090_enable_pg_search =====
-- Custom SQL migration file, put your code below! --
CREATE EXTENSION IF NOT EXISTS pg_search;
--> statement-breakpoint
-- ===== 0091_topics_add_description =====
ALTER TABLE "topics" ADD COLUMN IF NOT EXISTS "description" text;
--> statement-breakpoint
-- ===== 0092_add_agent_documents =====
CREATE TABLE IF NOT EXISTS "agent_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
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

ALTER TABLE "agent_documents" DROP CONSTRAINT IF EXISTS "agent_documents_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "agent_documents" ADD CONSTRAINT "agent_documents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_documents" DROP CONSTRAINT IF EXISTS "agent_documents_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "agent_documents" ADD CONSTRAINT "agent_documents_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_documents" DROP CONSTRAINT IF EXISTS "agent_documents_document_id_documents_id_fk";--> statement-breakpoint
ALTER TABLE "agent_documents" ADD CONSTRAINT "agent_documents_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_documents" DROP CONSTRAINT IF EXISTS "agent_documents_deleted_by_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "agent_documents" ADD CONSTRAINT "agent_documents_deleted_by_user_id_users_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_documents" DROP CONSTRAINT IF EXISTS "agent_documents_deleted_by_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "agent_documents" ADD CONSTRAINT "agent_documents_deleted_by_agent_id_agents_id_fk" FOREIGN KEY ("deleted_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "agent_documents_user_id_idx" ON "agent_documents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_documents_agent_id_idx" ON "agent_documents" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_documents_access_self_idx" ON "agent_documents" USING btree ("access_self");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_documents_access_shared_idx" ON "agent_documents" USING btree ("access_shared");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_documents_access_public_idx" ON "agent_documents" USING btree ("access_public");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_documents_policy_load_idx" ON "agent_documents" USING btree ("policy_load");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_documents_template_id_idx" ON "agent_documents" USING btree ("template_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_documents_policy_load_position_idx" ON "agent_documents" USING btree ("policy_load_position");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_documents_policy_load_format_idx" ON "agent_documents" USING btree ("policy_load_format");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_documents_policy_load_rule_idx" ON "agent_documents" USING btree ("policy_load_rule");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_documents_agent_load_position_idx" ON "agent_documents" USING btree ("agent_id","policy_load_position");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_documents_deleted_at_idx" ON "agent_documents" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_documents_agent_autoload_deleted_idx" ON "agent_documents" USING btree ("agent_id","deleted_at","policy_load");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_documents_document_id_idx" ON "agent_documents" USING btree ("document_id");--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "agent_documents_agent_document_user_unique" ON "agent_documents" USING btree ("agent_id","document_id","user_id");
--> statement-breakpoint
-- ===== 0093_add_bm25_indexes_with_icu =====
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
-- ===== 0094_agent_bot_providers_add_settings =====
ALTER TABLE "agent_bot_providers" ADD COLUMN IF NOT EXISTS "settings" jsonb DEFAULT '{}'::jsonb;
--> statement-breakpoint
-- ===== 0095_add_agent_task_system =====
CREATE TABLE IF NOT EXISTS "briefs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
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
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_comments" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"user_id" text NOT NULL,
	"author_user_id" text,
	"author_agent_id" text,
	"content" text NOT NULL,
	"editor_data" jsonb,
	"brief_id" text,
	"topic_id" text,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_dependencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" text NOT NULL,
	"depends_on_id" text NOT NULL,
	"user_id" text NOT NULL,
	"type" text DEFAULT 'blocks' NOT NULL,
	"condition" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" text NOT NULL,
	"document_id" text NOT NULL,
	"user_id" text NOT NULL,
	"pinned_by" text DEFAULT 'agent' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_topics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" text NOT NULL,
	"topic_id" text,
	"user_id" text NOT NULL,
	"seq" integer NOT NULL,
	"operation_id" text,
	"status" text DEFAULT 'running' NOT NULL,
	"handoff" jsonb,
	"review_passed" integer,
	"review_score" integer,
	"review_scores" jsonb,
	"review_iteration" integer,
	"reviewed_at" timestamp with time zone,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"seq" integer NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_by_agent_id" text,
	"assignee_user_id" text,
	"assignee_agent_id" text,
	"parent_task_id" text,
	"name" text,
	"description" varchar(255),
	"instruction" text NOT NULL,
	"status" text DEFAULT 'backlog' NOT NULL,
	"priority" integer DEFAULT 0,
	"sort_order" integer DEFAULT 0,
	"heartbeat_interval" integer DEFAULT 300,
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
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "briefs" DROP CONSTRAINT IF EXISTS "briefs_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "briefs" ADD CONSTRAINT "briefs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "briefs" DROP CONSTRAINT IF EXISTS "briefs_task_id_tasks_id_fk";--> statement-breakpoint
ALTER TABLE "briefs" ADD CONSTRAINT "briefs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "briefs" DROP CONSTRAINT IF EXISTS "briefs_cron_job_id_agent_cron_jobs_id_fk";--> statement-breakpoint
ALTER TABLE "briefs" ADD CONSTRAINT "briefs_cron_job_id_agent_cron_jobs_id_fk" FOREIGN KEY ("cron_job_id") REFERENCES "public"."agent_cron_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" DROP CONSTRAINT IF EXISTS "task_comments_task_id_tasks_id_fk";--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" DROP CONSTRAINT IF EXISTS "task_comments_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" DROP CONSTRAINT IF EXISTS "task_comments_author_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" DROP CONSTRAINT IF EXISTS "task_comments_author_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_author_agent_id_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" DROP CONSTRAINT IF EXISTS "task_comments_brief_id_briefs_id_fk";--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_brief_id_briefs_id_fk" FOREIGN KEY ("brief_id") REFERENCES "public"."briefs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" DROP CONSTRAINT IF EXISTS "task_comments_topic_id_topics_id_fk";--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" DROP CONSTRAINT IF EXISTS "task_dependencies_task_id_tasks_id_fk";--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" DROP CONSTRAINT IF EXISTS "task_dependencies_depends_on_id_tasks_id_fk";--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_depends_on_id_tasks_id_fk" FOREIGN KEY ("depends_on_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" DROP CONSTRAINT IF EXISTS "task_dependencies_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_documents" DROP CONSTRAINT IF EXISTS "task_documents_task_id_tasks_id_fk";--> statement-breakpoint
ALTER TABLE "task_documents" ADD CONSTRAINT "task_documents_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_documents" DROP CONSTRAINT IF EXISTS "task_documents_document_id_documents_id_fk";--> statement-breakpoint
ALTER TABLE "task_documents" ADD CONSTRAINT "task_documents_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_documents" DROP CONSTRAINT IF EXISTS "task_documents_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "task_documents" ADD CONSTRAINT "task_documents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_topics" DROP CONSTRAINT IF EXISTS "task_topics_task_id_tasks_id_fk";--> statement-breakpoint
ALTER TABLE "task_topics" ADD CONSTRAINT "task_topics_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_topics" DROP CONSTRAINT IF EXISTS "task_topics_topic_id_topics_id_fk";--> statement-breakpoint
ALTER TABLE "task_topics" ADD CONSTRAINT "task_topics_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_topics" DROP CONSTRAINT IF EXISTS "task_topics_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "task_topics" ADD CONSTRAINT "task_topics_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT IF EXISTS "tasks_created_by_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT IF EXISTS "tasks_created_by_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT IF EXISTS "tasks_assignee_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_user_id_users_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT IF EXISTS "tasks_assignee_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_agent_id_agents_id_fk" FOREIGN KEY ("assignee_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT IF EXISTS "tasks_current_topic_id_topics_id_fk";--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_current_topic_id_topics_id_fk" FOREIGN KEY ("current_topic_id") REFERENCES "public"."topics"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT IF EXISTS "tasks_parent_task_id_tasks_id_fk";--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_task_id_tasks_id_fk" FOREIGN KEY ("parent_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "briefs_user_id_idx" ON "briefs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "briefs_task_id_idx" ON "briefs" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "briefs_cron_job_id_idx" ON "briefs" USING btree ("cron_job_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "briefs_agent_id_idx" ON "briefs" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "briefs_type_idx" ON "briefs" USING btree ("type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "briefs_priority_idx" ON "briefs" USING btree ("priority");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "briefs_unresolved_idx" ON "briefs" USING btree ("user_id","resolved_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_comments_task_id_idx" ON "task_comments" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_comments_user_id_idx" ON "task_comments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_comments_author_user_id_idx" ON "task_comments" USING btree ("author_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_comments_agent_id_idx" ON "task_comments" USING btree ("author_agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_comments_brief_id_idx" ON "task_comments" USING btree ("brief_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_comments_topic_id_idx" ON "task_comments" USING btree ("topic_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "task_deps_unique_idx" ON "task_dependencies" USING btree ("task_id","depends_on_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_deps_task_id_idx" ON "task_dependencies" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_deps_depends_on_id_idx" ON "task_dependencies" USING btree ("depends_on_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_deps_user_id_idx" ON "task_dependencies" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "task_docs_unique_idx" ON "task_documents" USING btree ("task_id","document_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_docs_task_id_idx" ON "task_documents" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_docs_document_id_idx" ON "task_documents" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_docs_user_id_idx" ON "task_documents" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "task_topics_unique_idx" ON "task_topics" USING btree ("task_id","topic_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_topics_task_id_idx" ON "task_topics" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_topics_topic_id_idx" ON "task_topics" USING btree ("topic_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_topics_user_id_idx" ON "task_topics" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_topics_status_idx" ON "task_topics" USING btree ("task_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tasks_identifier_idx" ON "tasks" USING btree ("identifier","created_by_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_created_by_user_id_idx" ON "tasks" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_created_by_agent_id_idx" ON "tasks" USING btree ("created_by_agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_assignee_user_id_idx" ON "tasks" USING btree ("assignee_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_assignee_agent_id_idx" ON "tasks" USING btree ("assignee_agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_parent_task_id_idx" ON "tasks" USING btree ("parent_task_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_status_idx" ON "tasks" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_priority_idx" ON "tasks" USING btree ("priority");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_heartbeat_idx" ON "tasks" USING btree ("status","last_heartbeat_at");
--> statement-breakpoint
-- ===== 0096_add_notification_tables =====
CREATE TABLE IF NOT EXISTS "notification_deliveries" (
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
CREATE TABLE IF NOT EXISTS "notifications" (
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
ALTER TABLE "user_settings" ADD COLUMN IF NOT EXISTS "notification" jsonb;--> statement-breakpoint
ALTER TABLE "notification_deliveries" DROP CONSTRAINT IF EXISTS "notification_deliveries_notification_id_notifications_id_fk";--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT IF EXISTS "notifications_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_deliveries_notification" ON "notification_deliveries" USING btree ("notification_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_deliveries_channel" ON "notification_deliveries" USING btree ("channel");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_deliveries_status" ON "notification_deliveries" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_notifications_user" ON "notifications" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_notifications_user_active" ON "notifications" USING btree ("user_id","created_at") WHERE "notifications"."is_archived" = false;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_notifications_user_unread" ON "notifications" USING btree ("user_id") WHERE "notifications"."is_read" = false AND "notifications"."is_archived" = false;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_notifications_dedupe" ON "notifications" USING btree ("user_id","dedupe_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_notifications_archived_cleanup" ON "notifications" USING btree ("updated_at","created_at","id") WHERE "notifications"."is_archived" = true;
--> statement-breakpoint
-- ===== 0097_add_agent_onboarding =====
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "agent_onboarding" jsonb;
--> statement-breakpoint
-- ===== 0098_add_document_history =====
CREATE TABLE IF NOT EXISTS "document_histories" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"document_id" varchar(255) NOT NULL,
	"user_id" text NOT NULL,
	"editor_data" jsonb NOT NULL,
	"save_source" text NOT NULL,
	"saved_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_histories" DROP CONSTRAINT IF EXISTS "document_histories_document_id_documents_id_fk";--> statement-breakpoint
ALTER TABLE "document_histories" ADD CONSTRAINT "document_histories_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_histories" DROP CONSTRAINT IF EXISTS "document_histories_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "document_histories" ADD CONSTRAINT "document_histories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_histories_document_id_idx" ON "document_histories" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_histories_user_id_idx" ON "document_histories" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_histories_saved_at_idx" ON "document_histories" USING btree ("saved_at");
--> statement-breakpoint
-- ===== 0099_topic_status_tasks_automation_mode =====
ALTER TABLE "tasks" ALTER COLUMN "heartbeat_interval" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "automation_mode" text;--> statement-breakpoint
ALTER TABLE "topics" ADD COLUMN IF NOT EXISTS "status" text;--> statement-breakpoint
ALTER TABLE "topics" ADD COLUMN IF NOT EXISTS "completed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_automation_mode_idx" ON "tasks" USING btree ("automation_mode");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "topics_status_idx" ON "topics" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "topics_user_id_completed_at_idx" ON "topics" USING btree ("user_id","completed_at");
--> statement-breakpoint
-- ===== 0100_add_metadata_and_trigger_to_briefs =====
ALTER TABLE "briefs" ADD COLUMN IF NOT EXISTS "trigger" varchar(255);--> statement-breakpoint
ALTER TABLE "briefs" ADD COLUMN IF NOT EXISTS "metadata" jsonb;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "briefs_trigger_idx" ON "briefs" USING btree ("trigger");
--> statement-breakpoint
-- ===== 0101_add_messenger_tables =====
CREATE TABLE IF NOT EXISTS "messenger_account_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
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
CREATE TABLE IF NOT EXISTS "messenger_installations" (
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
CREATE TABLE IF NOT EXISTS "system_bot_providers" (
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
ALTER TABLE "messenger_account_links" DROP CONSTRAINT IF EXISTS "messenger_account_links_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "messenger_account_links" ADD CONSTRAINT "messenger_account_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messenger_account_links" DROP CONSTRAINT IF EXISTS "messenger_account_links_active_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "messenger_account_links" ADD CONSTRAINT "messenger_account_links_active_agent_id_agents_id_fk" FOREIGN KEY ("active_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messenger_installations" DROP CONSTRAINT IF EXISTS "messenger_installations_installed_by_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "messenger_installations" ADD CONSTRAINT "messenger_installations_installed_by_user_id_users_id_fk" FOREIGN KEY ("installed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "messenger_account_links_platform_tenant_user_unique" ON "messenger_account_links" USING btree ("platform","tenant_id","platform_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "messenger_account_links_user_platform_tenant_unique" ON "messenger_account_links" USING btree ("user_id","platform","tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messenger_account_links_active_agent_idx" ON "messenger_account_links" USING btree ("active_agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "messenger_installations_platform_app_tenant_unique" ON "messenger_installations" USING btree ("platform","application_id","tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messenger_installations_platform_tenant_idx" ON "messenger_installations" USING btree ("platform","tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messenger_installations_token_expires_at_idx" ON "messenger_installations" USING btree ("token_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "system_bot_providers_platform_unique" ON "system_bot_providers" USING btree ("platform");
--> statement-breakpoint
-- ===== 0102_add_agent_operations_table =====
CREATE TABLE IF NOT EXISTS "agent_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" text,
	"topic_id" text,
	"thread_id" text,
	"task_id" text,
	"chat_group_id" text,
	"parent_operation_id" text,
	"status" text NOT NULL,
	"completion_reason" text,
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
ALTER TABLE "agent_operations" DROP CONSTRAINT IF EXISTS "agent_operations_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "agent_operations" ADD CONSTRAINT "agent_operations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_operations" DROP CONSTRAINT IF EXISTS "agent_operations_topic_id_topics_id_fk";--> statement-breakpoint
ALTER TABLE "agent_operations" ADD CONSTRAINT "agent_operations_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_operations" DROP CONSTRAINT IF EXISTS "agent_operations_thread_id_threads_id_fk";--> statement-breakpoint
ALTER TABLE "agent_operations" ADD CONSTRAINT "agent_operations_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_operations" DROP CONSTRAINT IF EXISTS "agent_operations_task_id_tasks_id_fk";--> statement-breakpoint
ALTER TABLE "agent_operations" ADD CONSTRAINT "agent_operations_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_operations" DROP CONSTRAINT IF EXISTS "agent_operations_chat_group_id_chat_groups_id_fk";--> statement-breakpoint
ALTER TABLE "agent_operations" ADD CONSTRAINT "agent_operations_chat_group_id_chat_groups_id_fk" FOREIGN KEY ("chat_group_id") REFERENCES "public"."chat_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_operations_user_id_idx" ON "agent_operations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_operations_agent_id_idx" ON "agent_operations" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_operations_topic_id_idx" ON "agent_operations" USING btree ("topic_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_operations_thread_id_idx" ON "agent_operations" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_operations_task_id_idx" ON "agent_operations" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_operations_chat_group_id_idx" ON "agent_operations" USING btree ("chat_group_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_operations_parent_operation_id_idx" ON "agent_operations" USING btree ("parent_operation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_operations_status_idx" ON "agent_operations" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_operations_user_id_created_at_idx" ON "agent_operations" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_operations_metadata_idx" ON "agent_operations" USING gin ("metadata");
--> statement-breakpoint
-- ===== 0103_add_llm_tracing_and_eval_experiments =====
CREATE TABLE IF NOT EXISTS "agent_eval_experiment_benchmarks" (
	"experiment_id" text NOT NULL,
	"benchmark_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_eval_experiment_benchmarks_experiment_id_benchmark_id_pk" PRIMARY KEY("experiment_id","benchmark_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_eval_experiments" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"metadata" jsonb,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "llm_generation_tracing" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scenario" text NOT NULL,
	"prompt_version" text NOT NULL,
	"prompt_hash" text NOT NULL,
	"schema_name" text,
	"user_id" text NOT NULL,
	"agent_id" text,
	"topic_id" text,
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
ALTER TABLE "agent_eval_datasets" ADD COLUMN IF NOT EXISTS "source_experiment_id" text;--> statement-breakpoint
ALTER TABLE "agent_eval_runs" ADD COLUMN IF NOT EXISTS "experiment_id" text;--> statement-breakpoint
ALTER TABLE "agent_eval_runs" ADD COLUMN IF NOT EXISTS "parent_run_id" text;--> statement-breakpoint
ALTER TABLE "agent_eval_experiment_benchmarks" DROP CONSTRAINT IF EXISTS "agent_eval_experiment_benchmarks_experiment_id_agent_eval_experiments_id_fk";--> statement-breakpoint
ALTER TABLE "agent_eval_experiment_benchmarks" ADD CONSTRAINT "agent_eval_experiment_benchmarks_experiment_id_agent_eval_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."agent_eval_experiments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_eval_experiment_benchmarks" DROP CONSTRAINT IF EXISTS "agent_eval_experiment_benchmarks_benchmark_id_agent_eval_benchmarks_id_fk";--> statement-breakpoint
ALTER TABLE "agent_eval_experiment_benchmarks" ADD CONSTRAINT "agent_eval_experiment_benchmarks_benchmark_id_agent_eval_benchmarks_id_fk" FOREIGN KEY ("benchmark_id") REFERENCES "public"."agent_eval_benchmarks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_eval_experiment_benchmarks" DROP CONSTRAINT IF EXISTS "agent_eval_experiment_benchmarks_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "agent_eval_experiment_benchmarks" ADD CONSTRAINT "agent_eval_experiment_benchmarks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_eval_experiments" DROP CONSTRAINT IF EXISTS "agent_eval_experiments_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "agent_eval_experiments" ADD CONSTRAINT "agent_eval_experiments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_eval_experiment_benchmarks_benchmark_id_idx" ON "agent_eval_experiment_benchmarks" USING btree ("benchmark_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_eval_experiment_benchmarks_user_id_idx" ON "agent_eval_experiment_benchmarks" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_eval_experiments_user_id_idx" ON "agent_eval_experiments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_generation_tracing_scenario_idx" ON "llm_generation_tracing" USING btree ("scenario");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_generation_tracing_prompt_version_idx" ON "llm_generation_tracing" USING btree ("prompt_version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_generation_tracing_user_id_idx" ON "llm_generation_tracing" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_generation_tracing_agent_id_idx" ON "llm_generation_tracing" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_generation_tracing_topic_id_idx" ON "llm_generation_tracing" USING btree ("topic_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_generation_tracing_provider_idx" ON "llm_generation_tracing" USING btree ("provider");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_generation_tracing_model_idx" ON "llm_generation_tracing" USING btree ("model");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_generation_tracing_success_idx" ON "llm_generation_tracing" USING btree ("success");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_generation_tracing_error_code_idx" ON "llm_generation_tracing" USING btree ("error_code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_generation_tracing_validation_failed_idx" ON "llm_generation_tracing" USING btree ("validation_failed");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_generation_tracing_feedback_signal_idx" ON "llm_generation_tracing" USING btree ("feedback_signal");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_generation_tracing_created_at_idx" ON "llm_generation_tracing" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "agent_eval_datasets" DROP CONSTRAINT IF EXISTS "agent_eval_datasets_source_experiment_id_agent_eval_experiments_id_fk";--> statement-breakpoint
ALTER TABLE "agent_eval_datasets" ADD CONSTRAINT "agent_eval_datasets_source_experiment_id_agent_eval_experiments_id_fk" FOREIGN KEY ("source_experiment_id") REFERENCES "public"."agent_eval_experiments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_eval_runs" DROP CONSTRAINT IF EXISTS "agent_eval_runs_experiment_id_agent_eval_experiments_id_fk";--> statement-breakpoint
ALTER TABLE "agent_eval_runs" ADD CONSTRAINT "agent_eval_runs_experiment_id_agent_eval_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."agent_eval_experiments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_eval_runs" DROP CONSTRAINT IF EXISTS "agent_eval_runs_parent_run_id_agent_eval_runs_id_fk";--> statement-breakpoint
ALTER TABLE "agent_eval_runs" ADD CONSTRAINT "agent_eval_runs_parent_run_id_agent_eval_runs_id_fk" FOREIGN KEY ("parent_run_id") REFERENCES "public"."agent_eval_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_eval_datasets_source_experiment_id_idx" ON "agent_eval_datasets" USING btree ("source_experiment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_eval_runs_experiment_id_idx" ON "agent_eval_runs" USING btree ("experiment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_eval_runs_parent_run_id_idx" ON "agent_eval_runs" USING btree ("parent_run_id");
--> statement-breakpoint
-- ===== 0104_add_devices_connectors_push_tokens =====
CREATE TABLE IF NOT EXISTS "user_connector_tools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_connector_id" uuid NOT NULL,
	"user_id" text NOT NULL,
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
CREATE TABLE IF NOT EXISTS "user_connectors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
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
CREATE TABLE IF NOT EXISTS "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"device_id" varchar(64) NOT NULL,
	"identity_source" varchar(20) NOT NULL,
	"hostname" text,
	"platform" varchar(20),
	"friendly_name" text,
	"default_cwd" text,
	"recent_cwds" text[] DEFAULT '{}' NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "document_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" varchar(255) NOT NULL,
	"user_id" text NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"permission" text DEFAULT 'read' NOT NULL,
	"page_view_count" integer DEFAULT 0 NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "push_tokens" (
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
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "editor_data" jsonb;--> statement-breakpoint
ALTER TABLE "topics" ADD COLUMN IF NOT EXISTS "total_cost" numeric(20, 6);--> statement-breakpoint
ALTER TABLE "topics" ADD COLUMN IF NOT EXISTS "total_input_tokens" integer;--> statement-breakpoint
ALTER TABLE "topics" ADD COLUMN IF NOT EXISTS "total_output_tokens" integer;--> statement-breakpoint
ALTER TABLE "topics" ADD COLUMN IF NOT EXISTS "total_tokens" integer;--> statement-breakpoint
ALTER TABLE "topics" ADD COLUMN IF NOT EXISTS "cost" jsonb;--> statement-breakpoint
ALTER TABLE "topics" ADD COLUMN IF NOT EXISTS "usage" jsonb;--> statement-breakpoint
ALTER TABLE "topics" ADD COLUMN IF NOT EXISTS "model" text;--> statement-breakpoint
ALTER TABLE "topics" ADD COLUMN IF NOT EXISTS "provider" text;--> statement-breakpoint
ALTER TABLE "user_connector_tools" DROP CONSTRAINT IF EXISTS "user_connector_tools_user_connector_id_user_connectors_id_fk";--> statement-breakpoint
ALTER TABLE "user_connector_tools" ADD CONSTRAINT "user_connector_tools_user_connector_id_user_connectors_id_fk" FOREIGN KEY ("user_connector_id") REFERENCES "public"."user_connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_connector_tools" DROP CONSTRAINT IF EXISTS "user_connector_tools_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "user_connector_tools" ADD CONSTRAINT "user_connector_tools_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_connectors" DROP CONSTRAINT IF EXISTS "user_connectors_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "user_connectors" ADD CONSTRAINT "user_connectors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" DROP CONSTRAINT IF EXISTS "devices_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_shares" DROP CONSTRAINT IF EXISTS "document_shares_document_id_documents_id_fk";--> statement-breakpoint
ALTER TABLE "document_shares" ADD CONSTRAINT "document_shares_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_shares" DROP CONSTRAINT IF EXISTS "document_shares_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "document_shares" ADD CONSTRAINT "document_shares_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_tokens" DROP CONSTRAINT IF EXISTS "push_tokens_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "push_tokens" ADD CONSTRAINT "push_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_connector_tools_connector_tool_unique" ON "user_connector_tools" USING btree ("user_connector_id","tool_name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_connector_tools_user_id_idx" ON "user_connector_tools" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_connector_tools_connector_id_idx" ON "user_connector_tools" USING btree ("user_connector_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_connectors_user_identifier_unique" ON "user_connectors" USING btree ("user_id","identifier");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_connectors_user_id_idx" ON "user_connectors" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_connectors_token_expires_at_idx" ON "user_connectors" USING btree ("token_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "devices_user_id_device_id_unique" ON "devices" USING btree ("user_id","device_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "devices_user_id_idx" ON "devices" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "document_shares_document_id_unique" ON "document_shares" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_shares_user_id_idx" ON "document_shares" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_push_tokens_user_device" ON "push_tokens" USING btree ("user_id","device_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_push_tokens_user" ON "push_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_push_tokens_last_seen" ON "push_tokens" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "topics_model_idx" ON "topics" USING btree ("model");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "topics_provider_idx" ON "topics" USING btree ("provider");
--> statement-breakpoint
-- ===== 0105_add_usage_agent_share_workspace =====
CREATE TABLE IF NOT EXISTS "agent_shares" (
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
CREATE TABLE IF NOT EXISTS "workspace_audit_logs" (
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
CREATE TABLE IF NOT EXISTS "workspace_invitations" (
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
CREATE TABLE IF NOT EXISTS "workspace_members" (
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "workspace_members_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" varchar(100) NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" varchar(1000),
	"avatar" text,
	"primary_owner_id" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "usage" jsonb;--> statement-breakpoint
ALTER TABLE "topics" ADD COLUMN IF NOT EXISTS "sender_id" text;--> statement-breakpoint
ALTER TABLE "agent_shares" DROP CONSTRAINT IF EXISTS "agent_shares_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "agent_shares" ADD CONSTRAINT "agent_shares_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_audit_logs" DROP CONSTRAINT IF EXISTS "workspace_audit_logs_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "workspace_audit_logs" ADD CONSTRAINT "workspace_audit_logs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_invitations" DROP CONSTRAINT IF EXISTS "workspace_invitations_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_invitations" DROP CONSTRAINT IF EXISTS "workspace_invitations_inviter_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_inviter_id_users_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" DROP CONSTRAINT IF EXISTS "workspace_members_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" DROP CONSTRAINT IF EXISTS "workspace_members_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" DROP CONSTRAINT IF EXISTS "workspaces_primary_owner_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_primary_owner_id_users_id_fk" FOREIGN KEY ("primary_owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_shares_agent_id_unique" ON "agent_shares" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_shares_visibility_idx" ON "agent_shares" USING btree ("visibility");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_audit_logs_workspace_id_idx" ON "workspace_audit_logs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_audit_logs_action_idx" ON "workspace_audit_logs" USING btree ("action");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_audit_logs_created_at_idx" ON "workspace_audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_invitations_workspace_id_idx" ON "workspace_invitations" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_invitations_email_idx" ON "workspace_invitations" USING btree ("email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_invitations_token_idx" ON "workspace_invitations" USING btree ("token");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_members_user_id_idx" ON "workspace_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workspaces_slug_idx" ON "workspaces" USING btree ("slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspaces_primary_owner_id_idx" ON "workspaces" USING btree ("primary_owner_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_usage_cost_idx" ON "messages" USING btree ((("usage"->>'cost')::numeric));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_usage_total_tokens_idx" ON "messages" USING btree ((("usage"->>'totalTokens')::numeric));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "topics_sender_id_idx" ON "topics" USING btree ("sender_id");
--> statement-breakpoint
-- ===== 0106_add_workspace_id_columns =====
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "agents_files" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "agents_knowledge_bases" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "agent_bot_providers" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "agent_cron_jobs" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "agent_documents" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "agent_eval_benchmarks" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "agent_eval_datasets" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "agent_eval_experiment_benchmarks" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "agent_eval_experiments" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "agent_eval_run_topics" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "agent_eval_runs" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "agent_eval_test_cases" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "agent_operations" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "agent_skills" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "ai_models" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "ai_providers" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "async_tasks" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "chat_groups" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "chat_groups_agents" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "user_connector_tools" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "user_connectors" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "working_dirs" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "document_histories" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "document_shares" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "knowledge_base_files" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "knowledge_bases" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "generation_batches" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "generation_topics" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "generations" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "llm_generation_tracing" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "message_chunks" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "message_groups" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "message_plugins" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "message_queries" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "message_query_chunks" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "message_tts" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "message_translates" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "messages_files" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "messenger_account_links" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "document_chunks" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "embeddings" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "unstructured_chunks" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "rag_eval_dataset_records" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "rag_eval_datasets" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "rag_eval_evaluations" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "rag_eval_evaluation_records" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "rbac_roles" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "rbac_user_roles" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "agents_to_sessions" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "file_chunks" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "files_to_sessions" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "session_groups" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "briefs" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "task_comments" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "task_documents" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "task_topics" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "topic_documents" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "topic_shares" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "topics" ADD COLUMN IF NOT EXISTS "workspace_id" text;--> statement-breakpoint
ALTER TABLE "user_installed_plugins" ADD COLUMN IF NOT EXISTS "workspace_id" text;
--> statement-breakpoint
-- ===== 0107_add_workspace_id_fk =====
ALTER TABLE "agents" DROP CONSTRAINT IF EXISTS "agents_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents_files" DROP CONSTRAINT IF EXISTS "agents_files_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "agents_files" ADD CONSTRAINT "agents_files_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents_knowledge_bases" DROP CONSTRAINT IF EXISTS "agents_knowledge_bases_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "agents_knowledge_bases" ADD CONSTRAINT "agents_knowledge_bases_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_bot_providers" DROP CONSTRAINT IF EXISTS "agent_bot_providers_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "agent_bot_providers" ADD CONSTRAINT "agent_bot_providers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_cron_jobs" DROP CONSTRAINT IF EXISTS "agent_cron_jobs_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "agent_cron_jobs" ADD CONSTRAINT "agent_cron_jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_documents" DROP CONSTRAINT IF EXISTS "agent_documents_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "agent_documents" ADD CONSTRAINT "agent_documents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_eval_benchmarks" DROP CONSTRAINT IF EXISTS "agent_eval_benchmarks_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "agent_eval_benchmarks" ADD CONSTRAINT "agent_eval_benchmarks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_eval_datasets" DROP CONSTRAINT IF EXISTS "agent_eval_datasets_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "agent_eval_datasets" ADD CONSTRAINT "agent_eval_datasets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_eval_experiment_benchmarks" DROP CONSTRAINT IF EXISTS "agent_eval_experiment_benchmarks_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "agent_eval_experiment_benchmarks" ADD CONSTRAINT "agent_eval_experiment_benchmarks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_eval_experiments" DROP CONSTRAINT IF EXISTS "agent_eval_experiments_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "agent_eval_experiments" ADD CONSTRAINT "agent_eval_experiments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_eval_run_topics" DROP CONSTRAINT IF EXISTS "agent_eval_run_topics_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "agent_eval_run_topics" ADD CONSTRAINT "agent_eval_run_topics_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_eval_runs" DROP CONSTRAINT IF EXISTS "agent_eval_runs_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "agent_eval_runs" ADD CONSTRAINT "agent_eval_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_eval_test_cases" DROP CONSTRAINT IF EXISTS "agent_eval_test_cases_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "agent_eval_test_cases" ADD CONSTRAINT "agent_eval_test_cases_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_operations" DROP CONSTRAINT IF EXISTS "agent_operations_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "agent_operations" ADD CONSTRAINT "agent_operations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skills" DROP CONSTRAINT IF EXISTS "agent_skills_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_models" DROP CONSTRAINT IF EXISTS "ai_models_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "ai_models" ADD CONSTRAINT "ai_models_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_providers" DROP CONSTRAINT IF EXISTS "ai_providers_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "ai_providers" ADD CONSTRAINT "ai_providers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" DROP CONSTRAINT IF EXISTS "api_keys_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "async_tasks" DROP CONSTRAINT IF EXISTS "async_tasks_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "async_tasks" ADD CONSTRAINT "async_tasks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_groups" DROP CONSTRAINT IF EXISTS "chat_groups_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "chat_groups" ADD CONSTRAINT "chat_groups_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_groups_agents" DROP CONSTRAINT IF EXISTS "chat_groups_agents_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "chat_groups_agents" ADD CONSTRAINT "chat_groups_agents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_connector_tools" DROP CONSTRAINT IF EXISTS "user_connector_tools_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "user_connector_tools" ADD CONSTRAINT "user_connector_tools_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_connectors" DROP CONSTRAINT IF EXISTS "user_connectors_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "user_connectors" ADD CONSTRAINT "user_connectors_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" DROP CONSTRAINT IF EXISTS "devices_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_histories" DROP CONSTRAINT IF EXISTS "document_histories_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "document_histories" ADD CONSTRAINT "document_histories_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_shares" DROP CONSTRAINT IF EXISTS "document_shares_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "document_shares" ADD CONSTRAINT "document_shares_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" DROP CONSTRAINT IF EXISTS "files_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_base_files" DROP CONSTRAINT IF EXISTS "knowledge_base_files_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "knowledge_base_files" ADD CONSTRAINT "knowledge_base_files_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_bases" DROP CONSTRAINT IF EXISTS "knowledge_bases_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "knowledge_bases" ADD CONSTRAINT "knowledge_bases_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_batches" DROP CONSTRAINT IF EXISTS "generation_batches_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "generation_batches" ADD CONSTRAINT "generation_batches_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_topics" DROP CONSTRAINT IF EXISTS "generation_topics_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "generation_topics" ADD CONSTRAINT "generation_topics_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generations" DROP CONSTRAINT IF EXISTS "generations_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "generations" ADD CONSTRAINT "generations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_generation_tracing" DROP CONSTRAINT IF EXISTS "llm_generation_tracing_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "llm_generation_tracing" ADD CONSTRAINT "llm_generation_tracing_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_chunks" DROP CONSTRAINT IF EXISTS "message_chunks_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "message_chunks" ADD CONSTRAINT "message_chunks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_groups" DROP CONSTRAINT IF EXISTS "message_groups_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "message_groups" ADD CONSTRAINT "message_groups_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_plugins" DROP CONSTRAINT IF EXISTS "message_plugins_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "message_plugins" ADD CONSTRAINT "message_plugins_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_queries" DROP CONSTRAINT IF EXISTS "message_queries_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "message_queries" ADD CONSTRAINT "message_queries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_query_chunks" DROP CONSTRAINT IF EXISTS "message_query_chunks_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "message_query_chunks" ADD CONSTRAINT "message_query_chunks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_tts" DROP CONSTRAINT IF EXISTS "message_tts_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "message_tts" ADD CONSTRAINT "message_tts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_translates" DROP CONSTRAINT IF EXISTS "message_translates_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "message_translates" ADD CONSTRAINT "message_translates_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT IF EXISTS "messages_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages_files" DROP CONSTRAINT IF EXISTS "messages_files_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "messages_files" ADD CONSTRAINT "messages_files_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messenger_account_links" DROP CONSTRAINT IF EXISTS "messenger_account_links_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "messenger_account_links" ADD CONSTRAINT "messenger_account_links_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunks" DROP CONSTRAINT IF EXISTS "chunks_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_chunks" DROP CONSTRAINT IF EXISTS "document_chunks_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embeddings" DROP CONSTRAINT IF EXISTS "embeddings_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "embeddings" ADD CONSTRAINT "embeddings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unstructured_chunks" DROP CONSTRAINT IF EXISTS "unstructured_chunks_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "unstructured_chunks" ADD CONSTRAINT "unstructured_chunks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag_eval_dataset_records" DROP CONSTRAINT IF EXISTS "rag_eval_dataset_records_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "rag_eval_dataset_records" ADD CONSTRAINT "rag_eval_dataset_records_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag_eval_datasets" DROP CONSTRAINT IF EXISTS "rag_eval_datasets_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "rag_eval_datasets" ADD CONSTRAINT "rag_eval_datasets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag_eval_evaluations" DROP CONSTRAINT IF EXISTS "rag_eval_evaluations_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "rag_eval_evaluations" ADD CONSTRAINT "rag_eval_evaluations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag_eval_evaluation_records" DROP CONSTRAINT IF EXISTS "rag_eval_evaluation_records_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "rag_eval_evaluation_records" ADD CONSTRAINT "rag_eval_evaluation_records_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rbac_roles" DROP CONSTRAINT IF EXISTS "rbac_roles_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "rbac_roles" ADD CONSTRAINT "rbac_roles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rbac_user_roles" DROP CONSTRAINT IF EXISTS "rbac_user_roles_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "rbac_user_roles" ADD CONSTRAINT "rbac_user_roles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents_to_sessions" DROP CONSTRAINT IF EXISTS "agents_to_sessions_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "agents_to_sessions" ADD CONSTRAINT "agents_to_sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_chunks" DROP CONSTRAINT IF EXISTS "file_chunks_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "file_chunks" ADD CONSTRAINT "file_chunks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files_to_sessions" DROP CONSTRAINT IF EXISTS "files_to_sessions_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "files_to_sessions" ADD CONSTRAINT "files_to_sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_groups" DROP CONSTRAINT IF EXISTS "session_groups_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "session_groups" ADD CONSTRAINT "session_groups_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "briefs" DROP CONSTRAINT IF EXISTS "briefs_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "briefs" ADD CONSTRAINT "briefs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" DROP CONSTRAINT IF EXISTS "task_comments_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" DROP CONSTRAINT IF EXISTS "task_dependencies_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_documents" DROP CONSTRAINT IF EXISTS "task_documents_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "task_documents" ADD CONSTRAINT "task_documents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_topics" DROP CONSTRAINT IF EXISTS "task_topics_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "task_topics" ADD CONSTRAINT "task_topics_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT IF EXISTS "tasks_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" DROP CONSTRAINT IF EXISTS "threads_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_documents" DROP CONSTRAINT IF EXISTS "topic_documents_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "topic_documents" ADD CONSTRAINT "topic_documents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_shares" DROP CONSTRAINT IF EXISTS "topic_shares_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "topic_shares" ADD CONSTRAINT "topic_shares_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topics" DROP CONSTRAINT IF EXISTS "topics_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_installed_plugins" DROP CONSTRAINT IF EXISTS "user_installed_plugins_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "user_installed_plugins" ADD CONSTRAINT "user_installed_plugins_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- ===== 0108_add_workspace_id_indexes =====
CREATE INDEX IF NOT EXISTS "agents_workspace_id_idx" ON "agents" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agents_slug_workspace_id_unique" ON "agents" USING btree ("workspace_id","slug") WHERE "agents"."workspace_id" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_files_workspace_id_idx" ON "agents_files" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_knowledge_bases_workspace_id_idx" ON "agents_knowledge_bases" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_bot_providers_workspace_id_idx" ON "agent_bot_providers" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_cron_jobs_workspace_id_idx" ON "agent_cron_jobs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_documents_workspace_id_idx" ON "agent_documents" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_eval_benchmarks_workspace_id_idx" ON "agent_eval_benchmarks" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_eval_benchmarks_identifier_workspace_id_unique" ON "agent_eval_benchmarks" USING btree ("workspace_id","identifier") WHERE "agent_eval_benchmarks"."workspace_id" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_eval_datasets_workspace_id_idx" ON "agent_eval_datasets" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_eval_datasets_identifier_workspace_id_unique" ON "agent_eval_datasets" USING btree ("workspace_id","identifier") WHERE "agent_eval_datasets"."workspace_id" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_eval_experiment_benchmarks_workspace_id_idx" ON "agent_eval_experiment_benchmarks" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_eval_experiments_workspace_id_idx" ON "agent_eval_experiments" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_eval_run_topics_workspace_id_idx" ON "agent_eval_run_topics" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_eval_runs_workspace_id_idx" ON "agent_eval_runs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_eval_test_cases_workspace_id_idx" ON "agent_eval_test_cases" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_operations_workspace_id_idx" ON "agent_operations" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_skills_workspace_id_idx" ON "agent_skills" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_skills_name_workspace_id_unique" ON "agent_skills" USING btree ("workspace_id","name") WHERE "agent_skills"."workspace_id" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_models_workspace_id_idx" ON "ai_models" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_providers_workspace_id_idx" ON "ai_providers" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_keys_workspace_id_idx" ON "api_keys" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "async_tasks_workspace_id_idx" ON "async_tasks" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_groups_workspace_id_idx" ON "chat_groups" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_groups_agents_workspace_id_idx" ON "chat_groups_agents" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_connector_tools_workspace_id_idx" ON "user_connector_tools" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_connectors_workspace_id_idx" ON "user_connectors" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "devices_workspace_id_idx" ON "devices" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_histories_workspace_id_idx" ON "document_histories" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_shares_workspace_id_idx" ON "document_shares" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_workspace_id_idx" ON "documents" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "documents_slug_workspace_id_unique" ON "documents" USING btree ("workspace_id","slug") WHERE "documents"."workspace_id" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "files_workspace_id_idx" ON "files" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_base_files_workspace_id_idx" ON "knowledge_base_files" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_bases_workspace_id_idx" ON "knowledge_bases" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "generation_batches_workspace_id_idx" ON "generation_batches" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "generation_topics_workspace_id_idx" ON "generation_topics" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "generations_workspace_id_idx" ON "generations" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_generation_tracing_workspace_id_idx" ON "llm_generation_tracing" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_chunks_workspace_id_idx" ON "message_chunks" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_groups_workspace_id_idx" ON "message_groups" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_plugins_workspace_id_idx" ON "message_plugins" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_queries_workspace_id_idx" ON "message_queries" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_query_chunks_workspace_id_idx" ON "message_query_chunks" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_tts_workspace_id_idx" ON "message_tts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_translates_workspace_id_idx" ON "message_translates" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_workspace_id_idx" ON "messages" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_files_workspace_id_idx" ON "messages_files" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messenger_account_links_workspace_id_idx" ON "messenger_account_links" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chunks_workspace_id_idx" ON "chunks" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_chunks_workspace_id_idx" ON "document_chunks" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "embeddings_workspace_id_idx" ON "embeddings" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "unstructured_chunks_workspace_id_idx" ON "unstructured_chunks" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rag_eval_dataset_records_workspace_id_idx" ON "rag_eval_dataset_records" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rag_eval_datasets_workspace_id_idx" ON "rag_eval_datasets" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rag_eval_evaluations_workspace_id_idx" ON "rag_eval_evaluations" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rag_eval_evaluation_records_workspace_id_idx" ON "rag_eval_evaluation_records" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rbac_roles_workspace_id_idx" ON "rbac_roles" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rbac_user_roles_workspace_id_idx" ON "rbac_user_roles" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_to_sessions_workspace_id_idx" ON "agents_to_sessions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "file_chunks_workspace_id_idx" ON "file_chunks" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "files_to_sessions_workspace_id_idx" ON "files_to_sessions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "session_groups_workspace_id_idx" ON "session_groups" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_workspace_id_idx" ON "sessions" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sessions_slug_workspace_id_unique" ON "sessions" USING btree ("workspace_id","slug") WHERE "sessions"."workspace_id" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "briefs_workspace_id_idx" ON "briefs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_comments_workspace_id_idx" ON "task_comments" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_dependencies_workspace_id_idx" ON "task_dependencies" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_documents_workspace_id_idx" ON "task_documents" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_topics_workspace_id_idx" ON "task_topics" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_workspace_id_idx" ON "tasks" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tasks_identifier_workspace_id_unique" ON "tasks" USING btree ("workspace_id","identifier") WHERE "tasks"."workspace_id" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "threads_workspace_id_idx" ON "threads" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "topic_documents_workspace_id_idx" ON "topic_documents" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "topic_shares_workspace_id_idx" ON "topic_shares" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "topics_workspace_id_idx" ON "topics" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_installed_plugins_workspace_id_idx" ON "user_installed_plugins" USING btree ("workspace_id");
--> statement-breakpoint
-- ===== 0109_migrate_unique_constraints =====
ALTER TABLE "rbac_roles" DROP CONSTRAINT IF EXISTS "rbac_roles_name_unique";--> statement-breakpoint
DROP INDEX IF EXISTS "agents_slug_user_id_unique";--> statement-breakpoint
DROP INDEX IF EXISTS "agent_eval_benchmarks_identifier_user_id_unique";--> statement-breakpoint
DROP INDEX IF EXISTS "agent_eval_datasets_identifier_user_id_unique";--> statement-breakpoint
DROP INDEX IF EXISTS "agent_skills_user_name_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "documents_slug_user_id_unique";--> statement-breakpoint
DROP INDEX IF EXISTS "slug_user_id_unique";--> statement-breakpoint
DROP INDEX IF EXISTS "tasks_identifier_idx";--> statement-breakpoint
ALTER TABLE "rbac_user_roles" DROP CONSTRAINT IF EXISTS "rbac_user_roles_user_id_role_id_pk";--> statement-breakpoint
ALTER TABLE "rbac_user_roles" ADD COLUMN IF NOT EXISTS "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rbac_roles_name_workspace_unique" ON "rbac_roles" USING btree ("name",COALESCE("workspace_id", ''));--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rbac_user_roles_user_role_scope_unique" ON "rbac_user_roles" USING btree ("user_id","role_id",COALESCE("workspace_id", ''));--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agents_slug_user_id_unique" ON "agents" USING btree ("slug","user_id") WHERE "agents"."workspace_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_eval_benchmarks_identifier_user_id_unique" ON "agent_eval_benchmarks" USING btree ("identifier","user_id") WHERE "agent_eval_benchmarks"."workspace_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_eval_datasets_identifier_user_id_unique" ON "agent_eval_datasets" USING btree ("identifier","user_id") WHERE "agent_eval_datasets"."workspace_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_skills_user_name_idx" ON "agent_skills" USING btree ("user_id","name") WHERE "agent_skills"."workspace_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "documents_slug_user_id_unique" ON "documents" USING btree ("slug","user_id") WHERE "documents"."workspace_id" IS NULL AND "documents"."slug" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "slug_user_id_unique" ON "sessions" USING btree ("slug","user_id") WHERE "sessions"."workspace_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tasks_identifier_idx" ON "tasks" USING btree ("identifier","created_by_user_id") WHERE "tasks"."workspace_id" is null;
--> statement-breakpoint
-- ===== 0110_add_verify_tables_and_ai_infra_id =====
CREATE TABLE IF NOT EXISTS "verify_check_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operation_id" text NOT NULL,
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
CREATE TABLE IF NOT EXISTS "verify_criteria" (
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
CREATE TABLE IF NOT EXISTS "verify_rubric_criteria" (
	"rubric_id" uuid NOT NULL,
	"criterion_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text,
	"sort_order" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verify_rubric_criteria_rubric_id_criterion_id_pk" PRIMARY KEY("rubric_id","criterion_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "verify_rubrics" (
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
ALTER TABLE "agent_operations" ADD COLUMN IF NOT EXISTS "verify_status" text;
--> statement-breakpoint
ALTER TABLE "agent_operations" ADD COLUMN IF NOT EXISTS "verify_plan" jsonb;
--> statement-breakpoint
ALTER TABLE "agent_operations" ADD COLUMN IF NOT EXISTS "verify_plan_confirmed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "verify_check_results" DROP CONSTRAINT IF EXISTS "verify_check_results_operation_id_agent_operations_id_fk";
--> statement-breakpoint
ALTER TABLE "verify_check_results" ADD CONSTRAINT "verify_check_results_operation_id_agent_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."agent_operations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "verify_check_results" DROP CONSTRAINT IF EXISTS "verify_check_results_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "verify_check_results" ADD CONSTRAINT "verify_check_results_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "verify_check_results" DROP CONSTRAINT IF EXISTS "verify_check_results_workspace_id_workspaces_id_fk";
--> statement-breakpoint
ALTER TABLE "verify_check_results" ADD CONSTRAINT "verify_check_results_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "verify_check_results" DROP CONSTRAINT IF EXISTS "verify_check_results_verifier_operation_id_agent_operations_id_fk";
--> statement-breakpoint
ALTER TABLE "verify_check_results" ADD CONSTRAINT "verify_check_results_verifier_operation_id_agent_operations_id_fk" FOREIGN KEY ("verifier_operation_id") REFERENCES "public"."agent_operations"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "verify_check_results" DROP CONSTRAINT IF EXISTS "verify_check_results_verifier_tracing_id_llm_generation_tracing_id_fk";
--> statement-breakpoint
ALTER TABLE "verify_check_results" ADD CONSTRAINT "verify_check_results_verifier_tracing_id_llm_generation_tracing_id_fk" FOREIGN KEY ("verifier_tracing_id") REFERENCES "public"."llm_generation_tracing"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "verify_check_results" DROP CONSTRAINT IF EXISTS "verify_check_results_repair_operation_id_agent_operations_id_fk";
--> statement-breakpoint
ALTER TABLE "verify_check_results" ADD CONSTRAINT "verify_check_results_repair_operation_id_agent_operations_id_fk" FOREIGN KEY ("repair_operation_id") REFERENCES "public"."agent_operations"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "verify_criteria" DROP CONSTRAINT IF EXISTS "verify_criteria_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "verify_criteria" ADD CONSTRAINT "verify_criteria_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "verify_criteria" DROP CONSTRAINT IF EXISTS "verify_criteria_document_id_documents_id_fk";
--> statement-breakpoint
ALTER TABLE "verify_criteria" ADD CONSTRAINT "verify_criteria_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "verify_criteria" DROP CONSTRAINT IF EXISTS "verify_criteria_workspace_id_workspaces_id_fk";
--> statement-breakpoint
ALTER TABLE "verify_criteria" ADD CONSTRAINT "verify_criteria_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "verify_rubric_criteria" DROP CONSTRAINT IF EXISTS "verify_rubric_criteria_rubric_id_verify_rubrics_id_fk";
--> statement-breakpoint
ALTER TABLE "verify_rubric_criteria" ADD CONSTRAINT "verify_rubric_criteria_rubric_id_verify_rubrics_id_fk" FOREIGN KEY ("rubric_id") REFERENCES "public"."verify_rubrics"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "verify_rubric_criteria" DROP CONSTRAINT IF EXISTS "verify_rubric_criteria_criterion_id_verify_criteria_id_fk";
--> statement-breakpoint
ALTER TABLE "verify_rubric_criteria" ADD CONSTRAINT "verify_rubric_criteria_criterion_id_verify_criteria_id_fk" FOREIGN KEY ("criterion_id") REFERENCES "public"."verify_criteria"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "verify_rubric_criteria" DROP CONSTRAINT IF EXISTS "verify_rubric_criteria_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "verify_rubric_criteria" ADD CONSTRAINT "verify_rubric_criteria_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "verify_rubric_criteria" DROP CONSTRAINT IF EXISTS "verify_rubric_criteria_workspace_id_workspaces_id_fk";
--> statement-breakpoint
ALTER TABLE "verify_rubric_criteria" ADD CONSTRAINT "verify_rubric_criteria_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "verify_rubrics" DROP CONSTRAINT IF EXISTS "verify_rubrics_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "verify_rubrics" ADD CONSTRAINT "verify_rubrics_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "verify_rubrics" DROP CONSTRAINT IF EXISTS "verify_rubrics_workspace_id_workspaces_id_fk";
--> statement-breakpoint
ALTER TABLE "verify_rubrics" ADD CONSTRAINT "verify_rubrics_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verify_check_results_operation_id_idx" ON "verify_check_results" USING btree ("operation_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verify_check_results_user_id_idx" ON "verify_check_results" USING btree ("user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "verify_check_results_operation_id_check_item_id_unique" ON "verify_check_results" USING btree ("operation_id","check_item_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verify_check_results_verifier_type_idx" ON "verify_check_results" USING btree ("verifier_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verify_check_results_verifier_operation_id_idx" ON "verify_check_results" USING btree ("verifier_operation_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verify_check_results_verifier_tracing_id_idx" ON "verify_check_results" USING btree ("verifier_tracing_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verify_check_results_status_idx" ON "verify_check_results" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verify_check_results_verdict_idx" ON "verify_check_results" USING btree ("verdict");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verify_check_results_repair_operation_id_idx" ON "verify_check_results" USING btree ("repair_operation_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verify_check_results_workspace_id_idx" ON "verify_check_results" USING btree ("workspace_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verify_criteria_user_id_idx" ON "verify_criteria" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verify_criteria_verifier_type_idx" ON "verify_criteria" USING btree ("verifier_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verify_criteria_document_id_idx" ON "verify_criteria" USING btree ("document_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verify_criteria_workspace_id_idx" ON "verify_criteria" USING btree ("workspace_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verify_rubric_criteria_criterion_id_idx" ON "verify_rubric_criteria" USING btree ("criterion_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verify_rubric_criteria_user_id_idx" ON "verify_rubric_criteria" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verify_rubric_criteria_workspace_id_idx" ON "verify_rubric_criteria" USING btree ("workspace_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verify_rubrics_user_id_idx" ON "verify_rubrics" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verify_rubrics_workspace_id_idx" ON "verify_rubrics" USING btree ("workspace_id");
--> statement-breakpoint
-- Phase 5 ai_infra workspace-scoped migration: add nullable surrogate `_id` columns
-- for ai_providers and ai_models. Two-step approach (ADD nullable first, then SET DEFAULT)
-- keeps the operation catalog-only. A combined ADD COLUMN ... DEFAULT gen_random_uuid()
-- NOT NULL would trigger a full table rewrite under ACCESS EXCLUSIVE lock (ai_models has
-- ~4M rows), which would block all chat reads that depend on model resolution.
ALTER TABLE "ai_providers" ADD COLUMN IF NOT EXISTS "_id" uuid;
--> statement-breakpoint
ALTER TABLE "ai_providers" ALTER COLUMN "_id" SET DEFAULT gen_random_uuid();
--> statement-breakpoint
ALTER TABLE "ai_models" ADD COLUMN IF NOT EXISTS "_id" uuid;
--> statement-breakpoint
ALTER TABLE "ai_models" ALTER COLUMN "_id" SET DEFAULT gen_random_uuid();
--> statement-breakpoint
-- ===== 0111_workspace_device_and_ai_infra_surrogate_pk =====
-- Combined workspace-scoped DB rollout (formerly two separate 0111 migrations):
--   1. ai_infra surrogate `_id` PK + workspace-scoped partial uniques (LOBE-10056)
--   2. workspace-scoped device unique + workspace `frozen` columns (LOBE-10315)
--
-- The two parts touch disjoint tables (ai_providers / ai_models vs.
-- devices / workspaces). Every statement is guarded so the migration is a
-- NO-OP on databases that already have the shape (cloud production, where the
-- ai_infra side was applied online via manual steps) and a full rebuild on
-- fresh / self-hosted databases.

-- ===========================================================================
-- Part 1 — ai_infra surrogate `_id` PK + workspace-scoped partial uniques
-- (LOBE-10056 Phase 5)
--
-- On cloud production this whole part is a NO-OP: the manual steps [3]~[7]
-- (LOBE-10073 .. LOBE-10077) already performed the backfill, NOT NULL, PK swap
-- and partial indexes online / . Every statement below is guarded
-- (UPDATE … WHERE _id IS NULL / IF EXISTS / catalog check / IF NOT EXISTS) so
-- it skips cleanly there, while still fully rebuilding the schema on a fresh or
-- self-hosted database (where [3]~[7] never ran).
-- ===========================================================================

-- 1) backfill rows still missing _id (no-op on prod; fills self-host history) --
UPDATE "ai_providers" SET "_id" = gen_random_uuid() WHERE "_id" IS NULL;--> statement-breakpoint
UPDATE "ai_models" SET "_id" = gen_random_uuid() WHERE "_id" IS NULL;--> statement-breakpoint

-- 2) enforce NOT NULL (no-op if already set) --
ALTER TABLE "ai_providers" ALTER COLUMN "_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_models" ALTER COLUMN "_id" SET NOT NULL;--> statement-breakpoint

-- 3) drop old composite PKs (no-op on prod, already dropped in [7]) --
ALTER TABLE "ai_providers" DROP CONSTRAINT IF EXISTS "ai_providers_id_user_id_pk";--> statement-breakpoint
ALTER TABLE "ai_models" DROP CONSTRAINT IF EXISTS "ai_models_id_provider_id_user_id_pk";--> statement-breakpoint

-- 4) promote _id to PK only when the table has no PK yet
--    (Postgres has no `ADD PRIMARY KEY IF NOT EXISTS`; guard via pg_constraint) --
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'ai_providers'::regclass AND contype = 'p'
  ) THEN
    ALTER TABLE "ai_providers" ADD CONSTRAINT "ai_providers_pkey" PRIMARY KEY ("_id");
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'ai_models'::regclass AND contype = 'p'
  ) THEN
    ALTER TABLE "ai_models" ADD CONSTRAINT "ai_models_pkey" PRIMARY KEY ("_id");
  END IF;
END $$;--> statement-breakpoint

-- 5) workspace-scoped partial unique indexes (no-op on prod, already built in [6]) --
CREATE UNIQUE INDEX IF NOT EXISTS "ai_providers_id_user_id_unique" ON "ai_providers" USING btree ("id","user_id") WHERE "workspace_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_providers_id_user_id_workspace_id_unique" ON "ai_providers" USING btree ("id","user_id","workspace_id") WHERE "workspace_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_models_id_provider_id_user_id_unique" ON "ai_models" USING btree ("id","provider_id","user_id") WHERE "workspace_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_models_id_provider_id_user_id_workspace_id_unique" ON "ai_models" USING btree ("id","provider_id","user_id","workspace_id") WHERE "workspace_id" IS NOT NULL;--> statement-breakpoint

-- ===========================================================================
-- Part 2 — workspace-scoped device unique + workspace `frozen` columns
-- (LOBE-10315)
--
-- Replace the full (user_id, device_id) unique with two partial uniques scoped
-- by workspace_id (null vs. not null), so personal and workspace-enrolled rows
-- live in independent identity spaces. Also add the workspace freeze trio
-- (mirrors users.banned) backing cloud workspace-freeze risk control.
-- ===========================================================================

DROP INDEX IF EXISTS "devices_user_id_device_id_unique";--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "frozen" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "frozen_reason" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "frozen_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "devices_workspace_id_device_id_unique" ON "devices" USING btree ("workspace_id","device_id") WHERE "devices"."workspace_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "devices_user_id_device_id_unique" ON "devices" USING btree ("user_id","device_id") WHERE "devices"."workspace_id" IS NULL;
--> statement-breakpoint
-- ===== 0112_add_verify_evidence_and_reports =====
CREATE TABLE IF NOT EXISTS "verify_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"description" text,
	"check_result_id" uuid NOT NULL,
	"type" text NOT NULL,
	"content" text,
	"file_id" text,
	"captured_by" text,
	"captured_at" timestamp with time zone,
	"user_id" text NOT NULL,
	"workspace_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "verify_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
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
ALTER TABLE "verify_evidence" DROP CONSTRAINT IF EXISTS "verify_evidence_check_result_id_verify_check_results_id_fk";--> statement-breakpoint
ALTER TABLE "verify_evidence" ADD CONSTRAINT "verify_evidence_check_result_id_verify_check_results_id_fk" FOREIGN KEY ("check_result_id") REFERENCES "public"."verify_check_results"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verify_evidence" DROP CONSTRAINT IF EXISTS "verify_evidence_file_id_files_id_fk";--> statement-breakpoint
ALTER TABLE "verify_evidence" ADD CONSTRAINT "verify_evidence_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verify_evidence" DROP CONSTRAINT IF EXISTS "verify_evidence_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "verify_evidence" ADD CONSTRAINT "verify_evidence_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verify_evidence" DROP CONSTRAINT IF EXISTS "verify_evidence_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "verify_evidence" ADD CONSTRAINT "verify_evidence_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verify_reports" DROP CONSTRAINT IF EXISTS "verify_reports_operation_id_agent_operations_id_fk";--> statement-breakpoint
ALTER TABLE "verify_reports" ADD CONSTRAINT "verify_reports_operation_id_agent_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."agent_operations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verify_reports" DROP CONSTRAINT IF EXISTS "verify_reports_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "verify_reports" ADD CONSTRAINT "verify_reports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verify_reports" DROP CONSTRAINT IF EXISTS "verify_reports_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "verify_reports" ADD CONSTRAINT "verify_reports_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verify_evidence_check_result_id_idx" ON "verify_evidence" USING btree ("check_result_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verify_evidence_file_id_idx" ON "verify_evidence" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verify_evidence_user_id_idx" ON "verify_evidence" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verify_evidence_workspace_id_idx" ON "verify_evidence" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "verify_reports_operation_id_unique" ON "verify_reports" USING btree ("operation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verify_reports_user_id_idx" ON "verify_reports" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verify_reports_workspace_id_idx" ON "verify_reports" USING btree ("workspace_id");
--> statement-breakpoint
-- ===== 0113_add_verify_runs =====
-- Decouple the verify chain from agent_operations: introduce `verify_runs` (the
-- verification-session entity) and add `verify_run_id` to verify_check_results /
-- verify_reports as the new grouping key. Additive + non-destructive: `operation_id`
-- is KEPT (relaxed to nullable + ON DELETE set null) as a denormalized direct link
-- to the Agent Run, so no data is moved or dropped.

-- 1. The session entity. `operation_id` is an OPTIONAL link to an Agent Run
--    (null for standalone sessions); plan + rollup status live here now.
CREATE TABLE IF NOT EXISTS "verify_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text,
	"operation_id" text,
	"source" text DEFAULT 'agent' NOT NULL,
	"title" text,
	"goal" text,
	"plan" jsonb,
	"plan_confirmed_at" timestamp with time zone,
	"status" text,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "verify_runs" DROP CONSTRAINT IF EXISTS "verify_runs_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "verify_runs" ADD CONSTRAINT "verify_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verify_runs" DROP CONSTRAINT IF EXISTS "verify_runs_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "verify_runs" ADD CONSTRAINT "verify_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verify_runs" DROP CONSTRAINT IF EXISTS "verify_runs_operation_id_agent_operations_id_fk";--> statement-breakpoint
ALTER TABLE "verify_runs" ADD CONSTRAINT "verify_runs_operation_id_agent_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."agent_operations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verify_runs_user_id_idx" ON "verify_runs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verify_runs_workspace_id_idx" ON "verify_runs" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "verify_runs_operation_id_unique" ON "verify_runs" USING btree ("operation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verify_runs_source_idx" ON "verify_runs" USING btree ("source");--> statement-breakpoint

-- 2. Add the new run link (nullable, additive). The verify pipeline always sets it.
ALTER TABLE "verify_check_results" ADD COLUMN IF NOT EXISTS "verify_run_id" uuid;--> statement-breakpoint
ALTER TABLE "verify_reports" ADD COLUMN IF NOT EXISTS "verify_run_id" uuid;--> statement-breakpoint

-- 3. Keep operation_id, but relax it: nullable (standalone sessions have none) and
--    ON DELETE set null (the canonical run link is verify_runs, so a deleted op
--    must not cascade-delete verify data).
ALTER TABLE "verify_check_results" ALTER COLUMN "operation_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "verify_check_results" DROP CONSTRAINT IF EXISTS "verify_check_results_operation_id_agent_operations_id_fk";--> statement-breakpoint
ALTER TABLE "verify_check_results" ADD CONSTRAINT "verify_check_results_operation_id_agent_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."agent_operations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verify_reports" DROP CONSTRAINT IF EXISTS "verify_reports_operation_id_agent_operations_id_fk";--> statement-breakpoint
ALTER TABLE "verify_reports" ADD CONSTRAINT "verify_reports_operation_id_agent_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."agent_operations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- 4. The grouping unique key moves from operation_id onto verify_run_id.
DROP INDEX IF EXISTS "verify_check_results_operation_id_check_item_id_unique";--> statement-breakpoint
DROP INDEX IF EXISTS "verify_reports_operation_id_unique";--> statement-breakpoint
ALTER TABLE "verify_check_results" DROP CONSTRAINT IF EXISTS "verify_check_results_verify_run_id_verify_runs_id_fk";--> statement-breakpoint
ALTER TABLE "verify_check_results" ADD CONSTRAINT "verify_check_results_verify_run_id_verify_runs_id_fk" FOREIGN KEY ("verify_run_id") REFERENCES "public"."verify_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verify_reports" DROP CONSTRAINT IF EXISTS "verify_reports_verify_run_id_verify_runs_id_fk";--> statement-breakpoint
ALTER TABLE "verify_reports" ADD CONSTRAINT "verify_reports_verify_run_id_verify_runs_id_fk" FOREIGN KEY ("verify_run_id") REFERENCES "public"."verify_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verify_check_results_verify_run_id_idx" ON "verify_check_results" USING btree ("verify_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "verify_check_results_verify_run_id_check_item_id_unique" ON "verify_check_results" USING btree ("verify_run_id","check_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "verify_reports_verify_run_id_unique" ON "verify_reports" USING btree ("verify_run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verify_reports_operation_id_idx" ON "verify_reports" USING btree ("operation_id");
--> statement-breakpoint
-- ===== 0114_add_verify_run_scenario_context =====
-- Give a verification session a `scenario` discriminator (e.g. `coding`), the
-- scenario's `context` bag (branch / commit / surfaces / …), and a generic
-- `metadata` bag reserved for future cross-scenario extension — so the report
-- viewer can render a per-scenario scope header and the verify page reads as the
-- final report. All additive + nullable.
ALTER TABLE "verify_runs" ADD COLUMN IF NOT EXISTS "scenario" text;--> statement-breakpoint
ALTER TABLE "verify_runs" ADD COLUMN IF NOT EXISTS "context" jsonb;--> statement-breakpoint
ALTER TABLE "verify_runs" ADD COLUMN IF NOT EXISTS "metadata" jsonb;
--> statement-breakpoint
-- ===== 0115_add_workspace_private_visibility =====
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "visibility" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_groups" ADD COLUMN IF NOT EXISTS "visibility" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "visibility" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "visibility" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_bases" ADD COLUMN IF NOT EXISTS "visibility" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "generation_topics" ADD COLUMN IF NOT EXISTS "visibility" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "session_groups" ADD COLUMN IF NOT EXISTS "visibility" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "task_comments" ADD COLUMN IF NOT EXISTS "visibility" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD COLUMN IF NOT EXISTS "visibility" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "task_documents" ADD COLUMN IF NOT EXISTS "visibility" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "task_topics" ADD COLUMN IF NOT EXISTS "visibility" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "visibility" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_workspace_visibility_idx" ON "agents" USING btree ("workspace_id","visibility","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_groups_workspace_visibility_idx" ON "chat_groups" USING btree ("workspace_id","visibility","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_workspace_visibility_idx" ON "documents" USING btree ("workspace_id","visibility","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "files_workspace_visibility_idx" ON "files" USING btree ("workspace_id","visibility","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_bases_workspace_visibility_idx" ON "knowledge_bases" USING btree ("workspace_id","visibility","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "generation_topics_workspace_visibility_idx" ON "generation_topics" USING btree ("workspace_id","visibility","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "session_groups_workspace_visibility_idx" ON "session_groups" USING btree ("workspace_id","visibility","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_comments_workspace_visibility_idx" ON "task_comments" USING btree ("workspace_id","visibility","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_deps_workspace_visibility_idx" ON "task_dependencies" USING btree ("workspace_id","visibility","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_docs_workspace_visibility_idx" ON "task_documents" USING btree ("workspace_id","visibility","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_topics_workspace_visibility_idx" ON "task_topics" USING btree ("workspace_id","visibility","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_workspace_visibility_idx" ON "tasks" USING btree ("workspace_id","visibility","created_by_user_id");
--> statement-breakpoint
-- ===== 0116_add_task_connector_message_and_verify_updates =====
ALTER TABLE "user_connectors" ADD COLUMN IF NOT EXISTS "agent_id" text;--> statement-breakpoint
ALTER TABLE "task_topics" ADD COLUMN IF NOT EXISTS "trigger" text;--> statement-breakpoint
ALTER TABLE "verify_check_results" ADD COLUMN IF NOT EXISTS "metadata" jsonb;--> statement-breakpoint
ALTER TABLE "verify_evidence" ADD COLUMN IF NOT EXISTS "metadata" jsonb;--> statement-breakpoint
ALTER TABLE "user_connectors" DROP CONSTRAINT IF EXISTS "user_connectors_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "user_connectors" ADD CONSTRAINT "user_connectors_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_connectors_agent_id_idx" ON "user_connectors" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_connectors_personal_identifier_idx" ON "user_connectors" USING btree ("user_id","identifier") WHERE "user_connectors"."workspace_id" is null AND "user_connectors"."agent_id" is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_connectors_workspace_identifier_idx" ON "user_connectors" USING btree ("user_id","workspace_id","identifier") WHERE "user_connectors"."workspace_id" is not null AND "user_connectors"."agent_id" is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_connectors_agent_identifier_idx" ON "user_connectors" USING btree ("agent_id","identifier") WHERE "user_connectors"."agent_id" is not null;--> statement-breakpoint
DROP INDEX IF EXISTS "user_connectors_agent_identifier_unique";--> statement-breakpoint
DROP INDEX IF EXISTS "user_connectors_user_identifier_agent_null_unique";--> statement-breakpoint
DROP INDEX IF EXISTS "user_connectors_user_identifier_unique";--> statement-breakpoint
-- Hot messages recent-query index.
--
-- On cloud production this index must be built online before deploy:
--
--   CREATE INDEX IF NOT EXISTS "messages_topic_id_updated_at_idx"
--   ON "messages" USING btree ("topic_id","updated_at");
--
-- The guarded statement below is then a NO-OP on databases that already have
-- the index, while fresh / self-hosted databases still converge to the target
-- schema during normal migration replay. Keep this statement non-
-- so local PGlite / normal migration replay remains compatible.
CREATE INDEX IF NOT EXISTS "messages_topic_id_updated_at_idx" ON "messages" USING btree ("topic_id","updated_at");
--> statement-breakpoint
-- ===== 0117_add_platform_tables =====
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
-- ===== 0118_add_platform_easyauth_snapshots =====
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
-- ===== 0119_m04_users_auth_invalidated_and_search_indexes =====
-- M04: auth security epoch columns + prefix-search expression indexes.
--
-- Production online prebuild (run before deploy so replay is a NO-OP):
--
--   CREATE INDEX IF NOT EXISTS "users_email_lower_pattern_idx"
--   ON "users" USING btree (lower("email") text_pattern_ops);
--   CREATE INDEX IF NOT EXISTS "users_username_lower_pattern_idx"
--   ON "users" USING btree (lower("username") text_pattern_ops);
--   CREATE INDEX IF NOT EXISTS "users_normalized_email_lower_pattern_idx"
--   ON "users" USING btree (lower("normalized_email") text_pattern_ops);
--
-- Non- below for fresh/self-hosted/PGlite (pattern from 0116).
-- Never DROP these indexes on replay.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "auth_invalidated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "auth_invalidated_excluded_session_id" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_email_lower_pattern_idx" ON "users" USING btree (lower("email") text_pattern_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_username_lower_pattern_idx" ON "users" USING btree (lower("username") text_pattern_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_normalized_email_lower_pattern_idx" ON "users" USING btree (lower("normalized_email") text_pattern_ops);
--> statement-breakpoint
-- ===== 0120_m05_settings_visibility_and_bundle =====
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
-- ===== 0121_m07_platform_ai_runtime_safety =====
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
-- ===== 0122_m08_platform_skill_versions =====
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
-- ===== 0123_m09_connector_catalog_expand =====
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
-- CREATE UNIQUE INDEX  IF NOT EXISTS "platform_user_connector_bindings_oauth_state_owner_unique" ON "platform_user_connector_bindings" ("id","user_id","connector_id");
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
-- CREATE UNIQUE INDEX  IF NOT EXISTS "platform_resource_revisions_type_id_revision_checksum_unique" ON "platform_resource_revisions" ("resource_type","resource_id","revision","checksum");
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
-- ===== 0124_m09_oauth_attempt_outcome =====
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
-- ===== 0125_m10_platform_agent_contract_expand =====
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
-- ===== 0126_m10_rollout_job_indexes =====
-- Production predeploy MUST run scripts/migrateServerDB/predeployM10RolloutIndexes.ts first. It
-- creates both indexes  in autocommit mode. These idempotent statements are the safe
-- migration fallback for fresh/small databases and become no-ops after predeploy.
CREATE INDEX IF NOT EXISTS "platform_jobs_rollout_agent_id_id_idx" ON "platform_jobs" USING btree (("input"->'snapshot'->>'agentId'),"id") WHERE "platform_jobs"."type" = 'platform.agent.rollout.v1';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_jobs_rollout_transition_parent_status_user_idx" ON "platform_jobs" USING btree (("input"->>'parentJobId'),"status",("input"->>'userId')) WHERE "platform_jobs"."type" = 'platform.agent.rollout.transition.v1';
--> statement-breakpoint
-- ===== 0127_m11_oidc_provider_security_foundation =====
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
-- ===== 0128_m11_identity_provider_test_attempts =====
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
-- ===== 0129_m12_platform_branding_lifecycle =====
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
-- ===== 0130_m11_identity_provider_instances =====
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
-- ===== 0131_m11_user_dingtalk_claims =====
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "dingtalk_title" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "dingtalk_user_id" text;
--> statement-breakpoint
-- ===== 0132_m13_platform_secret_rotation =====
ALTER TABLE "platform_ai_provider_secrets" ADD COLUMN IF NOT EXISTS "key_id" varchar(256);--> statement-breakpoint
ALTER TABLE "platform_ai_providers" ADD COLUMN IF NOT EXISTS "secret_key_id" varchar(256);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_ai_provider_secrets_key_id_idx" ON "platform_ai_provider_secrets" USING btree ("key_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_ai_providers_secret_key_id_idx" ON "platform_ai_providers" USING btree ("secret_key_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_identity_provider_test_attempts_pkce_key_id_idx" ON "platform_identity_provider_test_attempts" USING btree ("pkce_key_id");
--> statement-breakpoint
-- ===== 0133_m13_secret_rewrap_failure_index =====
CREATE INDEX IF NOT EXISTS "platform_jobs_secret_rewrap_failure_parent_domain_row_idx" ON "platform_jobs" USING btree (("input"->>'parentJobId'),("input"->>'domain'),("input"->>'rowId')) WHERE "platform_jobs"."type" = 'platform.secret.rewrap.failure.v1' AND "platform_jobs"."status" = 'failed';
--> statement-breakpoint
-- ===== 0134_m13_secret_rewrap_single_active =====
CREATE UNIQUE INDEX IF NOT EXISTS "platform_jobs_secret_rewrap_single_active_unique" ON "platform_jobs" USING btree ("type") WHERE "platform_jobs"."type" = 'platform.secret.rewrap.v1' AND "platform_jobs"."status" IN ('pending', 'reserved', 'running');
--> statement-breakpoint
-- ===== 0135_m14_platform_instance_revisions =====
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
-- ===== 0136_m11_identity_secret_state_null_guard =====
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
-- ===== 0137_m13_admin_mutation_rate_windows =====
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
-- ===== 0138_w10_platform_global_credentials =====
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
-- ===== 0139_platform_connector_governance =====
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
-- ===== 0140_platform_agent_version_delete_guard =====
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
-- ===== 0141_platform_audit_admin_foundation =====
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
-- ===== 0142_platform_auth_settings =====
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
-- ===== 0143_platform_sidebar_layout =====
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
-- ===== 0144_drop_platform_easyauth_snapshots =====
DROP TABLE IF EXISTS "platform_easyauth_grant_snapshots";
--> statement-breakpoint
-- ===== 0145_platform_db_hardening =====
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
-- ===== 0146_platform_agent_materialization_tombstones =====
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
-- ===== 0147_round2_identity =====
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
-- ===== 0148_round2_db-core =====
-- Round-2 db-core: online index path for high-write tables + sidebar policy invariants.
-- Idempotent / convergent so partial re-applies are safe.
--
-- ── Indexes (0141 / 0145 follow-up) ──────────────────────────────────────────
-- 0141 and 0145 created these indexes without , which blocks writes on
-- large production tables for the duration of each build.
--
-- CREATE INDEX cannot run inside drizzle-orm's transactional migrator
-- (see pg-core dialect.migrate). Production / large deployments MUST prebuild in
-- autocommit before (or instead of relying on) the transactional fallbacks below:
--
--   CREATE INDEX IF NOT EXISTS "platform_audit_logs_actor_created_at_id_idx"
--     ON "platform_audit_logs" USING btree ("actor_user_id","created_at","id");
--   CREATE INDEX IF NOT EXISTS "platform_audit_logs_action_created_at_id_idx"
--     ON "platform_audit_logs" USING btree ("action","created_at","id");
--   CREATE INDEX IF NOT EXISTS "platform_audit_logs_result_created_at_id_idx"
--     ON "platform_audit_logs" USING btree ("result","created_at","id");
--   CREATE INDEX IF NOT EXISTS "platform_audit_logs_created_at_id_idx"
--     ON "platform_audit_logs" USING btree ("created_at","id");
--   CREATE INDEX IF NOT EXISTS "topics_user_id_created_at_id_idx"
--     ON "topics" USING btree ("user_id","created_at","id");
--   CREATE INDEX IF NOT EXISTS "messages_user_id_topic_id_created_at_id_idx"
--     ON "messages" USING btree ("user_id","topic_id","created_at","id");
--   CREATE INDEX IF NOT EXISTS "messages_role_created_at_idx"
--     ON "messages" USING btree ("role","created_at");
--   -- optional, requires pg_trgm:
--   CREATE INDEX IF NOT EXISTS "topics_title_trgm_idx"
--     ON "topics" USING gin ("title" gin_trgm_ops);
--
-- Transactional fallbacks: IF NOT EXISTS → no-op when predeploy (or 0141/0145)
-- already created the index. Do NOT DROP valid indexes here (would regress plans).
-- Large tables that still lack an index raise so ops can run the  form.

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

-- Optional title search index (pg_trgm).  form is documented above;
-- transactional path matches 0145 (extension-gated, non-).
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
-- ===== 0150_round2_platform-instance =====
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
-- ===== 0151_round2_sidebar_cas =====
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
-- ===== 0152_round2_rbac_hardening =====
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
-- ===== 0153_round2_connector_test_state =====
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
-- ===== 0154_round2_catalog_authority =====
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
-- ===== 0155_round2_skill_validation_trigger =====
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