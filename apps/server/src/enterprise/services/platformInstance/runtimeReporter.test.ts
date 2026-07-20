// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlatformInstanceRepository } from '@/database/repositories/platformInstance';
import type { PlatformInstanceRevisionStateItem } from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import {
  classifyRuntimeMaterializationError,
  reportPlatformRuntimeMaterialization,
  resetPlatformRuntimeReporterForTest,
  waitForPlatformRuntimeReportsForTest,
} from './runtimeReporter';

const database = {} as LobeChatDatabase;
const instanceId = `pinst_${'a'.repeat(48)}`;
const productionEnv = (): Record<string, string | undefined> => ({
  DATABASE_URL: 'postgresql://database.invalid/lobehub',
  ENABLE_PLATFORM_SETTINGS_POLICY: '1',
  NEXT_RUNTIME: 'nodejs',
  NODE_ENV: 'production',
});

const persistedState: PlatformInstanceRevisionStateItem = {
  domain: 'settings',
  errorCategory: null,
  health: 'healthy',
  instanceId,
  loadedAt: new Date(0),
  loadedRevision: 1,
  loadedRevisionId: null,
  loadMode: 'process_cached',
  source: 'database',
};

const createTarget = () => ({
  upsertRevisionState: vi
    .fn<PlatformInstanceRepository['upsertRevisionState']>()
    .mockResolvedValue(persistedState),
});

beforeEach(() => {
  resetPlatformRuntimeReporterForTest();
});

