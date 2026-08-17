import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDefaultNetworkProxyConfig } from '@/types/platform/networkProxy';

import { resetDomainConfigCachesForTest } from '../../runtimeConfig';
import {
  formatStaticProxyHost,
  getNetworkProxySnapshot,
  onNetworkProxySnapshotChange,
  peekNetworkProxySnapshot,
  resetNetworkProxySnapshotForTest,
} from './snapshot';

const ensureDefault = vi.fn();
const list = vi.fn();
const openSecret = vi.fn(async (ciphertext: string) => `plain:${ciphertext}`);

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(async () => ({})),
}));

vi.mock('@/database/models/platform/networkProxySettings', () => ({
  NetworkProxySettingsModel: class {
    ensureDefault = ensureDefault;
  },
}));

vi.mock('@/database/models/platform/networkProxySubscription', () => ({
  NetworkProxySubscriptionModel: class {
    list = list;
  },
}));

vi.mock('./secrets', () => ({
  openNetworkProxySecret: (ciphertext: string) => openSecret(ciphertext),
}));

vi.mock('../platformConfigInvalidation', () => ({
  getPlatformConfigInvalidationPublisher: () => ({ publish: vi.fn(async () => undefined) }),
  getPlatformConfigScopeVersion: async () => '1',
}));

const settingsRow = (revision: number) => ({
  config: {
    ...createDefaultNetworkProxyConfig(),
    staticProxy: {
      passwordCiphertext: 'pw-seal',
      port: 8080,
      server: 'proxy.example',
      type: 'https' as const,
      username: 'alice',
    },
  },
  desiredArtifacts: {},
  engineGeneration: 0,
  revision,
  updatedAt: new Date('2026-08-17T00:00:00.000Z'),
});

beforeEach(() => {
  ensureDefault.mockReset();
  list.mockReset();
  openSecret.mockImplementation(async (ciphertext: string) => `plain:${ciphertext}`);
  list.mockResolvedValue([]);
  resetNetworkProxySnapshotForTest();
  resetDomainConfigCachesForTest();
});

afterEach(() => {
  resetNetworkProxySnapshotForTest();
  resetDomainConfigCachesForTest();
});

