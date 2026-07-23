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
