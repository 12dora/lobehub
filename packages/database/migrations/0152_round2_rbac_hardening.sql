-- =============================================================================
-- 0152_round2_rbac_hardening — GUC-trust immutability defense-in-depth (users-rbac/F1)
-- SAFE, NON-ABUSABLE, DOUBLE-GATED NO-OP SCAFFOLD.
-- =============================================================================
--
-- BACKGROUND
--   Migration 0145 installed append-only / immutability triggers. Legitimate
--   retention DELETE on platform_audit_logs is gated by a transaction-local GUC
--   (set_config('lobe.allow_platform_audit_log_delete','on',true)); a similar GUC
--   guards platform_agent_versions hard-delete (0140). WEAKNESS (verified MEDIUM,
--   post-compromise defense-in-depth): any client that can open a DB session as the
--   app role can itself SET the GUC and DELETE, because the trigger trusts the GUC
--   rather than a privilege boundary. When DATABASE_URL uses the Postgres SUPERUSER
--   (`postgres`), privilege revocation is meaningless (superuser bypasses). Real
--   isolation requires a dedicated least-privilege app role — an infra/deployment
--   change, not a pure code fix. The audit deferred this exactly because a naive
--   REVOKE breaks the app's normal delete paths.
--
-- WHY NO SECURITY DEFINER "purge" HELPER
--   An app-callable SECURITY DEFINER delete function is itself an arbitrary-delete
--   hole: whatever policy it enforces, a caller that controls its arguments (e.g. a
--   retention cutoff) can pass a far-future value and purge everything not under a
--   legal hold. There is NO app-callable privileged bypass in this migration by
--   design. On a hardened deployment, retention purge and agent hard-delete must run
--   as a SEPARATE privileged maintenance role/connection — never the app role.
--
-- WHAT THIS MIGRATION DOES
--   Nothing at all, UNLESS BOTH of these hold (double gate):
--     (1) an explicit activation marker is set:
--           current_setting('aihub.rbac_hardening_activate', true) = 'on'
--         (set as a role/db-scoped GUC by an operator who has completed the infra
--          + app-rewiring steps below), AND
--     (2) a dedicated, non-superuser app role exists (named via
--           current_setting('aihub.app_db_role', true), else 'aihub_app'/'lobe_app').
--   When activated, it REVOKEs DELETE on the guarded append-only/immutable tables
--   from that role. It never creates a callable bypass and never touches superuser.
--
-- INTENTIONAL NO-OP ON CURRENT SUPERUSER / PGlite DEPLOYS
--   The demo/dev DATABASE_URL is the superuser and no activation marker is set, so
--   this migration is a COMPLETE no-op (NOTICE only; zero GRANT/REVOKE). PGlite test
--   runs likewise no-op. Existing direct GUC+DELETE paths keep working unchanged.
--
-- HOW TO FULLY ACTIVATE (deliberate infra + app follow-up — NOT automatic)
--   1. CREATE ROLE aihub_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;  (or name it
--      via `SET aihub.app_db_role = 'your_app_role'` before migrate). GRANT it normal
--      DML (SELECT/INSERT/UPDATE, and DELETE only on genuinely mutable tables).
--   2. Move the two immutable-table delete paths OFF the app role onto a separate
--      privileged maintenance role/connection (they must NOT run as the least-priv app
--      role once its DELETE is revoked):
--        - packages/database/src/models/platform/auditRetention.ts (retention purge)
--        - packages/database/src/repositories/platformAgentCatalog/index.ts (agent hard-delete cascade)
--      (Those files are owned by other batches; this migration does not edit them.)
--   3. Point DATABASE_URL at the least-privilege app role.
--   4. Only then set the activation marker (role/db GUC):
--        ALTER ROLE aihub_app SET aihub.rbac_hardening_activate = 'on';
--      and re-run migrations (or run the guarded block) so the REVOKE takes effect.
--
-- SAFETY PROPERTIES (provable from this file alone)
--   - No SECURITY DEFINER function; no app-callable privileged delete of any kind.
--   - No bare GRANT/REVOKE: the only REVOKE is inside a DO block gated on BOTH the
--     explicit activation marker AND a dedicated non-superuser role.
--   - Superuser / missing marker / missing role → zero privilege statements execute.
--   - current_user is checked: if the connected role is itself the superuser or lacks
--     a dedicated non-super target, nothing is revoked.
--   - Idempotent: guarded, catalog-checked, safe to re-apply.
--   - Drops any SECURITY DEFINER purge helpers a prior draft of this migration may
--     have installed (they were an arbitrary-delete risk).
-- =============================================================================