describe('getNetworkProxySnapshot', () => {
  it('caches a successful load and peeks the last snapshot', async () => {
    ensureDefault.mockResolvedValue(settingsRow(2));
    const first = await getNetworkProxySnapshot();
    expect(first.revision).toBe(2);
    expect(first.staticProxyUrl).toBe('https://alice:plain%3Apw-seal@proxy.example:8080');
    expect(ensureDefault).toHaveBeenCalledTimes(1);

    const peeked = peekNetworkProxySnapshot();
    expect(peeked?.revision).toBe(2);

    const second = await getNetworkProxySnapshot();
    expect(second.revision).toBe(2);
    expect(ensureDefault).toHaveBeenCalledTimes(1);
  });

  it('fires the change listener when revision changes and not when it does not', async () => {
    const seen: number[] = [];
    const off = onNetworkProxySnapshotChange((snap) => {
      seen.push(snap.revision);
    });

    ensureDefault.mockResolvedValue(settingsRow(1));
    await getNetworkProxySnapshot();
    expect(seen).toEqual([1]);

    resetDomainConfigCachesForTest();
    await getNetworkProxySnapshot();
    expect(seen).toEqual([1]);

    resetDomainConfigCachesForTest();
    ensureDefault.mockResolvedValue(settingsRow(4));
    await getNetworkProxySnapshot();
    expect(seen).toEqual([1, 4]);
    off();
  });

  it('never throws: serves last-known-good after a later DB failure', async () => {
    ensureDefault.mockResolvedValue(settingsRow(3));
    const first = await getNetworkProxySnapshot();
    expect(first.revision).toBe(3);

    resetDomainConfigCachesForTest();
    ensureDefault.mockRejectedValue(new Error('db down'));
    const second = await getNetworkProxySnapshot();
    expect(second.revision).toBe(3);
    expect(second.config.masterEnabled).toBe(false);
  });

  it('falls back to a masterEnabled=false default when there is no last-known-good', async () => {
    ensureDefault.mockRejectedValue(new Error('db down'));
    const snapshot = await getNetworkProxySnapshot();
    expect(snapshot.config.masterEnabled).toBe(false);
    expect(snapshot.revision).toBe(0);
    expect(snapshot.staticProxyUrl).toBeNull();
  });

  it('fires the change listener when a subscription payload ciphertext is replaced', async () => {
    const seen: Array<string | null | undefined> = [];
    const off = onNetworkProxySnapshotChange((snap) => {
      seen.push(snap.subscriptions[0]?.payload);
    });

    const row = (payloadCiphertext: string) => ({
      createdAt: new Date('2026-08-17T00:00:00.000Z'),
      createdBy: 'u1',
      enabled: true,
      excludeFilter: null,
      filter: null,
      id: 'nps_manual',
      kind: 'manual' as const,
      lastError: null,
      lastIssue: null,
      lastUpdateAt: null,
      name: 'manual',
      nodeCount: null,
      payloadCiphertext,
      refreshRequestedAt: null,
      sortOrder: 0,
      trafficDownload: null,
      trafficExpireAt: null,
      trafficTotal: null,
      trafficUpload: null,
      updatedAt: new Date('2026-08-17T00:00:00.000Z'),
      updateIntervalSec: null,
      urlCiphertext: null,
      urlHost: null,
      userAgent: null,
    });

    ensureDefault.mockResolvedValue(settingsRow(1));
    list.mockResolvedValue([row('sealed-payload-a')]);
    await getNetworkProxySnapshot();

    resetDomainConfigCachesForTest();
    list.mockResolvedValue([row('sealed-payload-b')]);
    await getNetworkProxySnapshot();

    expect(seen).toEqual(['plain:sealed-payload-a', 'plain:sealed-payload-b']);
    off();
  });

  it('builds IPv6 static proxy URLs with encoded credentials', async () => {
    ensureDefault.mockResolvedValue({
      ...settingsRow(1),
      config: {
        ...createDefaultNetworkProxyConfig(),
        staticProxy: {
          passwordCiphertext: 'p@ss:word',
          port: 8080,
          server: '2001:db8::1',
          type: 'https' as const,
          username: 'alice@corp',
        },
      },
    });
    const snapshot = await getNetworkProxySnapshot();
    expect(snapshot.staticProxyUrl).toBe(
      'https://alice%40corp:plain%3Ap%40ss%3Aword@[2001:db8::1]:8080',
    );
  });

  it('omits staticProxyUrl when the server is not a hostname or IP literal', async () => {
    ensureDefault.mockResolvedValue({
      ...settingsRow(1),
      config: {
        ...createDefaultNetworkProxyConfig(),
        staticProxy: {
          port: 8080,
          server: 'evil@host/path',
          type: 'http' as const,
        },
      },
    });
    const snapshot = await getNetworkProxySnapshot();
    expect(snapshot.staticProxyUrl).toBeNull();
  });
});

describe('formatStaticProxyHost', () => {
  it('accepts RFC1123 hostnames and IP literals', () => {
    expect(formatStaticProxyHost('2001:db8::1')).toBe('[2001:db8::1]');
    expect(formatStaticProxyHost('[2001:db8::1]')).toBe('[2001:db8::1]');
    expect(formatStaticProxyHost('10.0.0.1')).toBe('10.0.0.1');
    expect(formatStaticProxyHost('proxy.example')).toBe('proxy.example');
    expect(formatStaticProxyHost('localhost')).toBe('localhost');
    expect(formatStaticProxyHost('a.b-c.example')).toBe('a.b-c.example');
  });

  it('rejects URL delimiters, invalid labels, and non-DNS characters', () => {
    expect(formatStaticProxyHost('user@host')).toBeNull();
    expect(formatStaticProxyHost('host/path')).toBeNull();
    expect(formatStaticProxyHost('host name')).toBeNull();
    expect(formatStaticProxyHost('host:8080')).toBeNull();
    expect(formatStaticProxyHost('proxy.example#frag')).toBeNull();
    expect(formatStaticProxyHost('host?x')).toBeNull();
    expect(formatStaticProxyHost('host%20')).toBeNull();
    expect(formatStaticProxyHost('host\\x')).toBeNull();
    expect(formatStaticProxyHost('-bad.example')).toBeNull();
    expect(formatStaticProxyHost('bad-.example')).toBeNull();
    expect(formatStaticProxyHost(`${'a'.repeat(64)}.example`)).toBeNull();
    expect(
      formatStaticProxyHost(
        `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(64)}`,
      ),
    ).toBeNull();
  });
});
