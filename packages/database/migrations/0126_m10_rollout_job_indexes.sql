-- Production predeploy MUST run scripts/migrateServerDB/predeployM10RolloutIndexes.ts first. It
-- creates both indexes CONCURRENTLY in autocommit mode. These idempotent statements are the safe
-- migration fallback for fresh/small databases and become no-ops after predeploy.
CREATE INDEX IF NOT EXISTS "platform_jobs_rollout_agent_id_id_idx" ON "platform_jobs" USING btree (("input"->'snapshot'->>'agentId'),"id") WHERE "platform_jobs"."type" = 'platform.agent.rollout.v1';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_jobs_rollout_transition_parent_status_user_idx" ON "platform_jobs" USING btree (("input"->>'parentJobId'),"status",("input"->>'userId')) WHERE "platform_jobs"."type" = 'platform.agent.rollout.transition.v1';
