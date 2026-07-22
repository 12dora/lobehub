-- Custom SQL migration file, put your code below! --

-- Relax the platform_agent_versions immutability trigger to permit DELETE **only** inside a
-- transaction that explicitly opts in via a transaction-local GUC. This is the escape hatch used
-- by the admin "hard delete agent" path (admin.agents.delete): the FK graph around a platform
-- agent is a circular RESTRICT (agents.current_version_id ↔ agent_versions.agent_id), so the
-- version rows must be deletable to remove the agent — but only under the guarded delete flow.
-- UPDATE stays fully immutable; a DELETE without the opt-in GUC is still rejected.
CREATE OR REPLACE FUNCTION "prevent_platform_agent_version_mutation"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('lobe.allow_platform_agent_version_delete', true) = 'on'
  THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'platform_agent_versions are immutable' USING ERRCODE = '55000';
END;
$$;