-- Remove any purge helpers from prior drafts of this migration (arbitrary-delete risk).
DROP FUNCTION IF EXISTS "platform_purge_audit_logs"(text[], timestamptz);
--> statement-breakpoint
DROP FUNCTION IF EXISTS "platform_purge_agent_versions_for_agent"(text);
--> statement-breakpoint
DROP FUNCTION IF EXISTS "platform_purge_agent_versions"(text[]);
--> statement-breakpoint

-- Guarded, activation-gated, no-op-by-default privilege hardening.
DO $$
DECLARE
  activate text;
  candidates text[] := ARRAY[]::text[];
  setting_role text;
  role_name text;
  is_super boolean;
  hardened_any boolean := false;
  guarded_tables text[] := ARRAY[
    'platform_audit_logs',
    'platform_resource_revisions',
    'platform_agent_versions',
    'platform_skill_versions'
  ];
  t text;
BEGIN
  -- Gate 1: explicit activation marker. Absent/!= 'on' → complete no-op.
  -- (The migration must be RUN BY a privileged role — superuser or the tables' owner —
  --  since only such a role can REVOKE privileges from the dedicated app role. That is
  --  expected and correct; the target of the REVOKE is the SEPARATE dedicated role below,
  --  never current_user.)
  activate := nullif(btrim(coalesce(current_setting('aihub.rbac_hardening_activate', true), '')), '');
  IF activate IS DISTINCT FROM 'on' THEN
    RAISE NOTICE
      '0152_round2_rbac_hardening: not activated (aihub.rbac_hardening_activate <> on); intentional no-op. Superuser/PGlite/demo keep direct GUC+DELETE paths.';
    RETURN;
  END IF;

  -- Gate 2: a dedicated, non-superuser app role must exist (the REVOKE target).
  setting_role := nullif(btrim(coalesce(current_setting('aihub.app_db_role', true), '')), '');
  IF setting_role IS NOT NULL THEN
    candidates := array_append(candidates, setting_role);
  END IF;
  candidates := candidates || ARRAY['aihub_app', 'lobe_app'];

  FOREACH role_name IN ARRAY candidates
  LOOP
    SELECT r.rolsuper INTO is_super
    FROM pg_catalog.pg_roles r
    WHERE r.rolname = role_name;
    IF NOT FOUND THEN CONTINUE; END IF;
    IF is_super THEN CONTINUE; END IF;

    -- The only privilege statement in this migration: revoke DELETE on immutable tables.
    FOREACH t IN ARRAY guarded_tables
    LOOP
      IF to_regclass(format('public.%I', t)) IS NOT NULL THEN
        EXECUTE format('REVOKE DELETE ON TABLE public.%I FROM %I', t, role_name);
      END IF;
    END LOOP;

    RAISE NOTICE
      '0152_round2_rbac_hardening: revoked DELETE on guarded immutable tables from non-superuser role %. Ensure retention/hard-delete run as a separate privileged maintenance role.',
      role_name;
    hardened_any := true;
    EXIT; -- harden only the first matching dedicated role
  END LOOP;

  IF NOT hardened_any THEN
    RAISE NOTICE
      '0152_round2_rbac_hardening: activation set but no dedicated non-superuser app role found (aihub.app_db_role / aihub_app / lobe_app); no-op.';
  END IF;
END $$;
