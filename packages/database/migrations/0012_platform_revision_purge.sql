-- Custom SQL migration: allow a guarded purge of platform_resource_revisions.
--
-- Historical 0145 made the table strictly append-only: UPDATE and DELETE were both rejected
-- unconditionally. Provider hard-delete now has to be a TRUE delete — after removing a
-- platform AI provider the instance must look as if that provider had never been managed, so
-- runtime falls back to the user's own BYOK configuration instead of resolving a tombstone.
-- Leaving orphan revision rows behind would keep the history (and the pinned secret
-- fingerprints) of a resource that no longer exists.
--
-- UPDATE stays unconditionally immutable: a published revision is never rewritten in place.
-- DELETE is permitted only inside a transaction that explicitly opts in via the
-- transaction-local GUC `lobe.allow_platform_revision_purge = 'on'`, mirroring the existing
-- escape hatches for platform_agent_versions and platform_audit_logs.
--
-- Idempotent / convergent: CREATE OR REPLACE + DROP/CREATE TRIGGER may be re-applied safely.

CREATE OR REPLACE FUNCTION "prevent_platform_resource_revision_mutation"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('lobe.allow_platform_revision_purge', true) = 'on'
  THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'platform_resource_revisions are immutable' USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "platform_resource_revisions_immutable" ON "platform_resource_revisions";
--> statement-breakpoint
CREATE TRIGGER "platform_resource_revisions_immutable"
BEFORE UPDATE OR DELETE ON "platform_resource_revisions"
FOR EACH ROW EXECUTE FUNCTION "prevent_platform_resource_revision_mutation"();
