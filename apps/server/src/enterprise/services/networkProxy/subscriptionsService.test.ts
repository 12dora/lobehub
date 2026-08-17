import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { NETWORK_PROXY_DEFAULTS } from '@/const/platform/networkProxy';

import { getEnterpriseErrorBody } from '../../guards/enterpriseErrors';
import {
  createSubscriptionRecord,
  parseSubscriptionUserinfoHeader,
  updateSubscriptionRecord,
} from './subscriptionsService';

const list = vi.fn();
const create = vi.fn();
const getById = vi.fn();
const update = vi.fn();

vi.mock('@/database/models/platform/networkProxySubscription', () => ({
  NetworkProxySubscriptionModel: class {
    create = create;
    getById = getById;
    list = list;
    update = update;
  },
}));

vi.mock('./secrets', () => ({
  sealNetworkProxySecret: vi.fn(async (plain: string) => `sealed:${plain}`),
}));

beforeEach(() => {
  list.mockReset();
  create.mockReset();
  getById.mockReset();
  update.mockReset();
  list.mockResolvedValue([]);
});

describe('parseSubscriptionUserinfoHeader', () => {
  it('parses upload/download/total/expire', () => {
    expect(
      parseSubscriptionUserinfoHeader('upload=1; download=2; total=3; expire=1700000000'),
    ).toEqual({
      download: 2,
      expireAt: new Date(1_700_000_000 * 1000).toISOString(),
      total: 3,
      upload: 1,
    });
  });

  it('returns null for empty or unparseable values', () => {
    expect(parseSubscriptionUserinfoHeader(null)).toBeNull();
    expect(parseSubscriptionUserinfoHeader('')).toBeNull();
    expect(parseSubscriptionUserinfoHeader('foo=bar')).toBeNull();
  });
});

describe('createSubscriptionRecord host policy', () => {
  const base = {
    enabled: true,
    kind: 'url' as const,
    name: 'bad',
    sortOrder: 0,
    updateIntervalSec: NETWORK_PROXY_DEFAULTS.SUBSCRIPTION_UPDATE_INTERVAL_SEC,
  };

  it('rejects 169.254.169.254', async () => {
    try {
      await createSubscriptionRecord(
        {} as never,
        { ...base, url: 'https://169.254.169.254/sub' },
        'u1',
      );
      throw new Error('expected throw');
    } catch (error) {
      expect(getEnterpriseErrorBody(error)?.code).toBe(
        PLATFORM_ERROR_CODES.PLATFORM_NETWORK_PROXY_SUBSCRIPTION_INVALID,
      );
    }
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects cloud metadata hostnames', async () => {
    try {
      await createSubscriptionRecord(
        {} as never,
        { ...base, url: 'https://metadata.google.internal/latest/meta-data' },
        'u1',
      );
      throw new Error('expected throw');
    } catch (error) {
      expect(getEnterpriseErrorBody(error)?.code).toBe(
        PLATFORM_ERROR_CODES.PLATFORM_NETWORK_PROXY_SUBSCRIPTION_INVALID,
      );
    }
    expect(create).not.toHaveBeenCalled();
  });

  it('accepts a public hostname and stores only the host', async () => {
    create.mockResolvedValue({
      createdAt: new Date('2026-08-17T00:00:00.000Z'),
      createdBy: 'u1',
      enabled: true,
      excludeFilter: null,
      filter: null,
      id: 'nps_test',
      kind: 'url',
      lastError: null,
      lastIssue: null,
      lastUpdateAt: null,
      name: 'ok',
      nodeCount: null,
      payloadCiphertext: null,
      refreshRequestedAt: null,
      sortOrder: 0,
      trafficDownload: null,
      trafficExpireAt: null,
      trafficTotal: null,
      trafficUpload: null,
      updateIntervalSec: 86_400,
      updatedAt: new Date('2026-08-17T00:00:00.000Z'),
      urlCiphertext: 'sealed:https://cdn.example/sub?token=abc',
      urlHost: 'cdn.example',
      userAgent: null,
    });
    const view = await createSubscriptionRecord(
      {} as never,
      { ...base, name: 'ok', url: 'https://cdn.example/sub?token=abc' },
      'u1',
    );
    expect(view.urlHost).toBe('cdn.example');
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        urlCiphertext: 'sealed:https://cdn.example/sub?token=abc',
        urlHost: 'cdn.example',
      }),
    );
  });
});

describe('updateSubscriptionRecord kind policy', () => {
  const row = (kind: 'url' | 'manual') => ({
    createdAt: new Date('2026-08-17T00:00:00.000Z'),
    createdBy: 'u1',
    enabled: true,
    excludeFilter: null,
    filter: null,
    id: 'nps_1',
    kind,
    lastError: null,
    lastIssue: null,
    lastUpdateAt: null,
    name: 'sub',
    nodeCount: null,
    payloadCiphertext: kind === 'manual' ? 'sealed-payload' : null,
    refreshRequestedAt: null,
    sortOrder: 0,
    trafficDownload: null,
    trafficExpireAt: null,
    trafficTotal: null,
    trafficUpload: null,
    updatedAt: new Date('2026-08-17T00:00:00.000Z'),
    updateIntervalSec: 86_400,
    urlCiphertext: kind === 'url' ? 'sealed-url' : null,
    urlHost: kind === 'url' ? 'cdn.example' : null,
    userAgent: null,
  });

  it('rejects url on a manual subscription', async () => {
    getById.mockResolvedValue(row('manual'));
    try {
      await updateSubscriptionRecord(
        {} as never,
        { id: 'nps_1', url: 'https://cdn.example/sub' },
        'u1',
      );
      throw new Error('expected throw');
    } catch (error) {
      expect(getEnterpriseErrorBody(error)?.code).toBe(
        PLATFORM_ERROR_CODES.PLATFORM_NETWORK_PROXY_SUBSCRIPTION_INVALID,
      );
    }
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects payload on a url subscription', async () => {
    getById.mockResolvedValue(row('url'));
    try {
      await updateSubscriptionRecord({} as never, { id: 'nps_1', payload: 'ss://new' }, 'u1');
      throw new Error('expected throw');
    } catch (error) {
      expect(getEnterpriseErrorBody(error)?.code).toBe(
        PLATFORM_ERROR_CODES.PLATFORM_NETWORK_PROXY_SUBSCRIPTION_INVALID,
      );
    }
    expect(update).not.toHaveBeenCalled();
  });
});
