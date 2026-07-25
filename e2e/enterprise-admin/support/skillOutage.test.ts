/**
 * Behavioral coverage for skill-catalog outage induction/restore.
 * Uses owned disposable Postgres + Redis (never source-text introspection).
 */
import Redis from 'ioredis';
import { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';

import {
  cleanupLifecycle,
  createLifecycleState,
  createRunToken,
  inspectPublishedHostPort,
  type LifecycleState,
  startOwnedContainer,
} from './lifecycle';
import { createCasMinimalSchema } from './seed.casHarness';
import {
  countUserSkillArtifacts,
  induceSkillCatalogOutage,
  OUTAGE_SKILL_ID,
  OUTAGE_SKILL_KEY,
  restoreSkillCatalogOutage,
} from './skillOutage';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const waitForPostgres = async (url: string) => {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 1500 });
    try {
      await pool.query('SELECT 1');
      await pool.end();
      return;
    } catch {
      await pool.end().catch(() => undefined);
      await sleep(400);
    }
  }
  throw new Error('Postgres not ready');
};

const waitForRedis = async (url: string) => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const client = new Redis(url, { connectTimeout: 1500, maxRetriesPerRequest: 1 });
    try {
      const pong = await client.ping();
      client.disconnect();
      if (pong === 'PONG') return;
    } catch {
      client.disconnect();
      await sleep(200);
    }
  }
  throw new Error('Redis not ready');
};

describe('skill catalog outage mechanism (DB + Redis behavior)', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const stop = cleanups.pop()!;
      await stop().catch(() => undefined);
    }
  }, 60_000);

  it('induces probe row + three epoch bumps, restore removes row and bumps again', async () => {
    const runToken = createRunToken();
    const state: LifecycleState = createLifecycleState(runToken);
    cleanups.push(async () => cleanupLifecycle(state));

    const pg = await startOwnedContainer({
      args: [
        '-e',
        'POSTGRES_PASSWORD=postgres',
        '-e',
        'POSTGRES_DB=skill_outage',
        '-p',
        '127.0.0.1::5432',
      ],
      image: 'paradedb/paradedb:latest-pg17',
      name: `aihub-skill-outage-pg-${runToken.slice(-10)}`,
      runToken,
      state,
    });
    const redis = await startOwnedContainer({
      args: ['-p', '127.0.0.1::6379'],
      image: 'redis:7-alpine',
      name: `aihub-skill-outage-redis-${runToken.slice(-10)}`,
      runToken,
      state,
    });

    const pgPort = await inspectPublishedHostPort(pg.id, 5432);
    const redisPort = await inspectPublishedHostPort(redis.id, 6379);
    const databaseUrl = `postgresql://postgres:postgres@127.0.0.1:${pgPort}/skill_outage`;
    const redisUrl = `redis://127.0.0.1:${redisPort}`;

    await waitForPostgres(databaseUrl);
    await waitForRedis(redisUrl);
    await createCasMinimalSchema(databaseUrl);

    // Expand minimal platform_skills columns used by induce INSERT.
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      await pool.query(`
        ALTER TABLE platform_skills
          ADD COLUMN IF NOT EXISTS name text,
          ADD COLUMN IF NOT EXISTS description text,
          ADD COLUMN IF NOT EXISTS source text,
          ADD COLUMN IF NOT EXISTS distribution text,
          ADD COLUMN IF NOT EXISTS allow_builtin_override boolean,
          ADD COLUMN IF NOT EXISTS enabled boolean,
          ADD COLUMN IF NOT EXISTS current_version_id text,
          ADD COLUMN IF NOT EXISTS status text,
          ADD COLUMN IF NOT EXISTS revision int,
          ADD COLUMN IF NOT EXISTS draft_sequence int,
          ADD COLUMN IF NOT EXISTS created_at timestamptz,
          ADD COLUMN IF NOT EXISTS updated_at timestamptz;
        CREATE TABLE IF NOT EXISTS agent_skills (
          id text PRIMARY KEY,
          user_id text,
          identifier text
        );
        CREATE TABLE IF NOT EXISTS documents (
          id text PRIMARY KEY,
          user_id text
        );
      `);
    } finally {
      await pool.end();
    }

    const redisClient = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    const beforeEpochs = {
      catalog: Number((await redisClient.get('platform:config:scope:skill-catalog:version')) ?? 0),
      managed: Number((await redisClient.get('platform:config:scope:managed-policy:version')) ?? 0),
      runtime: Number((await redisClient.get('platform:config:scope:skill-runtime:version')) ?? 0),
    };

    const handle = await induceSkillCatalogOutage({ databaseUrl, redisUrl });

    const afterInduce = new Pool({ connectionString: databaseUrl });
    try {
      const row = await afterInduce.query(
        `SELECT id, skill_key, revision, current_version_id, status
           FROM platform_skills WHERE id = $1 OR skill_key = $2`,
        [OUTAGE_SKILL_ID, OUTAGE_SKILL_KEY],
      );
      expect(row.rows).toHaveLength(1);
      expect(row.rows[0].id).toBe(OUTAGE_SKILL_ID);
      expect(row.rows[0].skill_key).toBe(OUTAGE_SKILL_KEY);
      expect(Number(row.rows[0].revision)).toBe(1);
      expect(row.rows[0].current_version_id).toBeNull();
    } finally {
      await afterInduce.end();
    }

    expect(Number(await redisClient.get('platform:config:scope:skill-catalog:version'))).toBe(
      beforeEpochs.catalog + 1,
    );
    expect(Number(await redisClient.get('platform:config:scope:skill-runtime:version'))).toBe(
      beforeEpochs.runtime + 1,
    );
    expect(Number(await redisClient.get('platform:config:scope:managed-policy:version'))).toBe(
      beforeEpochs.managed + 1,
    );

    await handle.restore();

    const afterRestore = new Pool({ connectionString: databaseUrl });
    try {
      const gone = await afterRestore.query(
        `SELECT id FROM platform_skills WHERE id = $1 OR skill_key = $2`,
        [OUTAGE_SKILL_ID, OUTAGE_SKILL_KEY],
      );
      expect(gone.rows).toHaveLength(0);
    } finally {
      await afterRestore.end();
    }

    expect(Number(await redisClient.get('platform:config:scope:skill-catalog:version'))).toBe(
      beforeEpochs.catalog + 2,
    );
    expect(Number(await redisClient.get('platform:config:scope:skill-runtime:version'))).toBe(
      beforeEpochs.runtime + 2,
    );
    expect(Number(await redisClient.get('platform:config:scope:managed-policy:version'))).toBe(
      beforeEpochs.managed + 2,
    );

    // Artifact counter: hard-fail path not exercised here; empty user yields empty inventories.
    const empty = await countUserSkillArtifacts(databaseUrl, 'user_missing', 'never-created');
    expect(empty.agentSkillIds).toEqual([]);
    expect(empty.documentIds).toEqual([]);
    expect(empty.matchingIdentifiers).toEqual([]);

    // Double restore is idempotent (no residual probe).
    await restoreSkillCatalogOutage({ databaseUrl, redisUrl });

    redisClient.disconnect();
  }, 120_000);
});
