-- 0137: Multi-instance administrative mutation rate windows (PostgreSQL sole authority).
-- scope_digest is a SHA-256 hex of actor+procedure; raw identifiers never persist.
CREATE TABLE IF NOT EXISTS "platform_admin_mutation_rate_windows" (
	"scope_digest" text PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_admin_mutation_rate_windows_window_start_idx" ON "platform_admin_mutation_rate_windows" USING btree ("window_start");
