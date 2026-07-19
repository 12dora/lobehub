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
