// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { PlatformSandboxSettingsModel } from '@/database/models/platform/sandboxSettings';
import { platformSandboxSettings } from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import {
  getEffectiveSandboxSettings,
  invalidateEffectiveSandboxSettings,
  mergeSandboxSettings,
  resetEffectiveSandboxSettingsForTest,
  settingsFromEnv,
} from './effective';

const db: LobeChatDatabase = await getTestDB();

const env = {
  SANDBOX_DOCKER_HOST: undefined,
  SANDBOX_DOCKER_SOCKET: '/var/run/docker.sock',
  SANDBOX_LOCAL_CPUS: 1,
  SANDBOX_LOCAL_IDLE_TTL_SEC: 1800,
  SANDBOX_LOCAL_IMAGE: 'aihub-sandbox:latest',
  SANDBOX_LOCAL_MAX_CONTAINERS: 8,
  SANDBOX_LOCAL_MAX_OUTPUT_BYTES: 1_048_576,
  SANDBOX_LOCAL_MEMORY_MB: 1024,
  SANDBOX_LOCAL_NETWORK: 'bridge' as const,
  SANDBOX_LOCAL_PIDS_LIMIT: 256,
  SANDBOX_LOCAL_PULL_POLICY: 'if-missing' as const,
  SANDBOX_LOCAL_TIMEOUT_MS: 120_000,
  SANDBOX_PROVIDER: 'local' as const,
};

beforeEach(async () => {
  resetEffectiveSandboxSettingsForTest();
  await db.delete(platformSandboxSettings);
});

afterEach(async () => {
  resetEffectiveSandboxSettingsForTest();
  await db.delete(platformSandboxSettings);
});

describe('mergeSandboxSettings', () => {
  it('uses env when the stored row is not enabled', () => {
    const effective = mergeSandboxSettings(env, { enabled: false, image: 'ignored', revision: 3 });
    expect(effective).toMatchObject({
      image: 'aihub-sandbox:latest',
      provider: 'local',
      revision: 3,
      source: 'env',
    });
  });

  it('overrides env with stored fields when enabled (DB ?? env)', () => {
    const effective = mergeSandboxSettings(env, {
      enabled: true,
      image: 'custom:1',
      memoryMb: 512,
      provider: 'local',
      revision: 2,
    });
    expect(effective).toMatchObject({
      dockerSocket: '/var/run/docker.sock',
      image: 'custom:1',
      memoryMb: 512,
      provider: 'local',
      source: 'db',
    });
  });
});

describe('getEffectiveSandboxSettings', () => {
  it('returns env values when no row exists', async () => {
    const effective = await getEffectiveSandboxSettings({ db, env });
    expect(effective).toEqual(settingsFromEnv(env));
    expect(effective.source).toBe('env');
  });

  it('applies a saved DB override', async () => {
    await new PlatformSandboxSettingsModel(db).update('admin', {
      enabled: true,
      expectedRevision: 0,
      image: 'override:dev',
      maxContainers: 2,
      provider: 'local',
    });

    const effective = await getEffectiveSandboxSettings({ db, env });
    expect(effective.source).toBe('db');
    expect(effective.image).toBe('override:dev');
    expect(effective.maxContainers).toBe(2);
    expect(effective.memoryMb).toBe(1024);
  });

  it('caches until invalidateEffectiveSandboxSettings', async () => {
    await getEffectiveSandboxSettings({ db, env });
    await new PlatformSandboxSettingsModel(db).update('admin', {
      enabled: true,
      expectedRevision: 0,
      provider: 'market',
    });
    const cached = await getEffectiveSandboxSettings({ db, env });
    expect(cached.provider).toBe('local');
    expect(cached.source).toBe('env');

    invalidateEffectiveSandboxSettings();
    const next = await getEffectiveSandboxSettings({ db, env });
    expect(next.provider).toBe('market');
    expect(next.source).toBe('db');
  });
});
