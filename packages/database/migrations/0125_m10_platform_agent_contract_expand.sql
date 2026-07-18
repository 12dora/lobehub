CREATE TABLE IF NOT EXISTS "platform_user_agent_materializations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"platform_agent_id" text NOT NULL,
	"platform_agent_version_id" text NOT NULL,
	"platform_agent_version_checksum" varchar(64) NOT NULL,
	"materialized_agent_id" text,
	"hidden" boolean DEFAULT false NOT NULL,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"last_error_category" varchar(64),
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_user_agent_materializations_checksum_check" CHECK ("platform_agent_version_checksum" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "platform_user_agent_materializations_status_check" CHECK ("status" IN ('pending', 'materialized', 'error')),
	CONSTRAINT "platform_user_agent_materializations_local_status_check" CHECK (("status" = 'materialized' AND "materialized_agent_id" IS NOT NULL) OR "status" <> 'materialized'),
	CONSTRAINT "platform_user_agent_materializations_error_category_value_check" CHECK ("last_error_category" IS NULL OR "last_error_category" IN ('local_agent_missing', 'materialization_failed', 'version_conflict')),
	CONSTRAINT "platform_user_agent_materializations_error_category_check" CHECK (("status" = 'error' AND "last_error_category" IS NOT NULL) OR ("status" <> 'error' AND "last_error_category" IS NULL))
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'platform_agents' AND column_name = 'migration_required'
  ) THEN
    -- Every pre-M10 row is retained, but cannot become effective until an administrator
    -- creates and validates an exact M10 version. This avoids silently activating loose M01 config.
    ALTER TABLE "platform_agents" ADD COLUMN "migration_required" boolean DEFAULT true NOT NULL;
    ALTER TABLE "platform_agents" ALTER COLUMN "migration_required" SET DEFAULT false;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "platform_agents" ADD COLUMN IF NOT EXISTS "current_version_id" text;
--> statement-breakpoint
ALTER TABLE "platform_agents" ADD COLUMN IF NOT EXISTS "draft_sequence" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "platform_agents" ADD COLUMN IF NOT EXISTS "published_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "platform_agent_versions" ADD COLUMN IF NOT EXISTS "dependency_snapshot" jsonb;
--> statement-breakpoint
ALTER TABLE "platform_agent_versions" ADD COLUMN IF NOT EXISTS "checksum" varchar(64);
--> statement-breakpoint
ALTER TABLE "platform_agent_assignments" ADD COLUMN IF NOT EXISTS "mode" varchar(32) DEFAULT 'optional' NOT NULL;
--> statement-breakpoint
ALTER TABLE "platform_agent_assignments" ADD COLUMN IF NOT EXISTS "version_policy" varchar(32) DEFAULT 'latest_published' NOT NULL;
--> statement-breakpoint
ALTER TABLE "platform_agent_assignments" ADD COLUMN IF NOT EXISTS "pinned_version_id" text;
--> statement-breakpoint
ALTER TABLE "platform_agent_assignments" ADD COLUMN IF NOT EXISTS "enabled" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
-- Preserve every legacy identity/config/version row. A legacy published shell without an exact
-- pointer is deliberately downgraded to Draft and marked migration_required rather than activated.
UPDATE "platform_agents" AS agent
SET "current_version_id" = version."id"
FROM "platform_agent_versions" AS version
WHERE agent."migration_required" = true
  AND agent."current_version_id" IS NULL
  AND agent."current_version" IS NOT NULL
  AND version."agent_id" = agent."id"
  AND version."version" = agent."current_version";
--> statement-breakpoint
UPDATE "platform_agents"
SET "status" = 'draft',
    "published_at" = NULL,
    "is_default" = COALESCE("system_key" = 'default-inbox', false)
WHERE "migration_required" = true;
--> statement-breakpoint
UPDATE "platform_agent_assignments" AS assignment
SET "mode" = agent."distribution"
FROM "platform_agents" AS agent
WHERE assignment."agent_id" = agent."id"
  AND agent."migration_required" = true
  AND agent."distribution" IN ('mandatory', 'default', 'optional');
