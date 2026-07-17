// @vitest-environment node
import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '@/database/schemas';
import { platformConnectors } from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import { acquireConnectorPublicationDependencyLock } from '../connectorCatalog/publicationService';
import { acquirePlatformDependencyPublicationLock } from '../platformDependencyLock';

const enabled = process.env.TEST_SERVER_DB === '1' && Boolean(process.env.DATABASE_TEST_URL);
const run = enabled ? describe : describe.skip;

run('platform Agent / Connector dependency lock (PostgreSQL)', () => {
  const schemaName = `m10_p48a_${process.pid}_${randomUUID().replaceAll('-', '')}`;
  const adminPool = new Pool({ connectionString: process.env.DATABASE_TEST_URL });
  // Every transaction can use a different physical connection. Pin search_path
  // at connection startup so both contenders always address the same isolated schema.
  const pool = new Pool({
    connectionString: process.env.DATABASE_TEST_URL,
    options: `-c search_path=${schemaName}`,
  });
  const db = drizzle(pool, { schema }) as unknown as LobeChatDatabase;

  beforeAll(async () => {
    // The probe intentionally owns only two minimal tables. It exercises real
    // PostgreSQL row/advisory locks without depending on optional extensions.
    await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
    await db.execute(sql`
      CREATE TABLE platform_agents (
        id text PRIMARY KEY,
        agent_key text NOT NULL,
        draft_sequence integer NOT NULL DEFAULT 0,
        migration_required boolean NOT NULL DEFAULT false,
        revision integer NOT NULL DEFAULT 0
      )
    `);
    await db.execute(sql`
      CREATE TABLE platform_connectors (
        id text PRIMARY KEY,
        enabled boolean NOT NULL DEFAULT false,
        status text NOT NULL DEFAULT 'draft',
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE platform_agents, platform_connectors`);
  });

  afterAll(async () => {
    await pool.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await adminPool.end();
  });

  it('blocks Agent validation until Connector commits, then rejects the archived dependency', async () => {
    const connectorId = 'lock-probe-connector';
    const agentId = 'lock-probe-agent';
    await db.execute(
      sql`INSERT INTO platform_connectors (id, enabled, status) VALUES (${connectorId}, true, 'published')`,
    );
    await db.execute(
      sql`INSERT INTO platform_agents (id, agent_key) VALUES (${agentId}, 'lock-probe-agent')`,
    );

    let releaseConnector!: () => void;
    const connectorGate = new Promise<void>((resolve) => {
      releaseConnector = resolve;
    });
    let connectorLocked!: () => void;
    const connectorLockAcquired = new Promise<void>((resolve) => {
      connectorLocked = resolve;
    });
    const connectorMutation = db.transaction(async (tx) => {
      await tx
        .select({ id: platformConnectors.id })
        .from(platformConnectors)
        .where(eq(platformConnectors.id, connectorId))
        .for('update');
      await acquireConnectorPublicationDependencyLock(tx, connectorId, {});
      connectorLocked();
      await connectorGate;
      await tx
        .update(platformConnectors)
        .set({ enabled: false, status: 'archived' })
        .where(eq(platformConnectors.id, connectorId));
    });
    await connectorLockAcquired;

    let agentPassedSharedLock = false;
    const agentValidation = db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM platform_agents WHERE id = ${agentId} FOR UPDATE`);
      await acquirePlatformDependencyPublicationLock(tx);
      agentPassedSharedLock = true;
      const [current] = await tx
        .select({ status: platformConnectors.status })
        .from(platformConnectors)
        .where(eq(platformConnectors.id, connectorId));
      if (current?.status !== 'published') throw new Error('CONNECTOR_UNAVAILABLE');
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(agentPassedSharedLock).toBe(false);
    releaseConnector();
    await connectorMutation;
    await expect(agentValidation).rejects.toThrow('CONNECTOR_UNAVAILABLE');
    expect(agentPassedSharedLock).toBe(true);
  });
});
