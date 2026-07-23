-- Custom SQL migration: platform DB hardening (immutability, credential ownership,
-- settings FK cascade, audit conversation / usage indexes).
-- Idempotent / convergent so partial re-applies are safe.

-- ── 1. Immutable revisions + append-only audit logs ─────────────────────────

CREATE OR REPLACE FUNCTION "prevent_platform_resource_revision_mutation"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'platform_resource_revisions are immutable' USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "platform_resource_revisions_immutable" ON "platform_resource_revisions";
--> statement-breakpoint
CREATE TRIGGER "platform_resource_revisions_immutable"
BEFORE UPDATE OR DELETE ON "platform_resource_revisions"
FOR EACH ROW EXECUTE FUNCTION "prevent_platform_resource_revision_mutation"();
--> statement-breakpoint

-- Audit logs: reject UPDATE always; allow DELETE only when the retention TX
-- opts in via transaction-local GUC lobe.allow_platform_audit_log_delete=on.
CREATE OR REPLACE FUNCTION "prevent_platform_audit_log_mutation"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('lobe.allow_platform_audit_log_delete', true) = 'on'
  THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'platform_audit_logs are append-only' USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "platform_audit_logs_append_only" ON "platform_audit_logs";
--> statement-breakpoint
CREATE TRIGGER "platform_audit_logs_append_only"
BEFORE UPDATE OR DELETE ON "platform_audit_logs"
FOR EACH ROW EXECUTE FUNCTION "prevent_platform_audit_log_mutation"();
--> statement-breakpoint

-- ── 2. Credential staged uploads: opaque id PK + required owner ─────────────

-- Drop anonymous/orphan staging (short TTL; safe to discard).
DELETE FROM "platform_global_credential_uploads" WHERE "created_by" IS NULL OR btrim("created_by") = '';
--> statement-breakpoint

ALTER TABLE "platform_global_credential_uploads" ADD COLUMN IF NOT EXISTS "id" text;
--> statement-breakpoint
UPDATE "platform_global_credential_uploads"
SET "id" = 'pgcu_' || substr(md5(random()::text || "file_hash_id" || coalesce("created_by", '')), 1, 16)
WHERE "id" IS NULL;
--> statement-breakpoint
ALTER TABLE "platform_global_credential_uploads" ALTER COLUMN "id" SET NOT NULL;
--> statement-breakpoint

-- Swap primary key from content hash → opaque upload id.
ALTER TABLE "platform_global_credential_uploads" DROP CONSTRAINT IF EXISTS "platform_global_credential_uploads_pkey";
--> statement-breakpoint
ALTER TABLE "platform_global_credential_uploads" ADD PRIMARY KEY ("id");
--> statement-breakpoint

ALTER TABLE "platform_global_credential_uploads" ALTER COLUMN "created_by" SET NOT NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "platform_global_credential_uploads_owner_hash_unique"
  ON "platform_global_credential_uploads" USING btree ("created_by", "file_hash_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_global_credential_uploads_created_by_idx"
  ON "platform_global_credential_uploads" USING btree ("created_by");
--> statement-breakpoint

-- Ensure file_hash_id format check exists (catalog-guarded).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'platform_global_credential_uploads_file_hash_id_check'
  ) THEN
    ALTER TABLE "platform_global_credential_uploads"
      ADD CONSTRAINT "platform_global_credential_uploads_file_hash_id_check"
      CHECK ("file_hash_id" ~ '^[a-f0-9]{64}$');
  END IF;
END $$;
--> statement-breakpoint

-- ── 3. User setting overrides cascade on hard user delete ───────────────────

-- Drop orphans that would block FK creation.
DELETE FROM "user_setting_overrides" uso
WHERE NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = uso.user_id);
--> statement-breakpoint
DELETE FROM "user_setting_override_revisions" usr
WHERE NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = usr.user_id);
--> statement-breakpoint

ALTER TABLE "user_setting_overrides"
  DROP CONSTRAINT IF EXISTS "user_setting_overrides_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "user_setting_overrides"
  ADD CONSTRAINT "user_setting_overrides_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "user_setting_override_revisions"
  DROP CONSTRAINT IF EXISTS "user_setting_override_revisions_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "user_setting_override_revisions"
  ADD CONSTRAINT "user_setting_override_revisions_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

-- ── 4. Audit conversation / global usage indexes ────────────────────────────

CREATE INDEX IF NOT EXISTS "topics_user_id_created_at_id_idx"
  ON "topics" USING btree ("user_id", "created_at", "id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_user_id_topic_id_created_at_id_idx"
  ON "messages" USING btree ("user_id", "topic_id", "created_at", "id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_role_created_at_idx"
  ON "messages" USING btree ("role", "created_at");
--> statement-breakpoint

-- Title ILIKE '%q%' for audit conversation search (optional where pg_trgm exists).
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