--> statement-breakpoint
UPDATE "platform_agent_assignments"
SET "target_id" = '__global__'
WHERE "target_type" = 'global';
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "platform_agent_assignments" assignment
    LEFT JOIN "rbac_roles" role
      ON assignment."target_type" = 'global_role'
      AND role."id" = assignment."target_id"
      AND role."workspace_id" IS NULL
    LEFT JOIN "users" target_user
      ON assignment."target_type" = 'user'
      AND target_user."id" = assignment."target_id"
    WHERE (assignment."target_type" = 'global_role' AND role."id" IS NULL)
       OR (assignment."target_type" = 'user' AND target_user."id" IS NULL)
       OR assignment."target_type" NOT IN ('global', 'global_role', 'user')
  ) THEN
    RAISE EXCEPTION 'M10 cannot migrate invalid Agent assignment targets';
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_agent_versions_agent_id_id_unique" ON "platform_agent_versions" USING btree ("agent_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_agent_versions_agent_id_id_checksum_unique" ON "platform_agent_versions" USING btree ("agent_id","id","checksum");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_agents_current_version_id_idx" ON "platform_agents" USING btree ("current_version_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_user_agent_materializations_user_agent_unique" ON "platform_user_agent_materializations" USING btree ("user_id","platform_agent_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_user_agent_materializations_local_agent_unique" ON "platform_user_agent_materializations" USING btree ("materialized_agent_id") WHERE "materialized_agent_id" is not null;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_user_agent_materializations_user_id_idx" ON "platform_user_agent_materializations" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_user_agent_materializations_platform_agent_id_idx" ON "platform_user_agent_materializations" USING btree ("platform_agent_id");
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'platform_agent_assignments_pinned_version_same_agent_fk') THEN
    ALTER TABLE "platform_agent_assignments" ADD CONSTRAINT "platform_agent_assignments_pinned_version_same_agent_fk"
      FOREIGN KEY ("agent_id","pinned_version_id") REFERENCES "platform_agent_versions"("agent_id","id")
      ON DELETE restrict NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'platform_agents_current_version_same_agent_fk') THEN
    ALTER TABLE "platform_agents" ADD CONSTRAINT "platform_agents_current_version_same_agent_fk"
      FOREIGN KEY ("id","current_version_id") REFERENCES "platform_agent_versions"("agent_id","id")
      ON DELETE restrict NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "platform_agent_assignments" VALIDATE CONSTRAINT "platform_agent_assignments_pinned_version_same_agent_fk";
--> statement-breakpoint
ALTER TABLE "platform_agents" VALIDATE CONSTRAINT "platform_agents_current_version_same_agent_fk";
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'platform_agent_assignments_target_check') THEN
    ALTER TABLE "platform_agent_assignments" ADD CONSTRAINT "platform_agent_assignments_target_check"
      CHECK (("target_type" = 'global' AND "target_id" = '__global__') OR ("target_type" IN ('global_role', 'user') AND length("target_id") > 0 AND "target_id" <> '__global__')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'platform_agent_assignments_mode_check') THEN
    ALTER TABLE "platform_agent_assignments" ADD CONSTRAINT "platform_agent_assignments_mode_check"
      CHECK ("mode" IN ('mandatory', 'default', 'optional')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'platform_agent_assignments_version_policy_check') THEN
    ALTER TABLE "platform_agent_assignments" ADD CONSTRAINT "platform_agent_assignments_version_policy_check"
      CHECK (("version_policy" = 'latest_published' AND "pinned_version_id" IS NULL) OR ("version_policy" = 'pinned' AND "pinned_version_id" IS NOT NULL)) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'platform_agent_versions_checksum_check') THEN
    ALTER TABLE "platform_agent_versions" ADD CONSTRAINT "platform_agent_versions_checksum_check"
      CHECK ("checksum" ~ '^[a-f0-9]{64}$') NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'platform_agent_versions_exact_snapshot_pair_check') THEN
    ALTER TABLE "platform_agent_versions" ADD CONSTRAINT "platform_agent_versions_exact_snapshot_pair_check"
      CHECK (("checksum" IS NULL AND "dependency_snapshot" IS NULL) OR ("checksum" IS NOT NULL AND "dependency_snapshot" IS NOT NULL)) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'platform_agents_default_inbox_consistency_check') THEN
    ALTER TABLE "platform_agents" ADD CONSTRAINT "platform_agents_default_inbox_consistency_check"
      CHECK (("is_default" AND "system_key" = 'default-inbox') OR (NOT "is_default" AND "system_key" IS DISTINCT FROM 'default-inbox')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'platform_agents_published_pointer_check') THEN
    ALTER TABLE "platform_agents" ADD CONSTRAINT "platform_agents_published_pointer_check"
      CHECK ("status" <> 'published' OR (NOT "migration_required" AND "current_version_id" IS NOT NULL AND "published_at" IS NOT NULL)) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'platform_agents_revision_check') THEN
    ALTER TABLE "platform_agents" ADD CONSTRAINT "platform_agents_revision_check"
      CHECK ("revision" >= 0 AND "draft_sequence" >= 0) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "platform_agent_assignments" VALIDATE CONSTRAINT "platform_agent_assignments_target_check";
