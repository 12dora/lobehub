// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EnterpriseObservabilityEvent } from '../../observability';
import {
  NOOP_ENTERPRISE_STRUCTURED_LOGGER,
  setEnterprisePlatformObserverForTest,
  setEnterpriseStructuredLoggerForTest,
} from '../../observability';
import {
  InMemoryPlatformConfigInvalidationPublisher,
  platformConfigKeys,
  RedisPlatformConfigInvalidationPublisher,
  setPlatformConfigInvalidationPublisher,
} from '../platformConfigInvalidation';

const mocks = vi.hoisted(() => ({
  initializeRedis: vi.fn(),
  log: vi.fn(),
  redisEnabled: false,
}));

vi.mock('debug', () => ({ default: () => mocks.log }));
vi.mock('@/envs/redis', () => ({
  getRedisConfig: () => ({
    enabled: mocks.redisEnabled,
    prefix: 'test',
    tls: false,
    url: mocks.redisEnabled ? 'redis://test' : '',
  }),
}));
vi.mock('@/libs/redis', () => ({ initializeRedis: mocks.initializeRedis }));

const event = (scopes: string[] = ['branding']) => ({
  at: new Date(0).toISOString(),
  resourceId: 'singleton',
  resourceType: 'branding',
  revision: 3,
  scopes,
});

const createFakeRedis = (execResults?: [Error | null, unknown][] | null) => {
  const commands: { args: unknown[]; command: string }[] = [];
  const pipeline = {
    exec: vi.fn(async () => execResults ?? commands.map(() => [null, 'OK'])),
    incr: vi.fn((...args: unknown[]) => {
      commands.push({ args, command: 'incr' });
      return pipeline;
    }),
    set: vi.fn((...args: unknown[]) => {
      commands.push({ args, command: 'set' });
      return pipeline;
    }),
  };
  return { commands, pipeline, redis: { pipeline: () => pipeline } };
};

