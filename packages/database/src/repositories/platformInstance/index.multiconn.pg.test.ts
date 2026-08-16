// @vitest-environment node
import { randomUUID } from 'node:crypto';

import { and, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { ensureServerTestDatabase } from '../../../tests/ensureServerTestDatabase';
import * as schema from '../../schemas';
import { platformInstanceHeartbeats, platformInstanceRevisionStates } from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';
import { PlatformInstanceRepository } from '.';

const enabled = process.env.TEST_SERVER_DB === '1' && Boolean(process.env.DATABASE_TEST_URL);

describe.skipIf(!enabled)('PlatformInstanceRepository PostgreSQL multi-connection', () => {
  it('converges independent connection upserts without duplicating inventory or state', async () => {
    const connectionString = process.env.DATABASE_TEST_URL;
    if (!connectionString) throw new Error('DATABASE_TEST_URL is required');
    await ensureServerTestDatabase(connectionString);
    const firstPool = new Pool({ connectionString, max: 1 });
    const secondPool = new Pool({ connectionString, max: 1 });
    const firstDb = drizzle(firstPool, { schema }) as unknown as LobeChatDatabase;
    const secondDb = drizzle(secondPool, { schema }) as unknown as LobeChatDatabase;
    const testNamespace = randomUUID().replaceAll('-', '');
    const id = `pinst_${testNamespace}${testNamespace.slice(0, 16)}`;

    try {
      const first = new PlatformInstanceRepository(firstDb);
      const second = new PlatformInstanceRepository(secondDb);

      await Promise.all([first.upsertHeartbeat(id), second.upsertHeartbeat(id)]);
      await Promise.all([
        first.upsertRevisionState({
          domain: 'settings',
          health: 'healthy',
          instanceId: id,
          loadedRevision: 1,
          loadMode: 'process_cached',
          source: 'database',
        }),
        second.upsertRevisionState({
          domain: 'settings',
          health: 'healthy',
          instanceId: id,
          loadedRevision: 2,
          loadMode: 'process_cached',
          source: 'cache',
        }),
      ]);

      expect(
        await firstDb
          .select()
          .from(platformInstanceHeartbeats)
          .where(eq(platformInstanceHeartbeats.instanceId, id)),
      ).toHaveLength(1);
      expect(
        await firstDb
          .select()
          .from(platformInstanceRevisionStates)
          .where(
            and(
              eq(platformInstanceRevisionStates.instanceId, id),
              eq(platformInstanceRevisionStates.domain, 'settings'),
            ),
          ),
      ).toHaveLength(1);
    } finally {
      await firstDb
        .delete(platformInstanceRevisionStates)
        .where(
          and(
            eq(platformInstanceRevisionStates.instanceId, id),
            eq(platformInstanceRevisionStates.domain, 'settings'),
          ),
        );
      await firstDb
        .delete(platformInstanceHeartbeats)
        .where(eq(platformInstanceHeartbeats.instanceId, id));
      await Promise.all([firstPool.end(), secondPool.end()]);
    }
  }, 20_000);

  it('never purges a stale registration another connection is refreshing mid-pass', async () => {
    const connectionString = process.env.DATABASE_TEST_URL;
    if (!connectionString) throw new Error('DATABASE_TEST_URL is required');
    await ensureServerTestDatabase(connectionString);
    const reaperPool = new Pool({ connectionString, max: 1 });
    const writerPool = new Pool({ connectionString, max: 1 });
    const reaperDb = drizzle(reaperPool, { schema }) as unknown as LobeChatDatabase;
    const namespace = randomUUID().replaceAll('-', '');
    const refreshed = `pinst_${namespace}${namespace.slice(0, 16)}`;
    const abandoned = `pinst_${namespace.slice(0, 16)}${namespace}`;
    const seeded = [refreshed, abandoned];
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const writer = await writerPool.connect();

    try {
      await reaperDb.insert(platformInstanceHeartbeats).values(
        seeded.map((instanceId) => ({
          instanceId,
          lastHeartbeatAt: new Date(cutoff.getTime() - 60_000),
        })),
      );

      // The heartbeat runtime refreshes rows without the reaper's locks: hold one refresh open so
      // the purge observes a candidate that is turning live while the pass runs.
      await writer.query('BEGIN');
      await writer.query(
        'UPDATE platform_instance_heartbeats SET last_heartbeat_at = now() WHERE instance_id = $1',
        [refreshed],
      );

      const purged = await new PlatformInstanceRepository(reaperDb).purgeOfflineInstances({
        cutoff,
        limit: 100,
      });
      await writer.query('COMMIT');

      expect(purged.platformInstances).toBeGreaterThanOrEqual(1);
      const survivors = await reaperDb
        .select()
        .from(platformInstanceHeartbeats)
        .where(inArray(platformInstanceHeartbeats.instanceId, seeded));
      expect(survivors.map(({ instanceId }) => instanceId)).toEqual([refreshed]);
      expect(survivors[0]?.lastHeartbeatAt.getTime()).toBeGreaterThan(cutoff.getTime());
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined);
      writer.release();
      await reaperDb
        .delete(platformInstanceHeartbeats)
        .where(inArray(platformInstanceHeartbeats.instanceId, seeded));
      await Promise.all([reaperPool.end(), writerPool.end()]);
    }
  }, 20_000);
});
