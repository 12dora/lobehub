-- Round-2 skills: allow validation_result-only UPDATEs on immutable skill versions
-- when the writer opts in via transaction-local GUC
-- lobe.allow_platform_skill_version_validation_update=on.
--
-- Mirrors 0140 agent-version delete / 0145 audit retention GUC escape hatches.
-- Content fields stay immutable; DELETE stays rejected.
-- Idempotent: CREATE OR REPLACE FUNCTION only (trigger binding from 0122 still points here).

CREATE OR REPLACE FUNCTION "prevent_platform_skill_version_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  masked "platform_skill_versions"%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE'
     AND current_setting('lobe.allow_platform_skill_version_validation_update', true) = 'on'
  THEN
    -- Robust "only validation_result changed" check: mask allowed columns back to OLD
    -- and compare the whole row. platform_skill_versions has no updated_at column;
    -- if one is added later, mask it here as well.
    masked := NEW;
    masked.validation_result := OLD.validation_result;
    IF masked IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION 'platform_skill_versions are immutable' USING ERRCODE = '55000';
END;
$$;