describe('platform instance runtime reporter', () => {
  it('gates unsupported runtimes before repository or instance identity access', async () => {
    const createRepository = vi.fn();
    const getInstanceId = vi.fn();

    reportPlatformRuntimeMaterialization(
      database,
      { domain: 'settings', health: 'healthy', revision: 1, source: 'database' },
      {
        createRepository,
        env: { ...productionEnv(), ENABLE_PLATFORM_SETTINGS_POLICY: '0' },
        getInstanceId,
      },
    );
    await waitForPlatformRuntimeReportsForTest();

    expect(createRepository).not.toHaveBeenCalled();
    expect(getInstanceId).not.toHaveBeenCalled();
  });

  it('deduplicates concurrent semantic state and writes the exact closed projection', async () => {
    const target = createTarget();
    const options = {
      createRepository: () => target,
      env: productionEnv(),
      getInstanceId: () => instanceId,
    };
    const input = {
      domain: 'settings' as const,
      health: 'healthy' as const,
      revision: 7,
      source: 'database' as const,
    };

    reportPlatformRuntimeMaterialization(database, input, options);
    reportPlatformRuntimeMaterialization(database, input, options);
    reportPlatformRuntimeMaterialization(database, input, options);
    await waitForPlatformRuntimeReportsForTest();

    expect(target.upsertRevisionState).toHaveBeenCalledOnce();
    expect(target.upsertRevisionState).toHaveBeenCalledWith({
      domain: 'settings',
      errorCategory: null,
      health: 'healthy',
      instanceId,
      loadedRevision: 7,
      loadedRevisionId: null,
      loadMode: 'process_cached',
      source: 'database',
    });
  });

  it('writes changed revisions but does not refresh an unchanged cache hit', async () => {
    const target = createTarget();
    const options = {
      createRepository: () => target,
      env: productionEnv(),
      getInstanceId: () => instanceId,
    };

    reportPlatformRuntimeMaterialization(
      database,
      { domain: 'branding', health: 'healthy', revision: 1, source: 'database' },
      options,
    );
    await waitForPlatformRuntimeReportsForTest();
    reportPlatformRuntimeMaterialization(
      database,
      { domain: 'branding', health: 'healthy', revision: 1, source: 'database' },
      options,
    );
    reportPlatformRuntimeMaterialization(
      database,
      { domain: 'branding', health: 'healthy', revision: 2, source: 'database' },
      options,
    );
    await waitForPlatformRuntimeReportsForTest();

    expect(target.upsertRevisionState).toHaveBeenCalledTimes(2);
    expect(target.upsertRevisionState.mock.calls[1]?.[0]).toMatchObject({
      domain: 'branding',
      loadedRevision: 2,
    });
  });

  it('persists an immutable catalog token without either catalog coordinates or a number token', async () => {
    const target = createTarget();
    const revisionId = 'b'.repeat(64);

    reportPlatformRuntimeMaterialization(
      database,
      { domain: 'ai_catalog', health: 'healthy', revisionId, source: 'database' },
      {
        createRepository: () => target,
        env: productionEnv(),
        getInstanceId: () => instanceId,
      },
    );
    await waitForPlatformRuntimeReportsForTest();

    expect(target.upsertRevisionState).toHaveBeenCalledWith({
      domain: 'ai_catalog',
      errorCategory: null,
      health: 'healthy',
      instanceId,
      loadedRevision: null,
      loadedRevisionId: revisionId,
      loadMode: 'process_cached',
      source: 'database',
    });
    expect(JSON.stringify(target.upsertRevisionState.mock.calls)).not.toContain('providerKey');
  });

  it('preserves failure to success convergence for the same target revision', async () => {
    const target = createTarget();
    const options = {
      createRepository: () => target,
      env: productionEnv(),
      getInstanceId: () => instanceId,
    };

    reportPlatformRuntimeMaterialization(
      database,
      {
        domain: 'settings',
        errorCategory: 'database_unavailable',
        health: 'unavailable',
        source: 'unavailable',
      },
      options,
    );
    reportPlatformRuntimeMaterialization(
      database,
      { domain: 'settings', health: 'healthy', revision: 4, source: 'database' },
      options,
    );
    await waitForPlatformRuntimeReportsForTest();

    expect(target.upsertRevisionState).toHaveBeenCalledTimes(2);
    expect(target.upsertRevisionState.mock.calls.map(([state]) => state)).toEqual([
      {
        domain: 'settings',
        errorCategory: 'database_unavailable',
        health: 'unavailable',
        instanceId,
        loadedRevision: null,
        loadedRevisionId: null,
        loadMode: 'process_cached',
        source: 'unavailable',
      },
      {
        domain: 'settings',
        errorCategory: null,
        health: 'healthy',
        instanceId,
        loadedRevision: 4,
        loadedRevisionId: null,
        loadMode: 'process_cached',
        source: 'database',
      },
    ]);
  });

  it('contains repository and failure-observer errors and permits a semantic retry', async () => {
    const target = createTarget();
    target.upsertRevisionState
      .mockRejectedValueOnce(new Error('raw repository detail'))
      .mockResolvedValueOnce(persistedState);
    const observeFailure = vi.fn(() => {
      throw new Error('raw observer detail');
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const options = {
      createRepository: () => target,
      env: productionEnv(),
      getInstanceId: () => instanceId,
      observeFailure,
    };
    const input = {
      domain: 'settings' as const,
      health: 'healthy' as const,
      revision: 8,
      source: 'database' as const,
    };

    reportPlatformRuntimeMaterialization(database, input, options);
    await waitForPlatformRuntimeReportsForTest();
    reportPlatformRuntimeMaterialization(database, input, options);
    await waitForPlatformRuntimeReportsForTest();

    expect(target.upsertRevisionState).toHaveBeenCalledTimes(2);
    expect(observeFailure).toHaveBeenCalledWith({
      domain: 'settings',
      errorClass: 'UnexpectedError',
    });
    expect(JSON.stringify(observeFailure.mock.calls)).not.toContain('raw repository detail');
    expect(consoleError).toHaveBeenCalledWith(
      '[platform-instance-runtime] failure observer unavailable',
    );
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('raw observer detail');
    consoleError.mockRestore();
  });

  it('maps only stable error classes to the closed materialization categories', () => {
    expect(
      classifyRuntimeMaterializationError(
        Object.assign(new Error('detail'), { code: 'ECONNREFUSED' }),
      ),
    ).toBe('database_unavailable');
    expect(
      classifyRuntimeMaterializationError(
        Object.assign(new Error('detail'), { code: 'PLATFORM_CONFIG_VALIDATION_FAILED' }),
      ),
    ).toBe('configuration_invalid');
    expect(classifyRuntimeMaterializationError(new Error('detail'))).toBe('load_failed');
  });
});
