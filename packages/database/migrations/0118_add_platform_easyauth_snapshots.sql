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
