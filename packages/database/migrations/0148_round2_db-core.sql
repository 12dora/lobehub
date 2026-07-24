-- Round-2 db-core: online index path for high-write tables + sidebar policy invariants.
-- Idempotent / convergent so partial re-applies are safe.
--
-- ── Indexes (0141 / 0145 follow-up) ──────────────────────────────────────────
-- 0141 and 0145 created these indexes without CONCURRENTLY, which blocks writes on
-- large production tables for the duration of each build.
--
-- CREATE INDEX CONCURRENTLY cannot run inside drizzle-orm's transactional migrator
-- (see pg-core dialect.migrate). Production / large deployments MUST prebuild in
-- autocommit before (or instead of relying on) the transactional fallbacks below:
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "platform_audit_logs_actor_created_at_id_idx"
--     ON "platform_audit_logs" USING btree ("actor_user_id","created_at","id");
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "platform_audit_logs_action_created_at_id_idx"
--     ON "platform_audit_logs" USING btree ("action","created_at","id");
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "platform_audit_logs_result_created_at_id_idx"
--     ON "platform_audit_logs" USING btree ("result","created_at","id");
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "platform_audit_logs_created_at_id_idx"
--     ON "platform_audit_logs" USING btree ("created_at","id");
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "topics_user_id_created_at_id_idx"
--     ON "topics" USING btree ("user_id","created_at","id");
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "messages_user_id_topic_id_created_at_id_idx"
--     ON "messages" USING btree ("user_id","topic_id","created_at","id");
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "messages_role_created_at_idx"
--     ON "messages" USING btree ("role","created_at");
--   -- optional, requires pg_trgm:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "topics_title_trgm_idx"
--     ON "topics" USING gin ("title" gin_trgm_ops);
--
-- Transactional fallbacks: IF NOT EXISTS → no-op when predeploy (or 0141/0145)
-- already created the index. Do NOT DROP valid indexes here (would regress plans).
-- Large tables that still lack an index raise so ops can run the CONCURRENTLY form.

DO $$
DECLARE
  bounded_count integer;
BEGIN
  IF to_regclass('public.platform_audit_logs_actor_created_at_id_idx') IS NULL
     AND to_regclass('public.platform_audit_logs') IS NOT NULL THEN
    SELECT count(*) INTO bounded_count FROM (SELECT 1 FROM "platform_audit_logs" LIMIT 10001) rows;
    IF bounded_count > 10000
       AND coalesce(current_setting('aihub.db_core_index_predeploy', true), 'off') <> 'on' THEN
      RAISE EXCEPTION 'DB_CORE_PREDEPLOY_INDEX_REQUIRED:platform_audit_logs_actor_created_at_id_idx';
    END IF;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_audit_logs_actor_created_at_id_idx"
  ON "platform_audit_logs" USING btree ("actor_user_id","created_at","id");
--> statement-breakpoint

DO $$
DECLARE
  bounded_count integer;
BEGIN
  IF to_regclass('public.platform_audit_logs_action_created_at_id_idx') IS NULL
     AND to_regclass('public.platform_audit_logs') IS NOT NULL THEN
    SELECT count(*) INTO bounded_count FROM (SELECT 1 FROM "platform_audit_logs" LIMIT 10001) rows;
    IF bounded_count > 10000
       AND coalesce(current_setting('aihub.db_core_index_predeploy', true), 'off') <> 'on' THEN
      RAISE EXCEPTION 'DB_CORE_PREDEPLOY_INDEX_REQUIRED:platform_audit_logs_action_created_at_id_idx';
    END IF;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_audit_logs_action_created_at_id_idx"
  ON "platform_audit_logs" USING btree ("action","created_at","id");
--> statement-breakpoint

DO $$
DECLARE
  bounded_count integer;
BEGIN
  IF to_regclass('public.platform_audit_logs_result_created_at_id_idx') IS NULL
     AND to_regclass('public.platform_audit_logs') IS NOT NULL THEN
    SELECT count(*) INTO bounded_count FROM (SELECT 1 FROM "platform_audit_logs" LIMIT 10001) rows;
    IF bounded_count > 10000
       AND coalesce(current_setting('aihub.db_core_index_predeploy', true), 'off') <> 'on' THEN
      RAISE EXCEPTION 'DB_CORE_PREDEPLOY_INDEX_REQUIRED:platform_audit_logs_result_created_at_id_idx';
    END IF;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_audit_logs_result_created_at_id_idx"
  ON "platform_audit_logs" USING btree ("result","created_at","id");
--> statement-breakpoint

DO $$
DECLARE
  bounded_count integer;
BEGIN
  IF to_regclass('public.platform_audit_logs_created_at_id_idx') IS NULL
     AND to_regclass('public.platform_audit_logs') IS NOT NULL THEN
    SELECT count(*) INTO bounded_count FROM (SELECT 1 FROM "platform_audit_logs" LIMIT 10001) rows;
    IF bounded_count > 10000
       AND coalesce(current_setting('aihub.db_core_index_predeploy', true), 'off') <> 'on' THEN
      RAISE EXCEPTION 'DB_CORE_PREDEPLOY_INDEX_REQUIRED:platform_audit_logs_created_at_id_idx';
    END IF;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_audit_logs_created_at_id_idx"
  ON "platform_audit_logs" USING btree ("created_at","id");