--> statement-breakpoint
ALTER TABLE "platform_agent_assignments" VALIDATE CONSTRAINT "platform_agent_assignments_mode_check";
--> statement-breakpoint
ALTER TABLE "platform_agent_assignments" VALIDATE CONSTRAINT "platform_agent_assignments_version_policy_check";
--> statement-breakpoint
ALTER TABLE "platform_agent_versions" VALIDATE CONSTRAINT "platform_agent_versions_checksum_check";
--> statement-breakpoint
ALTER TABLE "platform_agent_versions" VALIDATE CONSTRAINT "platform_agent_versions_exact_snapshot_pair_check";
--> statement-breakpoint
ALTER TABLE "platform_agents" VALIDATE CONSTRAINT "platform_agents_default_inbox_consistency_check";
--> statement-breakpoint
ALTER TABLE "platform_agents" VALIDATE CONSTRAINT "platform_agents_published_pointer_check";
--> statement-breakpoint
ALTER TABLE "platform_agents" VALIDATE CONSTRAINT "platform_agents_revision_check";
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'platform_user_agent_materializations_user_id_users_id_fk') THEN
    ALTER TABLE "platform_user_agent_materializations" ADD CONSTRAINT "platform_user_agent_materializations_user_id_users_id_fk"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'platform_user_agent_materializations_platform_agent_id_platform_agents_id_fk') THEN
    ALTER TABLE "platform_user_agent_materializations" ADD CONSTRAINT "platform_user_agent_materializations_platform_agent_id_platform_agents_id_fk"
      FOREIGN KEY ("platform_agent_id") REFERENCES "platform_agents"("id") ON DELETE restrict;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'platform_user_agent_materializations_materialized_agent_id_agents_id_fk') THEN
    ALTER TABLE "platform_user_agent_materializations" ADD CONSTRAINT "platform_user_agent_materializations_materialized_agent_id_agents_id_fk"
      FOREIGN KEY ("materialized_agent_id") REFERENCES "agents"("id") ON DELETE restrict;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'platform_user_agent_materializations_exact_version_fk') THEN
    ALTER TABLE "platform_user_agent_materializations" ADD CONSTRAINT "platform_user_agent_materializations_exact_version_fk"
      FOREIGN KEY ("platform_agent_id","platform_agent_version_id","platform_agent_version_checksum")
      REFERENCES "platform_agent_versions"("agent_id","id","checksum") ON DELETE restrict;
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "enforce_platform_agent_assignment_target"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."target_type" = 'global_role' THEN
    PERFORM 1 FROM "rbac_roles"
    WHERE "id" = NEW."target_id" AND "workspace_id" IS NULL
    FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'platform Agent assignments require an existing global RBAC role' USING ERRCODE = '23503';
    END IF;
  END IF;
  IF NEW."target_type" = 'user' THEN
    PERFORM 1 FROM "users" WHERE "id" = NEW."target_id" FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'platform Agent assignments require an existing user' USING ERRCODE = '23503';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'platform_agent_assignments_target_guard') THEN
    CREATE TRIGGER "platform_agent_assignments_target_guard"
      BEFORE INSERT OR UPDATE OF "target_type", "target_id" ON "platform_agent_assignments"
      FOR EACH ROW EXECUTE FUNCTION "enforce_platform_agent_assignment_target"();
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "protect_platform_agent_global_role_scope"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (
      SELECT 1 FROM "platform_agent_assignments"
      WHERE "target_type" = 'global_role' AND "target_id" = OLD."id"
    ) THEN
      RAISE EXCEPTION 'assigned global RBAC roles cannot be removed' USING ERRCODE = '23503';
    END IF;
    RETURN OLD;
  END IF;
  -- workspace_id is not a key column, so UPDATE would otherwise take a lock that
  -- does not conflict with the assignment trigger's FOR KEY SHARE lookup.
  PERFORM 1 FROM "rbac_roles" WHERE "id" = OLD."id" FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM "platform_agent_assignments"
    WHERE "target_type" = 'global_role' AND "target_id" = OLD."id"
  ) AND (NEW."id" IS DISTINCT FROM OLD."id" OR NEW."workspace_id" IS NOT NULL) THEN
    RAISE EXCEPTION 'assigned global RBAC roles cannot be moved to a workspace' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'rbac_roles_platform_agent_assignment_guard') THEN
    CREATE TRIGGER "rbac_roles_platform_agent_assignment_guard"
      BEFORE DELETE OR UPDATE OF "id", "workspace_id" ON "rbac_roles"
      FOR EACH ROW EXECUTE FUNCTION "protect_platform_agent_global_role_scope"();
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "protect_platform_agent_user_target"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (
      SELECT 1 FROM "platform_agent_assignments"
      WHERE "target_type" = 'user' AND "target_id" = OLD."id"
    ) THEN
      RAISE EXCEPTION 'users with a platform Agent assignment cannot be removed' USING ERRCODE = '23503';
    END IF;
    RETURN OLD;
  END IF;
  PERFORM 1 FROM "users" WHERE "id" = OLD."id" FOR UPDATE;
  IF NEW."id" IS DISTINCT FROM OLD."id" AND EXISTS (
    SELECT 1 FROM "platform_agent_assignments"
    WHERE "target_type" = 'user' AND "target_id" = OLD."id"
  ) THEN
    RAISE EXCEPTION 'a platform Agent assignment target user id cannot change' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'users_platform_agent_assignment_guard') THEN
    CREATE TRIGGER "users_platform_agent_assignment_guard"
      BEFORE DELETE OR UPDATE OF "id" ON "users"
      FOR EACH ROW EXECUTE FUNCTION "protect_platform_agent_user_target"();
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "enforce_platform_user_agent_materialization_owner"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND OLD."materialized_agent_id" IS NOT NULL
    AND NEW."materialized_agent_id" IS DISTINCT FROM OLD."materialized_agent_id"
  THEN
    RAISE EXCEPTION 'a materialized Agent identity cannot be replaced or cleared' USING ERRCODE = '55000';
  END IF;
  IF NEW."materialized_agent_id" IS NOT NULL THEN
    PERFORM 1 FROM "agents"
    WHERE "id" = NEW."materialized_agent_id" AND "user_id" = NEW."user_id"
    FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'materialized Agent must belong to the materialization user' USING ERRCODE = '23503';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'platform_user_agent_materializations_owner_guard') THEN
    CREATE TRIGGER "platform_user_agent_materializations_owner_guard"
      BEFORE INSERT OR UPDATE OF "user_id", "materialized_agent_id" ON "platform_user_agent_materializations"
      FOR EACH ROW EXECUTE FUNCTION "enforce_platform_user_agent_materialization_owner"();
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "protect_materialized_agent_owner"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- user_id is not part of the Agent key, so explicitly serialize owner changes
  -- with the materialization trigger's FOR KEY SHARE lookup.
  PERFORM 1 FROM "agents" WHERE "id" = OLD."id" FOR UPDATE;
  IF NEW."user_id" IS DISTINCT FROM OLD."user_id" AND EXISTS (
    SELECT 1 FROM "platform_user_agent_materializations" WHERE "materialized_agent_id" = OLD."id"
  ) THEN
    RAISE EXCEPTION 'a materialized Agent owner cannot be changed' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'agents_materialization_owner_guard') THEN
    CREATE TRIGGER "agents_materialization_owner_guard"
      BEFORE UPDATE OF "user_id" ON "agents"
      FOR EACH ROW EXECUTE FUNCTION "protect_materialized_agent_owner"();
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "require_exact_platform_agent_version_insert"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."checksum" IS NULL OR NEW."dependency_snapshot" IS NULL THEN
    RAISE EXCEPTION 'new platform Agent versions require an exact dependency snapshot and checksum' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'platform_agent_versions_exact_insert_guard') THEN
    CREATE TRIGGER "platform_agent_versions_exact_insert_guard"
      BEFORE INSERT ON "platform_agent_versions"
      FOR EACH ROW EXECUTE FUNCTION "require_exact_platform_agent_version_insert"();
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "require_exact_platform_agent_published_pointer"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" = 'published' THEN
    IF NEW."migration_required" OR NEW."current_version_id" IS NULL OR NEW."published_at" IS NULL THEN
      RAISE EXCEPTION 'published platform Agents require an exact current version' USING ERRCODE = '23514';
    END IF;
    PERFORM 1 FROM "platform_agent_versions"
    WHERE "agent_id" = NEW."id"
      AND "id" = NEW."current_version_id"
      AND "checksum" IS NOT NULL
      AND "dependency_snapshot" IS NOT NULL
    FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'published platform Agents require an exact current version' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'platform_agents_exact_published_pointer_guard') THEN
    CREATE TRIGGER "platform_agents_exact_published_pointer_guard"
      BEFORE INSERT OR UPDATE OF "status", "current_version_id", "published_at", "migration_required"
      ON "platform_agents"
      FOR EACH ROW EXECUTE FUNCTION "require_exact_platform_agent_published_pointer"();
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "prevent_platform_agent_version_mutation"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'platform_agent_versions are immutable' USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'platform_agent_versions_immutable') THEN
    CREATE TRIGGER "platform_agent_versions_immutable"
      BEFORE UPDATE OR DELETE ON "platform_agent_versions"
      FOR EACH ROW EXECUTE FUNCTION "prevent_platform_agent_version_mutation"();
  END IF;
END $$;
