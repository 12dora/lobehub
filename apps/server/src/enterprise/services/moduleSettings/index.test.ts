// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ALL_MODULES_ENABLED, PLATFORM_ERROR_CODES } from '@/const/platform';

import { getEnterpriseErrorBody } from '../../guards/enterpriseErrors';
import {
  assertModuleEnabled,
  getModuleSettingsSnapshot,
  getPendingRestartModules,
  initBootModules,
  isBootModuleEnabled,
  isModuleEnabled,
  resetModuleSettingsForTest,
  updateModuleSettings,
} from './index';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  upsertWithCas: vi.fn(),
  publish: vi.fn(async () => undefined),
  getScopeVersion: vi.fn(async () => '0'),
}));

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(async () => ({})),
}));

vi.mock('@/database/models/platform/moduleSettings', () => ({
  PlatformModuleSettingsModel: class {
    get = mocks.get;
    upsertWithCas = mocks.upsertWithCas;
  },
  PLATFORM_MODULE_SETTINGS_ID: 'global',
}));

vi.mock('../platformConfigInvalidation', () => ({
  getPlatformConfigInvalidationPublisher: () => ({
    getScopeVersion: mocks.getScopeVersion,
    publish: mocks.publish,
  }),
  getPlatformConfigScopeVersion: mocks.getScopeVersion,
}));

beforeEach(() => {
  resetModuleSettingsForTest();
  mocks.get.mockReset();
  mocks.upsertWithCas.mockReset();
  mocks.publish.mockClear();
  mocks.getScopeVersion.mockReset();
  mocks.getScopeVersion.mockResolvedValue('0');
  vi.unstubAllEnvs();
  vi.stubEnv('ENABLE_PLATFORM_ADMIN', '1');
  vi.stubEnv('ENABLE_PLATFORM_MANAGED_AI', '1');
  vi.stubEnv('ENABLE_PLATFORM_MANAGED_SKILLS', '1');
  vi.stubEnv('ENABLE_PLATFORM_MANAGED_CONNECTORS', '1');
  vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '1');
  vi.stubEnv('ENABLE_PLATFORM_SETTINGS_POLICY', '1');
  vi.stubEnv('ENABLE_RUNTIME_BRANDING', '1');
  vi.stubEnv('ENABLE_DATABASE_OIDC', '1');
});

afterEach(() => {
  resetModuleSettingsForTest();
  vi.unstubAllEnvs();
});

describe('getModuleSettingsSnapshot', () => {
  it('treats a missing row as all-on', async () => {
    mocks.get.mockResolvedValue(null);
    const snapshot = await getModuleSettingsSnapshot();
    expect(snapshot.db).toBeNull();
    expect(snapshot.revision).toBe(0);
    expect(snapshot.setupCompletedAt).toBeNull();
    expect(snapshot.effective).toEqual(ALL_MODULES_ENABLED);
    expect(snapshot.preset).toBe('full');
  });

  it('applies a partial DB row (unlisted modules stay on)', async () => {
    mocks.get.mockResolvedValue({
      modules: { audit: false },
      revision: 4,
      setupCompletedAt: new Date('2026-08-01T00:00:00.000Z'),
    });
    const snapshot = await getModuleSettingsSnapshot();
    expect(snapshot.db).toEqual({ audit: false });
    expect(snapshot.revision).toBe(4);
    expect(snapshot.effective.audit).toBe(false);
    expect(snapshot.effective.branding).toBe(true);
    expect(snapshot.setupCompletedAt).toBe('2026-08-01T00:00:00.000Z');
    expect(snapshot.preset).toBeNull();
  });

  it('lets env-forced-off win over a db true', async () => {
    vi.stubEnv('LOBE_MODULES_DISABLED', 'audit');
    mocks.get.mockResolvedValue({
      modules: { audit: true, branding: false },
      revision: 2,
      setupCompletedAt: null,
    });
    const snapshot = await getModuleSettingsSnapshot();
    expect(snapshot.effective.audit).toBe(false);
    expect(snapshot.envDisabled).toContain('audit');
    expect(snapshot.envDisabledBy.audit).toBe('LOBE_MODULES_DISABLED');
    expect(snapshot.effective.branding).toBe(false);
  });

  it('fail-opens to env-only when the DB throws and there is no LKG', async () => {
    mocks.get.mockRejectedValue(new Error('db down'));
    const snapshot = await getModuleSettingsSnapshot();
    expect(snapshot.db).toBeNull();
    expect(snapshot.effective).toEqual(ALL_MODULES_ENABLED);
  });

  it('invalidates the cache after a write', async () => {
    mocks.get.mockResolvedValue(null);
    await getModuleSettingsSnapshot();
    expect(mocks.get).toHaveBeenCalledTimes(1);

    await getModuleSettingsSnapshot();
    expect(mocks.get).toHaveBeenCalledTimes(1);

    mocks.upsertWithCas.mockResolvedValue({
      modules: { audit: false },
      revision: 1,
      setupCompletedAt: null,
    });
    // Authoritative pre-write read must still see the missing row (revision 0).
    mocks.get.mockResolvedValue(null);

    const updated = await updateModuleSettings({
      actorUserId: 'admin',
      expectedRevision: 0,
      modules: { audit: false },
    });
    expect(updated.effective.audit).toBe(false);
    expect(mocks.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceType: 'module_settings',
        revision: 1,
        scopes: ['modules'],
      }),
    );
    expect(mocks.get.mock.calls.length).toBeGreaterThan(1);
  });
});

describe('boot freeze', () => {
  it('does not change getBootModules after init when the hot snapshot flips', async () => {
    mocks.get.mockResolvedValue(null);
    const frozen = await initBootModules();
    expect(frozen.audit).toBe(true);

    // Force a new cache generation by bumping the scope epoch + returning a new row.
    mocks.getScopeVersion.mockResolvedValue('1');
    mocks.get.mockResolvedValue({
      modules: { audit: false },
      revision: 1,
      setupCompletedAt: null,
    });

    expect(isBootModuleEnabled('audit')).toBe(true);
    expect((await getModuleSettingsSnapshot()).effective.audit).toBe(false);
    expect(await getPendingRestartModules()).toContain('audit');
    expect(await isModuleEnabled('audit')).toBe(false);
  });
});

describe('assertModuleEnabled', () => {
  it('throws PLATFORM_MODULE_DISABLED when the module is off', async () => {
    vi.stubEnv('LOBE_MODULES_DISABLED', 'audit');
    mocks.get.mockResolvedValue(null);
    try {
      await assertModuleEnabled('audit');
      expect.fail('should throw');
    } catch (error) {
      expect((error as { code: string }).code).toBe('FORBIDDEN');
      expect(getEnterpriseErrorBody(error)?.code).toBe(
        PLATFORM_ERROR_CODES.PLATFORM_MODULE_DISABLED,
      );
      expect(getEnterpriseErrorBody(error)?.details).toEqual({ moduleId: 'audit' });
    }
  });
});
