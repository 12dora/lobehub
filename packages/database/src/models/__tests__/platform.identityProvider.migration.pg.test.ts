// @vitest-environment node
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { Pool, type PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';

const runPostgresMigration = process.env.TEST_SERVER_DB === '1';
const migrationPath = path.join(
  __dirname,
  '../../../migrations/0127_m11_oidc_provider_security_foundation.sql',
);

const restoreM10Shell = async (client: PoolClient) => {
  await client.query('TRUNCATE TABLE platform_identity_providers CASCADE');
  await client.query('DROP TABLE IF EXISTS platform_identity_provider_secrets CASCADE');
  for (const constraint of [
    'platform_identity_providers_key_check',
    'platform_identity_providers_type_check',
    'platform_identity_providers_status_check',
    'platform_identity_providers_revision_check',
    'platform_identity_providers_migration_state_check',
    'platform_identity_providers_secret_state_check',
    'platform_identity_providers_secret_ref_check',
    'platform_identity_providers_scopes_check',
    'platform_identity_providers_pkce_check',
    'platform_identity_providers_claim_mapping_check',
    'platform_identity_providers_policy_json_check',
  ]) {
    await client.query(
      `ALTER TABLE platform_identity_providers DROP CONSTRAINT IF EXISTS ${constraint}`,
    );
  }
  await client.query(`ALTER TABLE platform_identity_providers
    DROP COLUMN IF EXISTS migration_required,
    DROP COLUMN IF EXISTS secret_ref,
    DROP COLUMN IF EXISTS secret_updated_at,
    DROP COLUMN IF EXISTS enabled,
    DROP COLUMN IF EXISTS activation_revision`);
  await client.query(
    `ALTER TABLE platform_identity_providers ALTER COLUMN scopes TYPE text USING scopes::text`,
  );
  await client.query(
    `ALTER TABLE platform_identity_providers ALTER COLUMN button_label DROP NOT NULL`,
  );
};

describe.skipIf(!runPostgresMigration)('M11 PostgreSQL migration from the M10 shell', () => {
  it('preserves legacy ciphertext and long text while isolating and normalizing old rows twice', async () => {
    await getTestDB();
    const connectionString = process.env.DATABASE_TEST_URL;
    if (!connectionString) throw new Error('DATABASE_TEST_URL is required');
    const pool = new Pool({ connectionString, max: 1 });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await restoreM10Shell(client);
      const longText = 'x'.repeat(201);
      await client.query(
        `INSERT INTO platform_identity_providers
          (id, provider_key, type, display_name, button_label, discovery_url, client_id,
           encrypted_client_secret, secret_fingerprint, scopes, use_pkce, claim_mapping,
           domain_allowlist, group_role_mapping, status, revision)
         VALUES
          ('m11-legacy', 'Legacy Invalid Key', 'oidc', $1, $1,
           'https://legacy.example/.well-known/openid-configuration', 'legacy-client',
           'legacy-envelope-ciphertext', 'legacy-fingerprint', 'profile email', false,
           '"invalid-json-shape"'::jsonb, '"invalid"'::jsonb, '[]'::jsonb, 'active', -1)`,
        [longText],
      );

      const migration = await readFile(migrationPath, 'utf8');
      for (let pass = 0; pass < 2; pass += 1) {
        for (const statement of migration.split('--> statement-breakpoint')) {
          if (statement.trim()) await client.query(statement);
        }
      }

      const result = await client.query<{
        activation_revision: number | null;
        claim_mapping: Record<string, unknown>;
        discovery_url: string;
        display_name: string;
        enabled: boolean;
        encrypted_client_secret: string;
        migration_required: boolean;
        scopes: string[];
        secret_ref: string | null;
        status: string;
        use_pkce: boolean;
      }>(`SELECT activation_revision, claim_mapping, discovery_url, display_name, enabled,
                 encrypted_client_secret, migration_required, scopes, secret_ref, status, use_pkce
          FROM platform_identity_providers WHERE id = 'm11-legacy'`);
      expect(result.rows).toEqual([
        expect.objectContaining({
          activation_revision: null,
          discovery_url: 'https://legacy.example/.well-known/openid-configuration',
          display_name: longText,
          enabled: false,
          encrypted_client_secret: 'legacy-envelope-ciphertext',
          migration_required: true,
          scopes: ['openid', 'profile', 'email'],
          secret_ref: null,
          status: 'draft',
          use_pkce: true,
        }),
      ]);
      expect(Object.keys(result.rows[0]!.claim_mapping).sort()).toEqual([
        'dingtalkTitle',
        'dingtalkUserId',
        'email',
        'name',
        'picture',
        'subject',
      ]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
      await pool.end();
    }
  }, 20_000);
});
