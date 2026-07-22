import { beforeEach, describe, expect, it, vi } from 'vitest';

const authEnvMock = vi.hoisted(() => ({
  AUTH_COOKIE_PREFIX: undefined as string | undefined,
}));

const redisMocks = vi.hoisted(() => ({
  del: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
}));

vi.mock('@/envs/app', () => ({
  appEnv: {},
}));

vi.mock('@/envs/auth', () => ({
  authEnv: authEnvMock,
}));

vi.mock('@/envs/redis', () => ({
  getRedisConfig: vi.fn(() => ({ REDIS_URL: 'redis://localhost:6379' })),
}));

vi.mock('@/libs/redis', () => ({
  initializeRedis: vi.fn(async () => redisMocks),
  isRedisEnabled: vi.fn(() => true),
}));

describe('createSecondaryStorage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authEnvMock.AUTH_COOKIE_PREFIX = undefined;
  });

  it('keeps the historical key prefix when AUTH_COOKIE_PREFIX is unset', async () => {
    const { createSecondaryStorage } = await import('./config');

    const storage = createSecondaryStorage();
    await storage!.set('session-key', 'value');
    await storage!.get('session-key');
    await storage!.delete('session-key');

    expect(redisMocks.set).toHaveBeenCalledWith('better-auth:session-key', 'value');
    expect(redisMocks.get).toHaveBeenCalledWith('better-auth:session-key');
    expect(redisMocks.del).toHaveBeenCalledWith('better-auth:session-key');
  });

  it('namespaces keys per instance when AUTH_COOKIE_PREFIX is set', async () => {
    authEnvMock.AUTH_COOKIE_PREFIX = 'aihub-3011';
    const { createSecondaryStorage } = await import('./config');

    const storage = createSecondaryStorage();
    await storage!.set('session-key', 'value', 60);
    await storage!.get('session-key');

    expect(redisMocks.set).toHaveBeenCalledWith('better-auth:aihub-3011:session-key', 'value', {
      ex: 60,
    });
    expect(redisMocks.get).toHaveBeenCalledWith('better-auth:aihub-3011:session-key');
  });
});
