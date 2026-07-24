-- Durable provenance for local Agents that were materializations of a hard-deleted platform Agent.
-- Live materialization rows cannot outlive their platform Agent (RESTRICT FKs), but surviving
-- local `agents` rows must stay excluded from ordinary lists and mutation guards.

CREATE TABLE IF NOT EXISTS "platform_user_agent_materialization_tombstones" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"materialized_agent_id" text NOT NULL,
	"former_platform_agent_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "platform_user_agent_materialization_tombstones" ADD CONSTRAINT "platform_user_agent_materialization_tombstones_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "platform_user_agent_materialization_tombstones" ADD CONSTRAINT "platform_user_agent_materialization_tombstones_materialized_agent_id_agents_id_fk" FOREIGN KEY ("materialized_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_user_agent_mat_tombstones_local_agent_unique" ON "platform_user_agent_materialization_tombstones" USING btree ("materialized_agent_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_user_agent_mat_tombstones_user_id_idx" ON "platform_user_agent_materialization_tombstones" USING btree ("user_id");
