CREATE TABLE IF NOT EXISTS "platform_instance_heartbeats" (
	"instance_id" varchar(64) PRIMARY KEY NOT NULL,
	"last_heartbeat_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"started_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
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
