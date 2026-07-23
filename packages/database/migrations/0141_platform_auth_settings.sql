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
