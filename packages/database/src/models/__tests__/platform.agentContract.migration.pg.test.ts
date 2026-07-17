// @vitest-environment node
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { Pool, type PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';

const runPostgresMigration = process.env.TEST_SERVER_DB === '1';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const migrationPath = path.join(
  __dirname,
  '../../../migrations/0125_m10_platform_agent_contract_expand.sql',
);

const applyMigration = async (client: PoolClient) => {
  const migration = await readFile(migrationPath, 'utf8');
  for (const statement of migration.split('--> statement-breakpoint')) {
    if (statement.trim()) await client.query(statement);
  }
};

const restoreM01ShellInsideTransaction = async (client: PoolClient) => {
  for (const [trigger, table] of [
    ['platform_agent_assignments_target_guard', 'platform_agent_assignments'],
    ['rbac_roles_platform_agent_assignment_guard', 'rbac_roles'],
    ['users_platform_agent_assignment_guard', 'users'],
    ['agents_materialization_owner_guard', 'agents'],
    ['platform_agents_exact_published_pointer_guard', 'platform_agents'],
    ['platform_agent_versions_exact_insert_guard', 'platform_agent_versions'],
    ['platform_agent_versions_immutable', 'platform_agent_versions'],
  ]) {
    await client.query(`DROP TRIGGER IF EXISTS ${trigger} ON ${table}`);
  }
  await client.query('DROP TABLE IF EXISTS platform_user_agent_materializations CASCADE');
  await client.query(
    'TRUNCATE TABLE platform_agent_assignments, platform_agent_versions, platform_agents CASCADE',
  );
  for (const [table, constraints] of [
    [
      'platform_agent_assignments',
      [
        'platform_agent_assignments_pinned_version_same_agent_fk',
        'platform_agent_assignments_target_check',
        'platform_agent_assignments_mode_check',
        'platform_agent_assignments_version_policy_check',
      ],
    ],
    [
      'platform_agent_versions',
      [
        'platform_agent_versions_checksum_check',
        'platform_agent_versions_exact_snapshot_pair_check',
      ],
    ],
    [
      'platform_agents',
      [
        'platform_agents_current_version_same_agent_fk',
        'platform_agents_default_inbox_consistency_check',
        'platform_agents_published_pointer_check',
        'platform_agents_revision_check',
      ],
    ],
  ] as const) {
    for (const constraint of constraints) {
      await client.query(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${constraint}`);
    }
  }
  for (const index of [
    'platform_agent_versions_agent_id_id_unique',
    'platform_agent_versions_agent_id_id_checksum_unique',
    'platform_agents_current_version_id_idx',
  ]) {
    await client.query(`DROP INDEX IF EXISTS ${index}`);
  }
  await client.query(`ALTER TABLE platform_agent_assignments
    DROP COLUMN IF EXISTS mode,
    DROP COLUMN IF EXISTS version_policy,
    DROP COLUMN IF EXISTS pinned_version_id,
    DROP COLUMN IF EXISTS enabled`);
  await client.query(`ALTER TABLE platform_agent_versions
    DROP COLUMN IF EXISTS dependency_snapshot,
    DROP COLUMN IF EXISTS checksum`);
  await client.query(`ALTER TABLE platform_agents
    DROP COLUMN IF EXISTS migration_required,
    DROP COLUMN IF EXISTS current_version_id,
    DROP COLUMN IF EXISTS draft_sequence,
    DROP COLUMN IF EXISTS published_at`);
};

describe.skipIf(!runPostgresMigration)('M10 PostgreSQL migration from the M01 shell', () => {
  it('upgrades twice, isolates legacy rows, and enforces direct-SQL invariants', async () => {
    await getTestDB();
    const connectionString = process.env.DATABASE_TEST_URL;
    if (!connectionString) throw new Error('DATABASE_TEST_URL is required');
    const pool = new Pool({ connectionString, max: 1 });
    const client = await pool.connect();
    let savepoint = 0;
    const expectRejected = async (query: string) => {
      savepoint += 1;
      const name = `m10_reject_${savepoint}`;
      await client.query(`SAVEPOINT ${name}`);
      try {
        await client.query(query);
        throw new Error(`Expected query to fail: ${query}`);
      } catch (error) {
        await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
        expect(error).toBeInstanceOf(Error);
      } finally {
        await client.query(`RELEASE SAVEPOINT ${name}`);
      }
    };

    try {
      await client.query('BEGIN');
      await restoreM01ShellInsideTransaction(client);
      await client.query(`
        INSERT INTO platform_agents
          (id, agent_key, title, provider, model, system_role, status, current_version, is_default)
        VALUES
          ('m10-legacy', 'm10-legacy', 'Legacy title', 'legacy-provider', 'legacy-model',
           'Legacy prompt stays intact', 'published', '1.0.0', true)
      `);
      await client.query(`
        INSERT INTO platform_agent_versions (id, agent_id, version, config)
        VALUES ('m10-legacy-v1', 'm10-legacy', '1.0.0', '{"legacy":"config-stays"}')
      `);

      for (let pass = 0; pass < 2; pass += 1) {
        await applyMigration(client);
      }

      const legacy = await client.query<{
        config: unknown;
        current_version_id: string | null;
        dependency_snapshot: unknown;
        is_default: boolean;
        migration_required: boolean;
        status: string;
        version_checksum: string | null;
      }>(`
        SELECT agent.status, agent.migration_required, agent.is_default, agent.current_version_id,
               version.config, version.dependency_snapshot,
               version.checksum AS version_checksum
        FROM platform_agents agent
        JOIN platform_agent_versions version ON version.agent_id = agent.id
        WHERE agent.id = 'm10-legacy'
      `);
      expect(legacy.rows).toEqual([
        {
          config: { legacy: 'config-stays' },
          current_version_id: 'm10-legacy-v1',
          dependency_snapshot: null,
          is_default: false,
          migration_required: true,
          status: 'draft',
          version_checksum: null,
        },
      ]);

      await client.query(
        `INSERT INTO users (id) VALUES ('m10-user-a'), ('m10-user-b') ON CONFLICT DO NOTHING`,
      );
      await client.query(`
        INSERT INTO workspaces (id, name, slug, primary_owner_id)
        VALUES ('m10-workspace', 'M10 workspace', 'm10-workspace', 'm10-user-a')
        ON CONFLICT DO NOTHING
      `);
      await client.query(`
        INSERT INTO rbac_roles (id, name, display_name, workspace_id)
        VALUES
          ('m10-global-role', 'm10-global-role', 'M10 global role', NULL),
          ('m10-workspace-role', 'm10-workspace-role', 'M10 workspace role', 'm10-workspace')
      `);
      await client.query(`
        INSERT INTO platform_agents (id, agent_key, title)
        VALUES ('m10-agent-a', 'm10-agent-a', 'Agent A'), ('m10-agent-b', 'm10-agent-b', 'Agent B')
      `);
      const config = JSON.stringify({ displayName: 'Agent', systemRole: 'Safe' });
      const snapshot = JSON.stringify({
        connectors: [],
        model: {
          modelKey: 'm',
          providerChecksum: SHA_A,
          providerKey: 'p',
          providerRevision: 1,
        },
        skills: [],
      });
      await expectRejected(`INSERT INTO platform_agent_versions
        (id, agent_id, version, config)
        VALUES ('m10-loose-version', 'm10-agent-a', '0.1.0', '{}')`);
      await expectRejected(`UPDATE platform_agents
        SET migration_required = false, status = 'published', published_at = now()
        WHERE id = 'm10-legacy'`);
      await client.query(
        `
        INSERT INTO platform_agent_versions
          (id, agent_id, version, config, dependency_snapshot, checksum)
        VALUES
          ('m10-version-a', 'm10-agent-a', '1.0.0', $1, $2, '${SHA_A}'),
          ('m10-version-b', 'm10-agent-b', '1.0.0', $1, $2, '${SHA_B}')
      `,
        [config, snapshot],
      );
      await client.query(`
        INSERT INTO agents (id, user_id, title)
        VALUES ('m10-local-a', 'm10-user-a', 'Local A'), ('m10-local-b', 'm10-user-b', 'Local B')
      `);

      await expectRejected(`INSERT INTO platform_agent_assignments
        (id, agent_id, target_type, target_id)
        VALUES ('m10-bad-role', 'm10-agent-a', 'global_role', 'm10-workspace-role')`);
      await client.query(`INSERT INTO platform_agent_assignments
        (id, agent_id, target_type, target_id)
        VALUES ('m10-global-assignment', 'm10-agent-a', 'global_role', 'm10-global-role')`);
      await expectRejected(
        `UPDATE rbac_roles SET workspace_id = 'm10-workspace' WHERE id = 'm10-global-role'`,
      );
      await expectRejected(`DELETE FROM rbac_roles WHERE id = 'm10-global-role'`);

      await client.query(`INSERT INTO platform_agent_assignments
        (id, agent_id, target_type, target_id)
        VALUES ('m10-user-assignment', 'm10-agent-a', 'user', 'm10-user-b')`);
      await expectRejected(`UPDATE users SET id = 'm10-user-b-renamed' WHERE id = 'm10-user-b'`);
      await expectRejected(`DELETE FROM users WHERE id = 'm10-user-b'`);

      await expectRejected(`INSERT INTO platform_user_agent_materializations
        (id, user_id, platform_agent_id, platform_agent_version_id,
         platform_agent_version_checksum, materialized_agent_id)
        VALUES ('m10-cross-owner', 'm10-user-a', 'm10-agent-a', 'm10-version-a',
                '${SHA_A}', 'm10-local-b')`);
      await client.query(`INSERT INTO platform_user_agent_materializations
        (id, user_id, platform_agent_id, platform_agent_version_id,
         platform_agent_version_checksum, materialized_agent_id, status)
        VALUES ('m10-materialized', 'm10-user-a', 'm10-agent-a', 'm10-version-a',
                '${SHA_A}', 'm10-local-a', 'materialized')`);
      await expectRejected(`UPDATE agents SET user_id = 'm10-user-b' WHERE id = 'm10-local-a'`);
      await expectRejected(`INSERT INTO platform_user_agent_materializations
        (id, user_id, platform_agent_id, platform_agent_version_id,
         platform_agent_version_checksum, materialized_agent_id)
        VALUES ('m10-local-reuse', 'm10-user-a', 'm10-agent-b', 'm10-version-b',
                '${SHA_B}', 'm10-local-a')`);
      await expectRejected(`UPDATE platform_agents SET current_version_id = 'm10-version-b'
        WHERE id = 'm10-agent-a'`);
      await expectRejected(`INSERT INTO platform_agent_assignments
        (id, agent_id, target_type, target_id, version_policy, pinned_version_id)
        VALUES ('m10-cross-pin', 'm10-agent-a', 'global', '__global__', 'pinned', 'm10-version-b')`);
      await expectRejected(`UPDATE platform_agent_versions SET version = '2.0.0'
        WHERE id = 'm10-version-a'`);
    } finally {
      await client.query('ROLLBACK');
      client.release();
      await pool.end();
    }
  }, 30_000);

  it('serializes target and owner validation against concurrent reverse updates', async () => {
    await getTestDB();
    const connectionString = process.env.DATABASE_TEST_URL;
    if (!connectionString) throw new Error('DATABASE_TEST_URL is required');
    const pool = new Pool({ connectionString, max: 3 });
    const setup = await pool.connect();
    const writer = await pool.connect();
    const reverser = await pool.connect();
    let cleanupError: unknown;
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const ids = {
      agent: `m10-race-agent-${suffix}`,
      assignment: `m10-race-assignment-${suffix}`,
      localAgent: `m10-race-local-${suffix}`,
      materialization: `m10-race-materialization-${suffix}`,
      role: `m10-race-role-${suffix}`,
      userA: `m10-race-user-a-${suffix}`,
      userB: `m10-race-user-b-${suffix}`,
      version: `m10-race-version-${suffix}`,
      workspace: `m10-race-workspace-${suffix}`,
    };
    const waitForBlock = async <T>(operation: Promise<T>) =>
      Promise.race([
        operation.then(
          () => 'settled' as const,
          () => 'settled' as const,
        ),
        new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 100)),
      ]);

    try {
      // The shared test database may already record an earlier development copy of
      // 0125. Replaying this expand-only migration updates replaceable functions
      // before opening the two concurrent transactions.
      await applyMigration(setup);
      await setup.query(`INSERT INTO users (id) VALUES ($1), ($2)`, [ids.userA, ids.userB]);
      await setup.query(
        `INSERT INTO workspaces (id, name, slug, primary_owner_id) VALUES ($1, $2, $3, $4)`,
        [ids.workspace, 'M10 race workspace', ids.workspace, ids.userA],
      );
      await setup.query(`INSERT INTO rbac_roles (id, name, display_name) VALUES ($1, $2, $3)`, [
        ids.role,
        ids.role,
        'M10 race role',
      ]);
      await setup.query(`INSERT INTO platform_agents (id, agent_key, title) VALUES ($1, $2, $3)`, [
        ids.agent,
        ids.agent,
        'M10 race Agent',
      ]);
      await setup.query(
        `INSERT INTO platform_agent_versions
          (id, agent_id, version, config, dependency_snapshot, checksum)
         VALUES ($1, $2, '1.0.0', '{}', $3, $4)`,
        [
          ids.version,
          ids.agent,
          {
            connectors: [],
            model: {
              modelKey: 'm',
              providerChecksum: SHA_A,
              providerKey: 'p',
              providerRevision: 1,
            },
            skills: [],
          },
          SHA_A,
        ],
      );
      await setup.query(`INSERT INTO agents (id, user_id, title) VALUES ($1, $2, $3)`, [
        ids.localAgent,
        ids.userA,
        'M10 race local Agent',
      ]);

      await writer.query('BEGIN');
      await writer.query(
        `INSERT INTO platform_agent_assignments
          (id, agent_id, target_type, target_id)
         VALUES ($1, $2, 'global_role', $3)`,
        [ids.assignment, ids.agent, ids.role],
      );
      await reverser.query('BEGIN');
      const roleOutcome = reverser
        .query(`UPDATE rbac_roles SET workspace_id = $1 WHERE id = $2`, [ids.workspace, ids.role])
        .then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ error, ok: false as const }),
        );
      expect(await waitForBlock(roleOutcome)).toBe('blocked');
      await writer.query('COMMIT');
      const roleResult = await roleOutcome;
      expect(roleResult.ok).toBe(false);
      if (!roleResult.ok) expect(roleResult.error).toBeInstanceOf(Error);
      await reverser.query('ROLLBACK');

      await writer.query('BEGIN');
      await writer.query(
        `INSERT INTO platform_user_agent_materializations
          (id, user_id, platform_agent_id, platform_agent_version_id,
           platform_agent_version_checksum, materialized_agent_id, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'materialized')`,
        [ids.materialization, ids.userA, ids.agent, ids.version, SHA_A, ids.localAgent],
      );
      await reverser.query('BEGIN');
      const ownerOutcome = reverser
        .query(`UPDATE agents SET user_id = $1 WHERE id = $2`, [ids.userB, ids.localAgent])
        .then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ error, ok: false as const }),
        );
      expect(await waitForBlock(ownerOutcome)).toBe('blocked');
      await writer.query('COMMIT');
      const ownerResult = await ownerOutcome;
      expect(ownerResult.ok).toBe(false);
      if (!ownerResult.ok) expect(ownerResult.error).toBeInstanceOf(Error);
      await reverser.query('ROLLBACK');
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined);
      await reverser.query('ROLLBACK').catch(() => undefined);
      await setup.query('BEGIN');
      try {
        await setup.query(`DELETE FROM platform_user_agent_materializations WHERE id = $1`, [
          ids.materialization,
        ]);
        await setup.query(`DELETE FROM platform_agent_assignments WHERE id = $1`, [ids.assignment]);
        await setup.query(`ALTER TABLE platform_agent_versions DISABLE TRIGGER USER`);
        await setup.query(`DELETE FROM platform_agent_versions WHERE id = $1`, [ids.version]);
        await setup.query(`ALTER TABLE platform_agent_versions ENABLE TRIGGER USER`);
        await setup.query(`DELETE FROM platform_agents WHERE id = $1`, [ids.agent]);
        await setup.query(`DELETE FROM agents WHERE id = $1`, [ids.localAgent]);
        await setup.query(`DELETE FROM rbac_roles WHERE id = $1`, [ids.role]);
        await setup.query(`DELETE FROM workspaces WHERE id = $1`, [ids.workspace]);
        await setup.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[ids.userA, ids.userB]]);
        await setup.query('COMMIT');
      } catch (error) {
        await setup.query('ROLLBACK');
        cleanupError = error;
      }
      setup.release();
      writer.release();
      reverser.release();
      await pool.end();
    }
    if (cleanupError) throw cleanupError;
  }, 30_000);
});
