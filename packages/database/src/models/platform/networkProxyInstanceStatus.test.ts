// @vitest-environment node
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import {
  platformInstanceHeartbeats,
  platformNetworkProxyInstanceStatus,
} from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';
import { NetworkProxyInstanceStatusModel } from './networkProxyInstanceStatus';

const db: LobeChatDatabase = await getTestDB();
const instanceId = (digit: string) => `pinst_${digit.repeat(48)}`;

const cleanup = async () => {
  await db.delete(platformNetworkProxyInstanceStatus);
  await db.delete(platformInstanceHeartbeats);
};

beforeEach(cleanup);
afterEach(cleanup);

const upsertRow = (id: string) => ({
  activeNode: 'node-a',
  aliveNodeCount: 2,
  appliedEngineGeneration: 1,
  appliedRevision: 3,
  arch: 'arm64',
  artifacts: [
    { installed: true, kind: 'engine' as const, source: 'download' as const, version: 'v1.19.30' },
  ],
  engineState: 'running' as const,
  engineVersion: 'v1.19.30',
  fallbackCount: 1,
  healing: null,
  instanceId: id,
  lastIssue: null,
  platform: 'darwin',
  proxiedCount: 4,
});

describe('NetworkProxyInstanceStatusModel', () => {
  it('upserts when the heartbeat row exists and updates on conflict', async () => {
    const now = new Date();
    const id = instanceId('a');
    await db.insert(platformInstanceHeartbeats).values({
      instanceId: id,
      lastHeartbeatAt: now,
      startedAt: new Date(now.getTime() - 60_000),
    });

    const model = new NetworkProxyInstanceStatusModel(db);
    expect(await model.upsert(upsertRow(id))).toBe(true);
    expect(await model.upsert({ ...upsertRow(id), proxiedCount: 9, engineState: 'degraded' })).toBe(
      true,
    );

    const fresh = await model.listFresh(90_000);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.proxiedCount).toBe(9);
    expect(fresh[0]?.engineState).toBe('degraded');
    expect(fresh[0]?.lastHeartbeatAt).toBeInstanceOf(Date);
    expect(fresh[0]?.lastIssue).toBeNull();
    expect(fresh[0]?.healing).toBeNull();
  });

  it('round-trips lastIssue and healing jsonb columns', async () => {
    const now = new Date();
    const id = instanceId('e');
    await db.insert(platformInstanceHeartbeats).values({
      instanceId: id,
      lastHeartbeatAt: now,
      startedAt: new Date(now.getTime() - 60_000),
    });

    const lastIssue = {
      at: '2026-08-17T00:00:00.000Z',
      code: 'health_timeout' as const,
      detail: 'The operation was aborted due to timeout',
    };
    const healing = { attempt: 2, nextAttemptAt: '2026-08-17T00:00:30.000Z' };

    const model = new NetworkProxyInstanceStatusModel(db);
    expect(
      await model.upsert({
        ...upsertRow(id),
        engineState: 'error',
        healing,
        lastIssue,
      }),
    ).toBe(true);

    const fresh = await model.listFresh(90_000);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.lastIssue).toEqual(lastIssue);
    expect(fresh[0]?.healing).toEqual(healing);
  });

  it('leaves deprecated last_error untouched on upsert', async () => {
    const now = new Date();
    const id = instanceId('f');
    await db.insert(platformInstanceHeartbeats).values({
      instanceId: id,
      lastHeartbeatAt: now,
      startedAt: new Date(now.getTime() - 60_000),
    });
    await db.insert(platformNetworkProxyInstanceStatus).values({
      arch: 'arm64',
      engineState: 'stopped',
      instanceId: id,
      lastError: 'legacy-raw',
      platform: 'darwin',
    });

    const model = new NetworkProxyInstanceStatusModel(db);
    expect(await model.upsert({ ...upsertRow(id), engineState: 'running' })).toBe(true);

    const [row] = await db
      .select()
      .from(platformNetworkProxyInstanceStatus)
      .where(eq(platformNetworkProxyInstanceStatus.instanceId, id));
    expect(row?.lastError).toBe('legacy-raw');
    expect(row?.engineState).toBe('running');
  });

  it('returns false silently when the heartbeat row is missing', async () => {
    const model = new NetworkProxyInstanceStatusModel(db);
    expect(await model.upsert(upsertRow(instanceId('b')))).toBe(false);
    expect(await model.listFresh(90_000)).toEqual([]);
  });

  it('listFresh hides stale heartbeats', async () => {
    const freshId = instanceId('c');
    const staleId = instanceId('d');
    const now = new Date();
    await db.insert(platformInstanceHeartbeats).values([
      {
        instanceId: freshId,
        lastHeartbeatAt: now,
        startedAt: new Date(now.getTime() - 60_000),
      },
      {
        instanceId: staleId,
        lastHeartbeatAt: new Date(now.getTime() - 120_000),
        startedAt: new Date(now.getTime() - 180_000),
      },
    ]);
    const model = new NetworkProxyInstanceStatusModel(db);
    expect(await model.upsert(upsertRow(freshId))).toBe(true);
    expect(await model.upsert(upsertRow(staleId))).toBe(true);

    const fresh = await model.listFresh(90_000);
    expect(fresh.map((row) => row.instanceId)).toEqual([freshId]);
  });
});
