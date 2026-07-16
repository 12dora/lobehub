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
