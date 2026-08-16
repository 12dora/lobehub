// @vitest-environment node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { PlatformInstanceRepository } from '@/database/repositories/platformInstance';
import {
  platformIdentityProviderInstances,
  platformIdentityProviderRestartRequests,
  platformInstanceHeartbeats,
  platformInstanceRevisionStates,
} from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import {
  isPlatformInstanceRegistryCleanupWorkerRuntime,
  PLATFORM_INSTANCE_RETENTION_MS,
  runPlatformInstanceRegistryCleanup,
} from './platformInstanceRegistryCleanup';

const db: LobeChatDatabase = await getTestDB();
const execFileAsync = promisify(execFile);
const now = new Date('2030-01-01T00:00:00.000Z');
const expired = new Date(now.getTime() - PLATFORM_INSTANCE_RETENTION_MS - 60_000);

const cleanup = async () => {
  await db.delete(platformIdentityProviderRestartRequests);
  await db.delete(platformIdentityProviderInstances);
  await db.delete(platformInstanceRevisionStates);
  await db.delete(platformInstanceHeartbeats);
};

const seedExpired = async (count: number) => {
  await db.insert(platformInstanceHeartbeats).values(
    Array.from({ length: count }, (_, index) => ({
      instanceId: `pinst_${index.toString(16).padStart(48, '0')}`,
      lastHeartbeatAt: new Date(expired.getTime() - index * 1000),
      startedAt: new Date(expired.getTime() - 600_000),
    })),
  );
  await db.insert(platformIdentityProviderInstances).values(
    Array.from({ length: count }, (_, index) => ({
      activeIdentityRevision: null,
      health: 'healthy' as const,
      hostnameHash: 'a'.repeat(64),
      instanceId: `oidci_${index.toString(16).padStart(48, '0')}`,
      lastHeartbeat: new Date(expired.getTime() - index * 1000),
      loadedAt: new Date(expired.getTime() - 600_000),
      startedAt: new Date(expired.getTime() - 600_000),
      startupSource: 'database' as const,
    })),
  );
};

const run = (overrides: { limit?: number } = {}) =>
  runPlatformInstanceRegistryCleanup({
    acquireDatabase: async () => db,
    acquireLock: async () => {},
    cleanup: (tx, cutoff) =>
      new PlatformInstanceRepository(tx).purgeOfflineInstances({
        cutoff,
        keepInstanceIds: [`pinst_${'0'.padStart(48, '0')}`],
        limit: overrides.limit ?? 500,
      }),
    now: () => now,
  });

beforeEach(cleanup);
afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanup();
});

describe('platform instance registry cleanup worker runtime', () => {
  const production = {
    DATABASE_URL: 'postgres://localhost/test',
    NODE_ENV: 'production',
  } satisfies Partial<NodeJS.ProcessEnv>;

  it('runs only in a persistent Node runtime with database OIDC enabled', () => {
    // Database OIDC is on by default, so "disabled" has to be stated explicitly.
    expect(
      isPlatformInstanceRegistryCleanupWorkerRuntime({
        ...production,
        ENABLE_DATABASE_OIDC: '0',
      }),
    ).toBe(false);
    expect(
      isPlatformInstanceRegistryCleanupWorkerRuntime({
        ...production,
        ENABLE_DATABASE_OIDC: '1',
      }),
    ).toBe(true);
  });

  it('never runs on serverless hosts', () => {
    for (const serverless of [
      { AWS_LAMBDA_FUNCTION_NAME: 'handler' },
      { NEXT_RUNTIME: 'edge' },
      { VERCEL: '1' },
    ]) {
      expect(
        isPlatformInstanceRegistryCleanupWorkerRuntime({
          ...production,
          ENABLE_DATABASE_OIDC: '1',
          ...serverless,
        }),
      ).toBe(false);
    }
  });
});

describe('runPlatformInstanceRegistryCleanup', () => {
  it('performs zero database work when database OIDC is disabled', async () => {
    vi.stubEnv('ENABLE_DATABASE_OIDC', '0');
    const acquireDatabase = vi.fn().mockRejectedValue(new Error('database must not be accessed'));

    await expect(runPlatformInstanceRegistryCleanup({ acquireDatabase })).resolves.toEqual({
      identityInstances: 0,
      platformInstances: 0,
      restartRequests: 0,
    });
    expect(acquireDatabase).not.toHaveBeenCalled();
  });

  it('reaps expired registrations, keeps the local row, and converges to a no-op', async () => {
    vi.stubEnv('ENABLE_DATABASE_OIDC', '1');
    await seedExpired(3);
    // Live rows must survive whatever the retention window says.
    await db.insert(platformInstanceHeartbeats).values({
      instanceId: `pinst_${'f'.repeat(48)}`,
      lastHeartbeatAt: now,
      startedAt: new Date(now.getTime() - 60_000),
    });

    await expect(run()).resolves.toEqual({
      identityInstances: 3,
      platformInstances: 2,
      restartRequests: 0,
    });
    expect(
      (await db.select().from(platformInstanceHeartbeats))
        .map(({ instanceId }) => instanceId)
        .sort(),
    ).toEqual([`pinst_${'0'.padStart(48, '0')}`, `pinst_${'f'.repeat(48)}`].sort());
    await expect(run()).resolves.toEqual({
      identityInstances: 0,
      platformInstances: 0,
      restartRequests: 0,
    });
  });

  it('loops bounded passes until the backlog is drained', async () => {
    vi.stubEnv('ENABLE_DATABASE_OIDC', '1');
    await seedExpired(6);

    await expect(run({ limit: 2 })).resolves.toEqual({
      identityInstances: 6,
      platformInstances: 5,
      restartRequests: 0,
    });
    expect(await db.select().from(platformIdentityProviderInstances)).toEqual([]);
  });

  it('imports and remains idle in production with the flag off and no database secrets', async () => {
    const moduleUrl = new URL('./platformInstanceRegistryCleanup.ts', import.meta.url).href;
    const script = `
      globalThis.setTimeout = () => { throw new Error('timer must not be created'); };
      const job = await import(${JSON.stringify(moduleUrl)});
      job.ensurePlatformInstanceRegistryCleanupStarted();
      const deleted = await job.runPlatformInstanceRegistryCleanup();
      const total = deleted.identityInstances + deleted.platformInstances + deleted.restartRequests;
      if (total !== 0) throw new Error('flag-off cleanup must be empty');
      process.stdout.write('flag-off-import-ok');
    `;
    const env = { ...process.env };
    delete env.DATABASE_URL;
    delete env.KEY_VAULTS_SECRET;
    Object.assign(env, {
      ENABLE_DATABASE_OIDC: '0',
      NEXT_RUNTIME: 'nodejs',
      NODE_ENV: 'production',
    });
    const { stderr, stdout } = await execFileAsync('bun', ['--eval', script], {
      cwd: process.cwd(),
      env,
    });

    expect({ stderr, stdout }).toEqual({ stderr: '', stdout: 'flag-off-import-ok' });
  });
});
