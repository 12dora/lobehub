/**
 * Shared isolated ParadeDB harness for CAS unit/subprocess tests.
 * Each consumer owns its own lifecycle/container — no shared pollution.
 */
import { Pool } from 'pg';

import {
  cleanupLifecycle,
  createLifecycleState,
  createRunToken,
  inspectPublishedHostPort,
  type LifecycleState,
  startOwnedContainer,
} from './lifecycle';

export const createCasMinimalSchema = async (databaseUrl: string): Promise<void> => {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rbac_permissions (
        id text PRIMARY KEY,
        code text UNIQUE NOT NULL,
        name text,
        category text,
        description text,
        is_active boolean,
        created_at timestamptz NOT NULL DEFAULT NOW(),
        updated_at timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS rbac_roles (
        id text PRIMARY KEY,
        name text NOT NULL,
        display_name text,
        description text,
        is_system boolean,
        is_active boolean,
        metadata jsonb DEFAULT '{}'::jsonb,
        workspace_id text,
        created_at timestamptz NOT NULL DEFAULT NOW(),
        updated_at timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS rbac_roles_platform_name_uidx
        ON rbac_roles (name) WHERE workspace_id IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS rbac_roles_ws_name_uidx
        ON rbac_roles (workspace_id, name) WHERE workspace_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS rbac_role_permissions (
        role_id text NOT NULL REFERENCES rbac_roles(id) ON DELETE CASCADE,
        permission_id text NOT NULL REFERENCES rbac_permissions(id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT NOW(),
        PRIMARY KEY (role_id, permission_id)
      );
      CREATE TABLE IF NOT EXISTS platform_managed_resource_policies (
        id text PRIMARY KEY,
        resource text UNIQUE NOT NULL,
        status text,
        revision int,
        enforcement text,
        config jsonb,
        created_at timestamptz,
        updated_at timestamptz
      );
      CREATE TABLE IF NOT EXISTS users (
        id text PRIMARY KEY,
        email text,
        normalized_email text,
        username text,
        full_name text,
        email_verified boolean,
        onboarding jsonb,
        created_at timestamptz,
        updated_at timestamptz,
        last_active_at timestamptz
      );
      CREATE TABLE IF NOT EXISTS accounts (
        id text PRIMARY KEY,
        user_id text,
        account_id text,
        provider_id text,
        password text,
        created_at timestamptz,
        updated_at timestamptz
      );
      CREATE TABLE IF NOT EXISTS workspaces (
        id text PRIMARY KEY,
        slug text,
        name text,
        description text,
        primary_owner_id text,
        created_at timestamptz,
        updated_at timestamptz
      );
      CREATE TABLE IF NOT EXISTS rbac_user_roles (
        id uuid PRIMARY KEY,
        user_id text,
        role_id text REFERENCES rbac_roles(id) ON DELETE CASCADE,
        workspace_id text,
        created_at timestamptz NOT NULL DEFAULT NOW(),
        expires_at timestamptz
      );
      CREATE TABLE IF NOT EXISTS auth_sessions (
        id text PRIMARY KEY,
        user_id text
      );
      CREATE TABLE IF NOT EXISTS platform_skills (
        id text PRIMARY KEY,
        skill_key text
      );

      -- Test-only: deferred constraint trigger fires at COMMIT for real in-flight/abort tests.
      CREATE TABLE IF NOT EXISTS e2e_cas_commit_probe (
        id int PRIMARY KEY,
        note text
      );
      CREATE OR REPLACE FUNCTION e2e_cas_commit_probe_fn() RETURNS trigger AS $$
      DECLARE
        mode text := current_setting('e2e.cas_commit_mode', true);
        sleep_ms text := current_setting('e2e.cas_commit_sleep_ms', true);
        ms int;
      BEGIN
        IF mode = 'raise' THEN
          RAISE EXCEPTION 'e2e deferred COMMIT abort (real COMMIT query failed)';
        END IF;
        IF mode = 'sleep' AND sleep_ms IS NOT NULL AND sleep_ms <> '' THEN
          ms := GREATEST(1, sleep_ms::int);
          PERFORM pg_sleep(ms / 1000.0);
        END IF;
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS e2e_cas_commit_probe_trg ON e2e_cas_commit_probe;
      CREATE CONSTRAINT TRIGGER e2e_cas_commit_probe_trg
        AFTER INSERT OR UPDATE ON e2e_cas_commit_probe
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE PROCEDURE e2e_cas_commit_probe_fn();
    `);
  } finally {
    await pool.end();
  }
};

export const startCasPostgres = async (): Promise<{
  databaseUrl: string;
  runToken: string;
  state: LifecycleState;
  stop: () => Promise<void>;
}> => {
  const runToken = createRunToken();
  const state = createLifecycleState(runToken);
  const container = await startOwnedContainer({
    args: [
      '-e',
      'POSTGRES_PASSWORD=postgres',
      '-e',
      'POSTGRES_DB=cas_iso',
      '-p',
      '127.0.0.1::5432',
    ],
    image: 'paradedb/paradedb:latest-pg17',
    name: `aihub-admin-cas-${runToken.slice(-10)}`,
    runToken,
    state,
  });
  const port = await inspectPublishedHostPort(container.id, 5432);
  const databaseUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/cas_iso`;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 1500 });
    try {
      await pool.query('SELECT 1');
      await pool.end();
      break;
    } catch {
      await pool.end().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  await createCasMinimalSchema(databaseUrl);
  return {
    databaseUrl,
    runToken,
    state,
    stop: async () => {
      await cleanupLifecycle(state);
    },
  };
};
