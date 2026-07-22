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