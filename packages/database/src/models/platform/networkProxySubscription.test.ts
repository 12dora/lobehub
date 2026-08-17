// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { platformNetworkProxySubscriptions } from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';
import { NetworkProxySubscriptionModel } from './networkProxySubscription';

const db: LobeChatDatabase = await getTestDB();

const cleanup = async () => {
  await db.delete(platformNetworkProxySubscriptions);
};

beforeEach(cleanup);
afterEach(cleanup);

const createUrl = (model: NetworkProxySubscriptionModel, name = 'sub', sortOrder = 0) =>
  model.create({
    createdBy: 'admin-user',
    enabled: true,
    kind: 'url',
    name,
    sortOrder,
    updateIntervalSec: 86_400,
    urlCiphertext: 'sealed-url',
    urlHost: 'example.com',
  });

describe('NetworkProxySubscriptionModel', () => {
  it('creates, lists by sort_order, updates, and deletes', async () => {
    const model = new NetworkProxySubscriptionModel(db);
    const second = await createUrl(model, 'b', 2);
    const first = await createUrl(model, 'a', 1);
    expect(first.id.startsWith('nps_')).toBe(true);

    const listed = await model.list();
    expect(listed.map((row) => row.name)).toEqual(['a', 'b']);

    const updated = await model.update(first.id, { enabled: false, name: 'a-renamed' });
    expect(updated?.name).toBe('a-renamed');
    expect(updated?.enabled).toBe(false);

    expect(await model.getById(first.id)).toMatchObject({ name: 'a-renamed' });

    await model.delete(second.id);
    expect(await model.getById(second.id)).toBeNull();
    expect(await model.list()).toHaveLength(1);
  });

  it('requestRefresh stamps refresh_requested_at', async () => {
    const model = new NetworkProxySubscriptionModel(db);
    const created = await createUrl(model);
    const at = new Date('2026-08-17T12:00:00.000Z');
    const refreshed = await model.requestRefresh(created.id, at);
    expect(refreshed?.refreshRequestedAt?.toISOString()).toBe(at.toISOString());
  });

  it('recordFetchResult is idempotent on stale success and always writes last_issue', async () => {
    const model = new NetworkProxySubscriptionModel(db);
    const created = await createUrl(model);
    const earlier = new Date('2026-08-17T10:00:00.000Z');
    const later = new Date('2026-08-17T11:00:00.000Z');

    await model.recordFetchResult(created.id, {
      fetchedAt: later,
      nodeCount: 8,
      traffic: {
        download: 20,
        expireAt: '2026-12-01T00:00:00.000Z',
        total: 100,
        upload: 10,
      },
    });
    const afterLater = await model.getById(created.id);
    expect(afterLater?.nodeCount).toBe(8);
    expect(afterLater?.trafficUpload).toBe(10);
    expect(afterLater?.lastUpdateAt?.toISOString()).toBe(later.toISOString());

    await model.recordFetchResult(created.id, {
      fetchedAt: earlier,
      nodeCount: 1,
      traffic: { download: 1, expireAt: null, total: 1, upload: 1 },
    });
    const afterStale = await model.getById(created.id);
    expect(afterStale?.nodeCount).toBe(8);
    expect(afterStale?.lastUpdateAt?.toISOString()).toBe(later.toISOString());

    const timeoutIssue = {
      at: '2026-08-17T12:00:00.000Z',
      code: 'timeout' as const,
      detail: 'The operation was aborted',
    };
    await model.recordFetchResult(created.id, {
      fetchedAt: new Date('2026-08-17T12:00:00.000Z'),
      lastIssue: timeoutIssue,
    });
    const afterError = await model.getById(created.id);
    expect(afterError?.lastIssue).toEqual(timeoutIssue);
    expect(afterError?.lastUpdateAt?.toISOString()).toBe(later.toISOString());

    const infoIssue = {
      at: '2026-08-17T12:30:00.000Z',
      code: 'outlet_unavailable_fetched_direct' as const,
      detail: 'outlet unavailable, fetched direct',
    };
    const infoAt = new Date('2026-08-17T12:30:00.000Z');
    await model.recordFetchResult(created.id, {
      fetchedAt: infoAt,
      lastIssue: infoIssue,
      nodeCount: 3,
    });
    const afterInfo = await model.getById(created.id);
    expect(afterInfo?.lastIssue).toEqual(infoIssue);
    expect(afterInfo?.nodeCount).toBe(3);
    expect(afterInfo?.lastUpdateAt?.toISOString()).toBe(infoAt.toISOString());
  });
});
