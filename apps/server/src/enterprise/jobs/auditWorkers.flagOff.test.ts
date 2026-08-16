// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isPlatformAgentRolloutWorkerRuntime } from './agentRollout';
import {
  __resetPlatformAuditExportWorkerForTests,
  ensurePlatformAuditExportWorkerStarted,
  isPlatformAuditExportWorkerRuntime,
} from './auditExport';
import {
  __resetPlatformAuditRetentionWorkerForTests,
  ensurePlatformAuditRetentionWorkerStarted,
  isPlatformAuditRetentionWorkerRuntime,
} from './auditRetention';
import { isIdentityProviderTestAttemptCleanupWorkerRuntime } from './identityProviderTestAttemptCleanup';

const getServerDB = vi.fn(async () => ({ mocked: true }));
const runAuditExportBatches = vi.fn(async (_db?: unknown) => 0);
const runAuditRetentionBatches = vi.fn(async (_db?: unknown) => 0);

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: () => getServerDB(),
}));

vi.mock('../services/audit/exportWorker', () => ({
  runAuditExportBatches: (db: unknown) => runAuditExportBatches(db),
}));

vi.mock('../services/audit/retentionWorker', () => ({
  runAuditRetentionBatches: (db: unknown) => runAuditRetentionBatches(db),
}));

const productionDb = {
  DATABASE_URL: 'postgres://localhost/test',
  NODE_ENV: 'production',
} satisfies Partial<NodeJS.ProcessEnv>;

const originalEnv = { ...process.env };

const restoreEnv = () => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
};

describe('enterprise persistent workers default-off + serverless guards', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getServerDB.mockClear();
    runAuditExportBatches.mockClear();
    runAuditRetentionBatches.mockClear();
    __resetPlatformAuditExportWorkerForTests();
    __resetPlatformAuditRetentionWorkerForTests();
    restoreEnv();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    restoreEnv();
    __resetPlatformAuditExportWorkerForTests();
    __resetPlatformAuditRetentionWorkerForTests();
  });

  it('audit workers stay off when ENABLE_PLATFORM_ADMIN is disabled', () => {
    // Platform admin is on by default now, so "off" is an explicit falsy value.
    const adminOff = { ...productionDb, ENABLE_PLATFORM_ADMIN: '0' };
    expect(isPlatformAuditExportWorkerRuntime(adminOff)).toBe(false);
    expect(isPlatformAuditRetentionWorkerRuntime(adminOff)).toBe(false);
    expect(
      isPlatformAuditExportWorkerRuntime({
        ...productionDb,
        ENABLE_PLATFORM_ADMIN: '0',
      }),
    ).toBe(false);
  });

  it('audit workers start only with ENABLE_PLATFORM_ADMIN on persistent runtime', () => {
    expect(
      isPlatformAuditExportWorkerRuntime({
        ...productionDb,
        ENABLE_PLATFORM_ADMIN: '1',
      }),
    ).toBe(true);
    expect(
      isPlatformAuditRetentionWorkerRuntime({
        ...productionDb,
        ENABLE_PLATFORM_ADMIN: '1',
      }),
    ).toBe(true);
  });

  it('rejects AWS Lambda for audit, rollout, and identity cleanup workers', () => {
    const lambda = {
      ...productionDb,
      AWS_LAMBDA_FUNCTION_NAME: 'handler',
      ENABLE_DATABASE_OIDC: '1',
      ENABLE_PLATFORM_ADMIN: '1',
      ENABLE_PLATFORM_MANAGED_AGENTS: '1',
      NEXT_RUNTIME: 'nodejs',
    };
    expect(isPlatformAuditExportWorkerRuntime(lambda)).toBe(false);
    expect(isPlatformAuditRetentionWorkerRuntime(lambda)).toBe(false);
    expect(isPlatformAgentRolloutWorkerRuntime(lambda)).toBe(false);
    expect(isIdentityProviderTestAttemptCleanupWorkerRuntime(lambda)).toBe(false);
  });

  it('ensure*Started is a no-op when flag is off: zero timers, DB, or batch work', async () => {
    Object.assign(process.env, {
      ...productionDb,
      ENABLE_PLATFORM_ADMIN: '0',
    });
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    delete process.env.VERCEL;
    delete process.env.VERCEL_ENV;

    ensurePlatformAuditExportWorkerStarted();
    ensurePlatformAuditRetentionWorkerStarted();

    await vi.advanceTimersByTimeAsync(30_000);

    expect(getServerDB).not.toHaveBeenCalled();
    expect(runAuditExportBatches).not.toHaveBeenCalled();
    expect(runAuditRetentionBatches).not.toHaveBeenCalled();
  });

  it('ensure*Started does not poll when runtime is AWS Lambda even if flag is on', async () => {
    Object.assign(process.env, {
      ...productionDb,
      AWS_LAMBDA_FUNCTION_NAME: 'handler',
      ENABLE_PLATFORM_ADMIN: '1',
    });

    ensurePlatformAuditExportWorkerStarted();
    ensurePlatformAuditRetentionWorkerStarted();

    await vi.advanceTimersByTimeAsync(30_000);

    expect(getServerDB).not.toHaveBeenCalled();
    expect(runAuditExportBatches).not.toHaveBeenCalled();
    expect(runAuditRetentionBatches).not.toHaveBeenCalled();
  });
});
