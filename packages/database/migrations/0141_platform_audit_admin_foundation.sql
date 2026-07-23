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