// @vitest-environment node
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { platformInstanceHeartbeats, platformInstanceRevisionStates } from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';
import {
  PLATFORM_INSTANCE_HEARTBEAT_INTERVAL_MS,
  PLATFORM_INSTANCE_STALE_AFTER_MS,
  PlatformInstanceRepository,
} from '.';

const db: LobeChatDatabase = await getTestDB();
const repository = new PlatformInstanceRepository(db);
const instanceId = (digit: string) => `pinst_${digit.repeat(48)}`;

const cleanup = async () => {
  await db.delete(platformInstanceRevisionStates);
  await db.delete(platformInstanceHeartbeats);
};

beforeEach(cleanup);
afterEach(cleanup);

describe('PlatformInstanceRepository', () => {
  it('uses the fixed 30 second heartbeat and 90 second freshness windows', () => {
    expect(PLATFORM_INSTANCE_HEARTBEAT_INTERVAL_MS).toBe(30_000);
    expect(PLATFORM_INSTANCE_STALE_AFTER_MS).toBe(90_000);
  });

  it('registers idempotently without changing process start time', async () => {
    const id = instanceId('1');
    await repository.registerInstance(id);
    await db
      .update(platformInstanceHeartbeats)
      .set({
        lastHeartbeatAt: sql`statement_timestamp() - interval '5 minutes'`,
        startedAt: sql`statement_timestamp() - interval '5 minutes'`,
      })
      .where(eq(platformInstanceHeartbeats.instanceId, id));

    const registered = await repository.registerInstance(id);

    expect(registered.startedAt.getTime()).toBeLessThan(Date.now() - 4 * 60_000);
    expect(registered.lastHeartbeatAt.getTime()).toBeLessThan(Date.now() - 4 * 60_000);
    expect(await db.select().from(platformInstanceHeartbeats)).toHaveLength(1);
  });

  it('converges concurrent heartbeat upserts to one row and preserves startedAt', async () => {
    const id = instanceId('2');
    const initial = await repository.registerInstance(id);

    const beats = await Promise.all(
      Array.from({ length: 12 }, () => repository.upsertHeartbeat(id)),
    );

    expect(new Set(beats.map((beat) => beat.instanceId))).toEqual(new Set([id]));
    const rows = await db.select().from(platformInstanceHeartbeats);
    expect(rows).toHaveLength(1);
    expect(rows[0].startedAt).toEqual(initial.startedAt);
    expect(rows[0].lastHeartbeatAt.getTime()).toBeGreaterThanOrEqual(
      initial.lastHeartbeatAt.getTime(),
    );
  });

  it('derives freshness from the database clock without deleting stale rows', async () => {
    const staleId = instanceId('3');
    const freshId = instanceId('4');
    await Promise.all([repository.registerInstance(staleId), repository.upsertHeartbeat(freshId)]);
    await db
      .update(platformInstanceHeartbeats)
      .set({
        lastHeartbeatAt: sql`statement_timestamp() - interval '91 seconds'`,
        startedAt: sql`statement_timestamp() - interval '5 minutes'`,
      })
      .where(eq(platformInstanceHeartbeats.instanceId, staleId));

    expect((await repository.listFreshInstances()).map(({ instanceId }) => instanceId)).toEqual([
      freshId,
    ]);
    expect(await db.select().from(platformInstanceHeartbeats)).toHaveLength(2);
  });

  it('upserts normalized revision state with database-authored loadedAt', async () => {
    const id = instanceId('5');
    await repository.registerInstance(id);
    const initial = await repository.upsertRevisionState({
      domain: 'settings',
      health: 'healthy',
      instanceId: id,
      loadedRevision: 1,
      loadMode: 'process_cached',
      source: 'database',
    });
    await db
      .update(platformInstanceRevisionStates)
      .set({ loadedAt: sql`clock_timestamp() - interval '1 day'` })
      .where(eq(platformInstanceRevisionStates.instanceId, id));

    const updated = await repository.upsertRevisionState({
      domain: 'settings',
      health: 'degraded',
      errorCategory: 'cache_unavailable',
      instanceId: id,
      loadedRevision: 2,
      loadedRevisionId: 'settings:2',
      loadMode: 'process_cached',
      source: 'lkg',
    });

    expect(updated.loadedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(updated.loadedAt.getTime()).toBeGreaterThan(initial.loadedAt.getTime());
    expect(updated).toMatchObject({
      errorCategory: 'cache_unavailable',
      health: 'degraded',
      loadedRevision: 2,
      loadedRevisionId: 'settings:2',
      source: 'lkg',
    });
    expect(await repository.listRevisionStates(id)).toEqual([updated]);
  });

  it('keeps one row per instance and domain under concurrent state reports', async () => {
    const id = instanceId('6');
    await repository.registerInstance(id);

    await Promise.all(
      Array.from({ length: 10 }, (_, loadedRevision) =>
        repository.upsertRevisionState({
          domain: 'ai_catalog',
          health: 'healthy',
          instanceId: id,
          loadedRevision,
          loadMode: 'process_cached',
          source: 'cache',
        }),
      ),
    );

    const states = await repository.listRevisionStates(id);
    expect(states).toHaveLength(1);
    expect(states[0].domain).toBe('ai_catalog');
  });
});