--> statement-breakpoint

DO $$
DECLARE
  bounded_count integer;
BEGIN
  IF to_regclass('public.topics_user_id_created_at_id_idx') IS NULL
     AND to_regclass('public.topics') IS NOT NULL THEN
    SELECT count(*) INTO bounded_count FROM (SELECT 1 FROM "topics" LIMIT 10001) rows;
    IF bounded_count > 10000
       AND coalesce(current_setting('aihub.db_core_index_predeploy', true), 'off') <> 'on' THEN
      RAISE EXCEPTION 'DB_CORE_PREDEPLOY_INDEX_REQUIRED:topics_user_id_created_at_id_idx';
    END IF;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "topics_user_id_created_at_id_idx"
  ON "topics" USING btree ("user_id","created_at","id");
--> statement-breakpoint

DO $$
DECLARE
  bounded_count integer;
BEGIN
  IF to_regclass('public.messages_user_id_topic_id_created_at_id_idx') IS NULL
     AND to_regclass('public.messages') IS NOT NULL THEN
    SELECT count(*) INTO bounded_count FROM (SELECT 1 FROM "messages" LIMIT 10001) rows;
    IF bounded_count > 10000
       AND coalesce(current_setting('aihub.db_core_index_predeploy', true), 'off') <> 'on' THEN
      RAISE EXCEPTION 'DB_CORE_PREDEPLOY_INDEX_REQUIRED:messages_user_id_topic_id_created_at_id_idx';
    END IF;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_user_id_topic_id_created_at_id_idx"
  ON "messages" USING btree ("user_id","topic_id","created_at","id");
--> statement-breakpoint

DO $$
DECLARE
  bounded_count integer;
BEGIN
  IF to_regclass('public.messages_role_created_at_idx') IS NULL
     AND to_regclass('public.messages') IS NOT NULL THEN
    SELECT count(*) INTO bounded_count FROM (SELECT 1 FROM "messages" LIMIT 10001) rows;
    IF bounded_count > 10000
       AND coalesce(current_setting('aihub.db_core_index_predeploy', true), 'off') <> 'on' THEN
      RAISE EXCEPTION 'DB_CORE_PREDEPLOY_INDEX_REQUIRED:messages_role_created_at_idx';
    END IF;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_role_created_at_idx"
  ON "messages" USING btree ("role","created_at");
--> statement-breakpoint

-- Optional title search index (pg_trgm). CONCURRENTLY form is documented above;
-- transactional path matches 0145 (extension-gated, non-CONCURRENTLY).
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE NOTICE 'pg_trgm unavailable; skipping topics_title_trgm_idx';
      RETURN;
  END;
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    CREATE INDEX IF NOT EXISTS "topics_title_trgm_idx"
      ON "topics" USING gin ("title" gin_trgm_ops);
  END IF;
END $$;
--> statement-breakpoint

-- ── Sidebar layout policy invariants (F3 / F4) ───────────────────────────────
-- Never silently DELETE unexpected singleton ids — abort so ops can inspect /
-- quarantine. Invalid modes collapse to 'user' (same read-time interpretation).

DO $$
DECLARE
  unexpected_ids text;
BEGIN
  SELECT string_agg("id", ', ' ORDER BY "id")
    INTO unexpected_ids
  FROM "platform_sidebar_layout"
  WHERE "id" <> 'global';

  IF unexpected_ids IS NOT NULL THEN
    RAISE EXCEPTION
      'DB_CORE_SIDEBAR_LAYOUT_UNEXPECTED_IDS: unexpected platform_sidebar_layout.id values (expected only ''global''): %',
      unexpected_ids;
  END IF;
END $$;
--> statement-breakpoint
UPDATE "platform_sidebar_layout"
SET "mode" = 'user'
WHERE "mode" IS DISTINCT FROM 'user' AND "mode" IS DISTINCT FROM 'platform';
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'platform_sidebar_layout_id_singleton'
  ) THEN
    ALTER TABLE "platform_sidebar_layout"
      ADD CONSTRAINT "platform_sidebar_layout_id_singleton"
      CHECK ("id" = 'global');
  END IF;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'platform_sidebar_layout_mode_check'
  ) THEN
    ALTER TABLE "platform_sidebar_layout"
      ADD CONSTRAINT "platform_sidebar_layout_mode_check"
      CHECK ("mode" IN ('user', 'platform'));
  END IF;
END $$;
--> statement-breakpoint

-- Auth settings singleton was added in 0147; re-assert idempotently for installs
-- that may have skipped that path. Reject unexpected ids — never DELETE them.

DO $$
DECLARE
  unexpected_ids text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'platform_auth_settings_id_singleton'
  ) THEN
    SELECT string_agg("id", ', ' ORDER BY "id")
      INTO unexpected_ids
    FROM "platform_auth_settings"
    WHERE "id" <> 'global';

    IF unexpected_ids IS NOT NULL THEN
      RAISE EXCEPTION
        'DB_CORE_AUTH_SETTINGS_UNEXPECTED_IDS: unexpected platform_auth_settings.id values (expected only ''global''): %',
        unexpected_ids;
    END IF;

    ALTER TABLE "platform_auth_settings"
      ADD CONSTRAINT "platform_auth_settings_id_singleton"
      CHECK ("id" = 'global');
  END IF;
END $$;
