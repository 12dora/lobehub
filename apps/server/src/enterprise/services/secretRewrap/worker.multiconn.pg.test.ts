/**
 * TRUE multi-connection PostgreSQL evidence for the secret rewrap lease and expression index.
 * Runs only with TEST_SERVER_DB=1 plus DATABASE_TEST_URL. PGlite cannot prove independent-session
 * `FOR UPDATE SKIP LOCKED` behavior, so the default suite intentionally does not claim that proof.
 *
 * @vitest-environment node
 */
import { randomBytes } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import * as schema from '@/database/schemas';
import { platformConnectors, platformConnectorSecrets, platformJobs } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import {
  type KekMaterial,
  type KeyProvider,
  PlatformSecretService,
} from '@/server/enterprise/security/secret';

import { PlatformSecretRewrapCoordinator } from './coordinator';
import { processNextPlatformSecretRewrapBatch } from './worker';

const enabled = process.env.TEST_SERVER_DB === '1' && Boolean(process.env.DATABASE_TEST_URL);
const run = enabled ? describe : describe.skip;
const oldKeyId = 'vault:pg-old';
const targetKeyId = 'vault:pg-target';

class PgVaultProvider implements KeyProvider {
  activeKeyId = oldKeyId;
  readonly providerId = 'vault';
  readonly #keys = new Map([
    [oldKeyId, randomBytes(32)],
    [targetKeyId, randomBytes(32)],
  ]);

  getKek = async (keyId?: string): Promise<KekMaterial> => {
    const resolvedKeyId = keyId ?? this.activeKeyId;
    const key = this.#keys.get(resolvedKeyId);
    if (!key) throw new Error('test key is missing');
    return { key: new Uint8Array(key), keyId: resolvedKeyId };
  };
}

run('Platform secret rewrap — true multi-connection PostgreSQL', () => {
  const connectionString = process.env.DATABASE_TEST_URL!;
  const pools: Pool[] = [];
  const provider = new PgVaultProvider();
  const secrets = new PlatformSecretService({ keyProvider: provider });
  const coordinator = new PlatformSecretRewrapCoordinator(secrets);
  let db: LobeChatDatabase;

  const workerDb = (): LobeChatDatabase => {
    const pool = new Pool({ connectionString, max: 1 });
    pools.push(pool);
    return drizzle(pool, { schema }) as unknown as LobeChatDatabase;
  };
  const cleanup = () =>
    db.execute(sql`
      TRUNCATE TABLE ${platformJobs}, ${platformConnectorSecrets}, ${platformConnectors}
      RESTART IDENTITY CASCADE
    `);

  beforeAll(async () => {
    db = await getTestDB();
  });
  beforeEach(async () => {
    await cleanup();
    provider.activeKeyId = oldKeyId;
    await db.insert(platformConnectors).values({
      connectorKey: 'pg-connector',
      displayName: 'PG connector',
      id: 'pg-connector',
      legacyName: 'PG connector',
      migrationRequired: true,
    });
    await db.insert(platformConnectorSecrets).values({
      ciphertext: await secrets.encrypt('pg-secret'),
      connectorId: 'pg-connector',
      fingerprint: 'a'.repeat(64),
      id: 'pg-secret',
      keyId: oldKeyId,
      ref: 'kms://platform-connectors/pg-connector/shared',
      revision: 1,
      slot: 'sharedSecret',
    });
    provider.activeKeyId = targetKeyId;
    await coordinator.enqueue(db, {
      reason: 'real PostgreSQL lease evidence',
      requestId: '33333333-3333-4333-8333-333333333333',
      requestedBy: 'pg-internal-test',
      targetKeyId,
    });
  });
  afterEach(async () => {
    await Promise.all(pools.splice(0).map((pool) => pool.end()));
    await cleanup();
  });
  afterAll(async () => {
    await Promise.all(pools.splice(0).map((pool) => pool.end()));
  });

  it('lets exactly one independent worker claim and checkpoint one parent', async () => {
    const results = await Promise.all([
      processNextPlatformSecretRewrapBatch(workerDb(), secrets, 'pg-worker-a'),
      processNextPlatformSecretRewrapBatch(workerDb(), secrets, 'pg-worker-b'),
    ]);
    expect(results.filter(({ claimed }) => claimed)).toHaveLength(1);
    const [stored] = await db
      .select()
      .from(platformConnectorSecrets)
      .where(eq(platformConnectorSecrets.id, 'pg-secret'));
    expect(stored.keyId).toBe(targetKeyId);
    expect(secrets.peekKeyId(stored.ciphertext)).toBe(targetKeyId);
  });

  it('installs the failed-ledger partial expression index', async () => {
    const pool = new Pool({ connectionString, max: 1 });
    pools.push(pool);
    const result = await pool.query<{ indexname: string }>(`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND indexname = 'platform_jobs_secret_rewrap_failure_parent_domain_row_idx'
    `);
    expect(result.rows.map(({ indexname }) => indexname)).toEqual([
      'platform_jobs_secret_rewrap_failure_parent_domain_row_idx',
    ]);
  });
});
