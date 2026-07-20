// @vitest-environment node
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { platformInstanceHeartbeats, platformInstanceRevisionStates } from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';
import {
  PLATFORM_INSTANCE_FRESH_DIAGNOSTIC_CANDIDATE_LIMIT,
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

  it('uses one supplied database-clock boundary and excludes stale states from convergence', async () => {
    const snapshotAt = new Date('2030-01-01T00:10:00.000Z');
    const cutoff = new Date(snapshotAt.getTime() - PLATFORM_INSTANCE_STALE_AFTER_MS);
    const ids = [instanceId('a'), instanceId('b'), instanceId('c')];
    await db.insert(platformInstanceHeartbeats).values(
      ids.map((id, index) => ({
        instanceId: id,
        lastHeartbeatAt: new Date(cutoff.getTime() - (index === 0 ? 0 : index === 1 ? 1 : -1)),
        startedAt: new Date(cutoff.getTime() - 10_000),
      })),
    );
    await db.insert(platformInstanceRevisionStates).values([
      {
        domain: 'settings',
        health: 'healthy',
        instanceId: ids[0],
        loadedRevision: 2,
        loadMode: 'process_cached',
        source: 'database',
      },
      {
        domain: 'settings',
        health: 'degraded',
        errorCategory: 'cache_unavailable',
        instanceId: ids[1],
        loadedRevision: 1,
        loadMode: 'process_cached',
        source: 'lkg',
      },
    ]);

    const snapshot = await repository.getConvergenceInventorySnapshot(
      [
        {
          domain: 'settings',
          loadMode: 'process_cached',
          status: 'available',
          token: { kind: 'revision', value: 2 },
        },
      ],
      snapshotAt,
    );

    expect(snapshot).toMatchObject({ freshCount: 2, snapshotAt, staleCount: 1 });
    expect(snapshot.counts[0]).toEqual({
      counts: {
        degraded: 0,
        diverged: 0,
        fresh: 2,
        matching: 1,
        stale: 1,
        unreported: 1,
      },
      domain: 'settings',
    });
  });

  it('keeps exact counts while bounding and ordering fresh diagnostics issue-first', async () => {
    const snapshotAt = new Date('2030-01-01T00:10:00.000Z');
    const total = PLATFORM_INSTANCE_FRESH_DIAGNOSTIC_CANDIDATE_LIMIT + 4;
    const ids = Array.from(
      { length: total },
      (_, index) => `pinst_${index.toString(16).padStart(48, '0')}`,
    );
    await db.insert(platformInstanceHeartbeats).values(
      ids.map((id, index) => ({
        instanceId: id,
        lastHeartbeatAt: new Date(snapshotAt.getTime() - index * 100),
        startedAt: new Date(snapshotAt.getTime() - 120_000),
      })),
    );
    await db.insert(platformInstanceRevisionStates).values(
      ids.map((id, index) => ({
        domain: 'settings' as const,
        health: 'healthy' as const,
        instanceId: id,
        loadedRevision: index === total - 1 ? 1 : 2,
        loadMode: 'process_cached' as const,
        source: 'database' as const,
      })),
    );

    const snapshot = await repository.getConvergenceInventorySnapshot(
      [
        {
          domain: 'settings',
          loadMode: 'process_cached',
          status: 'available',
          token: { kind: 'revision', value: 2 },
        },
      ],
      snapshotAt,
    );

    expect(snapshot.freshCount).toBe(total);
    expect(snapshot.freshCandidates).toHaveLength(
      PLATFORM_INSTANCE_FRESH_DIAGNOSTIC_CANDIDATE_LIMIT,
    );
    expect(snapshot.freshCandidates[0]?.instance.instanceId).toBe(ids.at(-1));
    expect(snapshot.counts[0]?.counts).toMatchObject({ diverged: 1, matching: total - 1 });
    expect(snapshot.freshCandidates.every(({ states }) => states.length <= 8)).toBe(true);
  });
});
