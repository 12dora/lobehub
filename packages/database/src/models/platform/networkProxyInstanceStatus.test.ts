// @vitest-environment node
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
  instanceId: id,
  lastError: null,
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
