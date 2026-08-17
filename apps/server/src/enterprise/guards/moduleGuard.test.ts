// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { authedProcedure, createCallerFactory, router } from '@/libs/trpc/lambda';

import { resetModuleSettingsForTest } from '../services/moduleSettings';
import { getEnterpriseErrorBody } from './enterpriseErrors';
import { withModule } from './moduleGuard';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(async () => ({})),
}));

vi.mock('@/database/models/platform/moduleSettings', () => ({
  PlatformModuleSettingsModel: class {
    get = mocks.get;
  },
  PLATFORM_MODULE_SETTINGS_ID: 'global',
}));

vi.mock('../services/platformConfigInvalidation', () => ({
  getPlatformConfigInvalidationPublisher: () => ({
    getScopeVersion: async () => '0',
    publish: async () => undefined,
  }),
  getPlatformConfigScopeVersion: async () => '0',
}));

const testRouter = router({
  agents: authedProcedure.use(withModule('managedAgents')).query(() => ({ ok: true })),
});

const createCaller = createCallerFactory(testRouter);

beforeEach(() => {
  resetModuleSettingsForTest();
  mocks.get.mockReset();
  mocks.get.mockResolvedValue(null);
  vi.unstubAllEnvs();
  vi.stubEnv('ENABLE_PLATFORM_ADMIN', '1');
  vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '1');
  vi.stubEnv('ENABLE_PLATFORM_MANAGED_AI', '1');
  vi.stubEnv('ENABLE_PLATFORM_MANAGED_SKILLS', '1');
  vi.stubEnv('ENABLE_PLATFORM_MANAGED_CONNECTORS', '1');
  vi.stubEnv('ENABLE_PLATFORM_SETTINGS_POLICY', '1');
  vi.stubEnv('ENABLE_RUNTIME_BRANDING', '1');
  vi.stubEnv('ENABLE_DATABASE_OIDC', '1');
});

afterEach(() => {
  resetModuleSettingsForTest();
  vi.unstubAllEnvs();
});

describe('withModule', () => {
  it('allows when the module is on', async () => {
    const caller = createCaller({ userId: 'user-1' } as never);
    await expect(caller.agents()).resolves.toEqual({ ok: true });
  });

  it('throws PLATFORM_MODULE_DISABLED when the module is off', async () => {
    vi.stubEnv('LOBE_MODULES_DISABLED', 'managedAgents');
    const caller = createCaller({ userId: 'user-1' } as never);
    try {
      await caller.agents();
      expect.fail('should throw');
    } catch (error) {
      expect((error as { code: string }).code).toBe('FORBIDDEN');
      expect(getEnterpriseErrorBody(error)?.code).toBe(
        PLATFORM_ERROR_CODES.PLATFORM_MODULE_DISABLED,
      );
      expect(getEnterpriseErrorBody(error)?.details).toEqual({ moduleId: 'managedAgents' });
    }
  });
});