describe('platformConfigInvalidation', () => {
  let observations: EnterpriseObservabilityEvent[];

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.redisEnabled = false;
    setPlatformConfigInvalidationPublisher(null);
    observations = [];
    setEnterprisePlatformObserverForTest({ record: (event) => observations.push(event) });
    setEnterpriseStructuredLoggerForTest(NOOP_ENTERPRISE_STRUCTURED_LOGGER);
  });

  afterEach(() => {
    setEnterprisePlatformObserverForTest(null);
    setEnterpriseStructuredLoggerForTest(null);
  });

  it('records bounded, deduplicated versions in the in-memory publisher', async () => {
    const publisher = new InMemoryPlatformConfigInvalidationPublisher();
    const scopes = [
      'branding',
      'branding',
      ...Array.from({ length: 40 }, (_, index) => `scope-${index}`),
      'x'.repeat(129),
    ];
    await publisher.publish(event(scopes));

    expect(publisher.versions.get('branding:singleton')).toBe(3);
    expect(publisher.versions.get('global')).toBe(3);
    expect(publisher.events[0]?.scopes).toHaveLength(32);
    expect(publisher.events[0]?.scopes?.filter((scope) => scope === 'branding')).toHaveLength(1);
    expect(publisher.versions.has(`scope:${'x'.repeat(129)}`)).toBe(false);

    await publisher.publish({ ...event(['branding']), resourceId: 'other', revision: 1 });
    expect(publisher.versions.get('global')).toBe(4);
    expect(publisher.versions.get('scope:branding')).toBe(4);
    await expect(publisher.getScopeVersion('branding')).resolves.toBe('4');
  });

  it('bounds retained in-memory diagnostics without losing version counters', async () => {
    const publisher = new InMemoryPlatformConfigInvalidationPublisher();
    for (let revision = 1; revision <= 300; revision += 1) {
      await publisher.publish({ ...event(), revision });
    }

    expect(publisher.events).toHaveLength(256);
    expect(publisher.events[0]?.revision).toBe(45);
    expect(publisher.versions.get('scope:branding')).toBe(300);
  });

  it('builds stable redis key names', () => {
    expect(platformConfigKeys.globalVersion()).toBe('platform:config:version');
    expect(platformConfigKeys.resourceVersion('settings', 'general.language')).toBe(
      'platform:config:version:settings:general.language',
    );
    expect(platformConfigKeys.scopeVersion('branding')).toBe(
      'platform:config:scope:branding:version',
    );
  });

  it('degrades without initializing Redis when it is disabled', async () => {
    await expect(new RedisPlatformConfigInvalidationPublisher().publish(event())).resolves.toBe(
      undefined,
    );
    expect(mocks.initializeRedis).not.toHaveBeenCalled();
    expect(mocks.log).toHaveBeenCalledWith(expect.stringContaining('degraded'), 'branding');
  });

  it('degrades when Redis initialization is unavailable', async () => {
    mocks.redisEnabled = true;
    mocks.initializeRedis.mockResolvedValue(null);

    await expect(new RedisPlatformConfigInvalidationPublisher().publish(event())).resolves.toBe(
      undefined,
    );
    expect(mocks.log).toHaveBeenCalledWith(expect.stringContaining('degraded'), 'branding');
  });

  it('recognizes a partial pipeline error as degraded instead of reporting complete', async () => {
    mocks.redisEnabled = true;
    const results: [Error | null, unknown][] = [
      [null, 1],
      [null, 'OK'],
      [new Error('scope increment failed'), undefined],
      [null, 'OK'],
    ];
    const fake = createFakeRedis(results);
    mocks.initializeRedis.mockResolvedValue(fake.redis);

    await new RedisPlatformConfigInvalidationPublisher().publish(event());

    expect(mocks.log).toHaveBeenCalledWith(expect.stringContaining('degraded'), 'branding', 3, 1);
    expect(mocks.log.mock.calls.some(([message]) => String(message).includes('complete'))).toBe(
      false,
    );
  });

  it('bounds Redis scopes and gives the diagnostic envelope a TTL', async () => {
    mocks.redisEnabled = true;
    const fake = createFakeRedis();
    mocks.initializeRedis.mockResolvedValue(fake.redis);
    const scopes = [
      'scope-0',
      'scope-0',
      ...Array.from({ length: 40 }, (_, index) => `scope-${index + 1}`),
      'x'.repeat(129),
    ];

    await new RedisPlatformConfigInvalidationPublisher().publish(event(scopes));

    const scopeIncrements = fake.commands.filter(
      ({ args, command }) =>
        command === 'incr' && String(args[0]).startsWith('platform:config:scope:'),
    );
    expect(scopeIncrements).toHaveLength(32);
    expect(new Set(scopeIncrements.map(({ args }) => args[0])).size).toBe(32);
    const diagnostic = fake.commands.find(
      ({ args, command }) => command === 'set' && String(args[0]).includes(':last_event:'),
    );
    expect(diagnostic?.args[2]).toEqual({ ex: 86_400 });
    expect(JSON.parse(String(diagnostic?.args[1])).scopes).toHaveLength(32);
    expect(mocks.log).toHaveBeenCalledWith(expect.stringContaining('complete'), 'branding', 3, 32);
  });

  it('classifies every memory and Redis invalidation outcome', async () => {
    await new InMemoryPlatformConfigInvalidationPublisher().publish(event());
    await new RedisPlatformConfigInvalidationPublisher().publish(event());

    mocks.redisEnabled = true;
    mocks.initializeRedis.mockResolvedValueOnce(null);
    await new RedisPlatformConfigInvalidationPublisher().publish(event());
    mocks.initializeRedis.mockResolvedValueOnce(
      createFakeRedis([[new Error('raw pipeline detail'), undefined]]).redis,
    );
    await new RedisPlatformConfigInvalidationPublisher().publish(event());
    mocks.initializeRedis.mockResolvedValueOnce(createFakeRedis().redis);
    await new RedisPlatformConfigInvalidationPublisher().publish(event());
    mocks.initializeRedis.mockRejectedValueOnce(new Error('raw connection detail'));
    await new RedisPlatformConfigInvalidationPublisher().publish(event());

    const outcomes = observations
      .filter(({ type }) => type === 'invalidation')
      .map(({ outcome }) => outcome);
    expect(outcomes).toEqual([
      'success',
      'disabled',
      'unavailable',
      'partial_failure',
      'success',
      'error',
    ]);
    expect(JSON.stringify(observations)).not.toContain('raw');
    expect(observations.at(-1)).toMatchObject({ errorClass: 'UnexpectedError' });
  });
});
