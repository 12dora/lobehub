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
