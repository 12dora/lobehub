// @vitest-environment node
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { RedisConfig } from '@/libs/redis';
import { IoRedisRedisProvider } from '@/libs/redis/redis';
import {
  platformConfigKeys,
  RedisPlatformConfigInvalidationPublisher,
  RedisPlatformConfigVersionReader,
} from '@/server/enterprise/services/platformConfigInvalidation';

import { DomainConfigCache, resetDomainConfigCachesForTest } from './domainCache';

const TEST_SCOPE = 'o01b-cache-convergence';
const TEST_RESOURCE_ID = 'o01b-singleton';
const TEST_RESOURCE_TYPE = 'branding';
const LAST_EVENT_TTL_SECONDS = 86_400;
const testRedisUrl = process.env.TEST_REDIS_URL?.trim();

const versionKey = platformConfigKeys.scopeVersion(TEST_SCOPE);
const resourceKey = platformConfigKeys.resourceVersion(TEST_RESOURCE_TYPE, TEST_RESOURCE_ID);
const diagnosticKey = `platform:config:last_event:${TEST_RESOURCE_TYPE}:${TEST_RESOURCE_ID}`;
const ownedKeys = [platformConfigKeys.globalVersion(), resourceKey, versionKey, diagnosticKey];

describe.skipIf(!testRedisUrl)('DomainConfigCache real Redis convergence', () => {
  let publisherClient: IoRedisRedisProvider | undefined;
  let readerClient: IoRedisRedisProvider | undefined;

  beforeAll(async () => {
    if (!testRedisUrl) throw new Error('TEST_REDIS_URL is required for the real Redis gate');

    const config = {
      enabled: true,
      prefix: `o01b:${randomUUID()}`,
      tls: testRedisUrl.startsWith('rediss://'),
      url: testRedisUrl,
    } satisfies RedisConfig;
    publisherClient = new IoRedisRedisProvider(config);
    readerClient = new IoRedisRedisProvider(config);

    await publisherClient.initialize();
    await readerClient.initialize();
    await publisherClient.del(...ownedKeys);
  });

  afterAll(async () => {
    resetDomainConfigCachesForTest();
    if (publisherClient) await publisherClient.del(...ownedKeys);
    await Promise.all([publisherClient?.disconnect(), readerClient?.disconnect()]);
  });

  it('converges through request-time version reads across two independent clients', async () => {
    if (!publisherClient || !readerClient) throw new Error('Redis clients were not initialized');
    const publisherConnection = publisherClient;
    const readerConnection = readerClient;

    const redisConfig = {
      enabled: true,
      prefix: '',
      tls: false,
      url: '',
    } satisfies RedisConfig;
    const publisher = new RedisPlatformConfigInvalidationPublisher({
      getRedisConfig: () => redisConfig,
      initializeRedis: async () => publisherConnection,
    });
    const versionReader = new RedisPlatformConfigVersionReader({
      getRedisConfig: () => redisConfig,
      initializeRedis: async () => readerConnection,
    });
    let databaseRevision = 0;
    const loadFromDatabase = vi.fn(async () => ({ revision: databaseRevision }));
    const cache = new DomainConfigCache({
      cacheId: 'published',
      cacheKey: readerConnection,
      cacheTtlMs: 300_000,
      cloneValue: (value) => ({ ...value }),
      getScopeEpoch: () => versionReader.getScopeVersion(TEST_SCOPE),
      load: loadFromDatabase,
      namespace: 'o01b-real-redis',
    });
    const publish = (revision: number) =>
      publisher.publish({
        at: new Date(0).toISOString(),
        resourceId: TEST_RESOURCE_ID,
        resourceType: TEST_RESOURCE_TYPE,
        revision,
        scopes: [TEST_SCOPE],
      });

    await expect(cache.get()).resolves.toEqual({ revision: 0 });
    expect(loadFromDatabase).toHaveBeenCalledOnce();

    databaseRevision = 1;
    await publish(1);
    await expect(readerConnection.get(versionKey)).resolves.toBe('1');
    await expect(cache.get()).resolves.toEqual({ revision: 1 });
    expect(loadFromDatabase).toHaveBeenCalledTimes(2);

    databaseRevision = 4;
    await publish(2);
    await publish(3);
    await publish(4);
    await expect(readerConnection.get(versionKey)).resolves.toBe('4');
    await expect(cache.get()).resolves.toEqual({ revision: 4 });
    expect(loadFromDatabase).toHaveBeenCalledTimes(3);

    await expect(readerConnection.get(resourceKey)).resolves.toBe('4');
    const diagnostic = await readerConnection.get(diagnosticKey);
    expect(JSON.parse(diagnostic ?? 'null')).toMatchObject({
      resourceType: TEST_RESOURCE_TYPE,
      revision: 4,
      scopes: [TEST_SCOPE],
    });
    const diagnosticTtl = await readerConnection.ttl(diagnosticKey);
    expect(diagnosticTtl).toBeGreaterThanOrEqual(LAST_EVENT_TTL_SECONDS - 10);
    expect(diagnosticTtl).toBeLessThanOrEqual(LAST_EVENT_TTL_SECONDS);

    databaseRevision = 5;
    await publisherConnection.del(versionKey);
    await expect(readerConnection.get(versionKey)).resolves.toBeNull();
    await expect(cache.get()).resolves.toEqual({ revision: 5 });
    expect(loadFromDatabase).toHaveBeenCalledTimes(4);
  });
});
