// @vitest-environment node
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { Pool, type PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';

const runPostgresMigration = process.env.TEST_SERVER_DB === '1';
const migrationPath = path.join(
  __dirname,
  '../../../migrations/0123_m09_connector_catalog_expand.sql',
);
const attemptMigrationPath = path.join(
  __dirname,
  '../../../migrations/0124_m09_oauth_attempt_outcome.sql',
);

const connectorColumns = [
  'display_name',
  'endpoint',
  'migration_required',
  'transport',
  'oauth_config',
  'shared_secret_ref',
  'shared_secret_fingerprint',
  'shared_secret_updated_at',
  'oauth_client_secret_ref',
  'oauth_client_secret_fingerprint',
  'oauth_client_secret_updated_at',
  'sort',
  'published_resource_type',
  'published_revision',
  'published_checksum',
  'published_at',
];
const toolColumns = [
  'display_name',
  'description',
  'input_schema',
  'output_schema',
  'enabled',
  'platform_policy',
  'risk_level',
  'requires_confirmation',
  'sort',
];
const bindingColumns = [
  'revision_resource_type',
  'published_revision',
  'binding_status',
  'oauth_token_ref',
  'token_fingerprint',
  'scopes',
  'revoked_at',
  'last_error_category',
  'revision',
];

const restoreM01ShellInsideTransaction = async (client: PoolClient) => {
  await client.query(
    'TRUNCATE TABLE platform_user_connector_bindings, platform_connector_tools, platform_connectors CASCADE',
  );
  await client.query(
    'DROP TABLE IF EXISTS platform_connector_oauth_states, platform_connector_secrets CASCADE',
  );

  for (const constraint of [
    'platform_connectors_display_name_nn',
    'platform_connectors_published_revision_fk',
    'platform_connectors_transport_http_check',
    'platform_connectors_credential_mode_check',
    'platform_connectors_credential_slot_check',
    'platform_connectors_published_pointer_check',
    'platform_connectors_revision_check',
    'platform_connectors_secret_ref_check',
    'platform_connectors_oauth_config_check',
    'platform_connectors_published_shared_secret_check',
  ]) {
    await client.query(`ALTER TABLE platform_connectors DROP CONSTRAINT IF EXISTS ${constraint}`);
  }
  for (const constraint of [
    'platform_connector_tools_display_name_nn',
    'platform_connector_tools_policy_check',
    'platform_connector_tools_risk_check',
    'platform_connector_tools_schema_check',
    'platform_connector_tools_confirmation_check',
  ]) {
    await client.query(
      `ALTER TABLE platform_connector_tools DROP CONSTRAINT IF EXISTS ${constraint}`,
    );
  }
  for (const constraint of [
    'platform_user_connector_bindings_user_id_users_id_fk',
    'platform_user_connector_bindings_revision_fk',
    'platform_user_connector_bindings_status_check',
    'platform_user_connector_bindings_revision_check',
    'platform_user_connector_bindings_token_ref_check',
    'platform_user_connector_bindings_state_fields_check',
    'platform_user_connector_bindings_revoked_check',
    'platform_user_connector_bindings_token_ref_format_check',
  ]) {
    await client.query(
      `ALTER TABLE platform_user_connector_bindings DROP CONSTRAINT IF EXISTS ${constraint}`,
    );
  }
  await client.query(
    'DROP INDEX IF EXISTS platform_user_connector_bindings_oauth_state_owner_unique',
  );
  await client.query(
    'DROP INDEX IF EXISTS platform_resource_revisions_type_id_revision_checksum_unique',
  );
  await client.query(
    `ALTER TABLE platform_connectors ${connectorColumns
      .map((column) => `DROP COLUMN IF EXISTS ${column}`)
      .join(', ')}`,
  );
  await client.query(
    `ALTER TABLE platform_connector_tools ${toolColumns
      .map((column) => `DROP COLUMN IF EXISTS ${column}`)
      .join(', ')}`,
  );
  await client.query(
    `ALTER TABLE platform_user_connector_bindings ${bindingColumns
      .map((column) => `DROP COLUMN IF EXISTS ${column}`)
      .join(', ')}`,
  );
};

describe.skipIf(!runPostgresMigration)('M09 PostgreSQL migration from the M01 shell', () => {
  it('preserves orphans and secrets while isolating unsafe legacy rows', async () => {
    await getTestDB();
    const connectionString = process.env.DATABASE_TEST_URL;
    if (!connectionString) throw new Error('DATABASE_TEST_URL is required');
    const pool = new Pool({ connectionString, max: 1 });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await restoreM01ShellInsideTransaction(client);
      await client.query(`
        INSERT INTO platform_connectors
          (id, connector_key, name, connection_type, mcp_server_url, mcp_stdio_config,
           credential_mode, oidc_config, encrypted_shared_credentials, secret_fingerprint, status)
        VALUES
          ('m09-pg-safe', 'm09-pg-safe', 'Safe HTTP', 'http', ' https://safe.example/mcp ', NULL,
           'none', NULL, NULL, NULL, 'draft'),
          ('m09-pg-stdio', 'm09-pg-stdio', 'Stdio', 'stdio', NULL, '{"command":"secret-bin"}',
           'none', NULL, NULL, NULL, 'draft'),
          ('m09-pg-secret', 'm09-pg-secret', 'Sensitive', 'http', 'https://secret.example/mcp', NULL,
           'per_user_oauth', '{"clientId":"old"}', 'ciphertext-old', 'fingerprint-old', 'draft'),
          ('m09-pg-published', 'm09-pg-published', 'Published old', 'http', 'https://published.example/mcp', NULL,
           'none', NULL, NULL, NULL, 'published')
      `);
      await client.query(`
        INSERT INTO platform_user_connector_bindings
          (id, user_id, connector_id, encrypted_credentials, status)
        VALUES ('m09-pg-orphan', 'm09-missing-user', 'm09-pg-safe', 'binding-ciphertext', 'active')
      `);

      const migration = await readFile(migrationPath, 'utf8');
      for (let pass = 0; pass < 2; pass += 1) {
        for (const statement of migration.split('--> statement-breakpoint')) {
          if (statement.trim()) await client.query(statement);
        }
      }

      const connectors = await client.query<{
        endpoint: string | null;
        id: string;
        migration_required: boolean;
        oauth_config: unknown;
        shared_secret_ref: string | null;
      }>(`SELECT id, endpoint, migration_required, oauth_config, shared_secret_ref
          FROM platform_connectors ORDER BY id`);
      expect(connectors.rows).toEqual([
        {
          endpoint: 'https://published.example/mcp',
          id: 'm09-pg-published',
          migration_required: true,
          oauth_config: null,
          shared_secret_ref: null,
        },
        {
          endpoint: 'https://safe.example/mcp',
          id: 'm09-pg-safe',
          migration_required: false,
          oauth_config: null,
          shared_secret_ref: null,
        },
        {
          endpoint: 'https://secret.example/mcp',
          id: 'm09-pg-secret',
          migration_required: true,
          oauth_config: null,
          shared_secret_ref: null,
        },
        {
          endpoint: null,
          id: 'm09-pg-stdio',
          migration_required: true,
          oauth_config: null,
          shared_secret_ref: null,
        },
      ]);
      const sensitive = await client.query<{
        encrypted_shared_credentials: string;
        oauth_client_secret_ref: string | null;
        oauth_config: unknown;
        oidc_config: unknown;
        shared_secret_ref: string | null;
      }>(`SELECT encrypted_shared_credentials, oauth_client_secret_ref, oauth_config, oidc_config,
                 shared_secret_ref
          FROM platform_connectors WHERE id = 'm09-pg-secret'`);
      expect(sensitive.rows).toEqual([
        {
          encrypted_shared_credentials: 'ciphertext-old',
          oauth_client_secret_ref: null,
          oauth_config: null,
          oidc_config: { clientId: 'old' },
          shared_secret_ref: null,
        },
      ]);
      const orphan = await client.query<{ encrypted_credentials: string }>(
        `SELECT encrypted_credentials FROM platform_user_connector_bindings WHERE id = 'm09-pg-orphan'`,
      );
      expect(orphan.rows).toEqual([{ encrypted_credentials: 'binding-ciphertext' }]);
      const fk = await client.query<{ convalidated: boolean }>(
        `SELECT convalidated FROM pg_constraint
         WHERE conname = 'platform_user_connector_bindings_user_id_users_id_fk'`,
      );
      expect(fk.rows).toEqual([{ convalidated: false }]);
      await expect(
        client.query(`INSERT INTO platform_user_connector_bindings
          (id, user_id, connector_id, status)
          VALUES ('m09-pg-new-orphan', 'm09-another-missing-user', 'm09-pg-safe', 'active')`),
      ).rejects.toThrow();
    } finally {
      await client.query('ROLLBACK');
      client.release();
      await pool.end();
    }
  }, 20_000);

  it('applies the OAuth attempt outcome follow-up twice without destructive DDL', async () => {
    await getTestDB();
    const connectionString = process.env.DATABASE_TEST_URL;
    if (!connectionString) throw new Error('DATABASE_TEST_URL is required');
    const pool = new Pool({ connectionString, max: 1 });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const migration = await readFile(attemptMigrationPath, 'utf8');
      for (let pass = 0; pass < 2; pass += 1) {
        for (const statement of migration.split('--> statement-breakpoint')) {
          if (statement.trim()) await client.query(statement);
        }
      }
      const columns = await client.query<{ column_name: string }>(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'platform_connector_oauth_states'
          AND column_name IN ('authorization_outcome', 'finished_at')
        ORDER BY column_name
      `);
      expect(columns.rows).toEqual([
        { column_name: 'authorization_outcome' },
        { column_name: 'finished_at' },
      ]);
      const constraint = await client.query<{ convalidated: boolean }>(`
        SELECT convalidated
        FROM pg_constraint
        WHERE conname = 'platform_connector_oauth_states_outcome_check'
          AND conrelid = 'platform_connector_oauth_states'::regclass
      `);
      expect(constraint.rows).toEqual([{ convalidated: true }]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
      await pool.end();
    }
  });
});
