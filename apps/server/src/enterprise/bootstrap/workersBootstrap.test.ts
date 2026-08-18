// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MODULE_BY_WORKER_NAME } from '@/const/platform/modules';

import type { WorkerSpec } from './workersBootstrap';
import {
  ENTERPRISE_WORKER_SPECS,
  resetEnterpriseWorkersBootstrapForTest,
  startEnterpriseWorkers,
} from './workersBootstrap';

const mocks = vi.hoisted(() => ({
  ensureRunning: vi.fn().mockResolvedValue(undefined),
  isBootModuleEnabled: vi.fn((id: string) => id !== 'audit'),
  isModuleEnabled: vi.fn(async (_id: string) => true),
}));

vi.mock('../services/moduleSettings', () => ({
  isBootModuleEnabled: (id: string) => mocks.isBootModuleEnabled(id),
  isModuleEnabled: (id: string) => mocks.isModuleEnabled(id),
}));

vi.mock('@/server/services/gateway', () => ({
  GatewayService: class {
    ensureRunning = mocks.ensureRunning;
  },
}));

afterEach(() => {
  resetEnterpriseWorkersBootstrapForTest();
  vi.clearAllMocks();
});

describe('ENTERPRISE_WORKER_SPECS', () => {
  it('registers every module-owned worker name in MODULE_BY_WORKER_NAME', () => {
    for (const spec of ENTERPRISE_WORKER_SPECS) {
      if (spec.name in MODULE_BY_WORKER_NAME) {
        expect(MODULE_BY_WORKER_NAME[spec.name]).toBe(spec.moduleId);
      }
    }
    for (const [name, moduleId] of Object.entries(MODULE_BY_WORKER_NAME)) {
      const spec = ENTERPRISE_WORKER_SPECS.find((item) => item.name === name);
      expect(spec, `missing worker spec for ${name}`).toBeDefined();
      expect(spec?.moduleId).toBe(moduleId);
    }
  });
});

describe('startEnterpriseWorkers', () => {
  beforeEach(() => {
    mocks.isBootModuleEnabled.mockImplementation((id) => id !== 'audit');
  });

  it('does not call start when the owning module is disabled', async () => {
    const started: string[] = [];
    const specs: WorkerSpec[] = [
      {
        moduleId: 'audit',
        name: 'auditExport',
        start: () => {
          started.push('auditExport');
        },
      },
      {
        moduleId: 'branding',
        name: 'brandingAssetCleanup',
        start: () => {
          started.push('brandingAssetCleanup');
        },
      },
    ];
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    await startEnterpriseWorkers(specs);

    expect(started).toEqual(['brandingAssetCleanup']);
    expect(info).toHaveBeenCalledWith(
      '[modules] worker auditExport skipped: module audit disabled',
    );
    info.mockRestore();
  });

  it('keeps starting remaining specs when one start throws', async () => {
    const started: string[] = [];
    const specs: WorkerSpec[] = [
      {
        name: 'boom',
        start: () => {
          throw new Error('nope');
        },
      },
      {
        name: 'ok',
        start: () => {
          started.push('ok');
        },
      },
    ];
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await startEnterpriseWorkers(specs);

    expect(started).toEqual(['ok']);
    expect(error).toHaveBeenCalledWith('[modules] worker boom failed to start', {
      errorClass: 'Error',
    });
    error.mockRestore();
  });

  it('starts GatewayService exactly once through the real registry spec', async () => {
    mocks.isBootModuleEnabled.mockReturnValue(true);
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DATABASE_URL', 'postgres://localhost/test');
    vi.stubEnv('VERCEL_ENV', '');

    const spec = ENTERPRISE_WORKER_SPECS.find((item) => item.name === 'gatewayService');
    expect(spec?.moduleId).toBe('bots');
    await startEnterpriseWorkers([spec!]);

    expect(mocks.ensureRunning).toHaveBeenCalledTimes(1);
    vi.unstubAllEnvs();
  });
});

describe('HOT readiness registrations', () => {
  // Cold-import of skill/connector readiness graphs can exceed the default 10s hook
  // when this file runs in parallel with other enterprise suites.
  beforeEach(async () => {
    const { resetAiCatalogReadinessRegistrationForTest } =
      await import('../services/aiCatalog/runtimeReadiness');
    const { resetSkillCatalogReadinessRegistrationForTest } =
      await import('../services/skillCatalog/runtimeReadiness');
    const { resetConnectorCatalogReadinessRegistrationForTest } =
      await import('../services/connectorCatalog/runtimeReadiness');
    const { clearManagedResourceReadinessForTest } =
      await import('../services/managedResourceReadiness');
    resetAiCatalogReadinessRegistrationForTest();
    resetSkillCatalogReadinessRegistrationForTest();
    resetConnectorCatalogReadinessRegistrationForTest();
    clearManagedResourceReadinessForTest();
    mocks.isBootModuleEnabled.mockReturnValue(false);
    mocks.isModuleEnabled.mockResolvedValue(false);
  }, 60_000);

  it('registers aiCatalogReadiness even when managedAi is boot-disabled, then answers after hot-enable', async () => {
    const spec = ENTERPRISE_WORKER_SPECS.find((item) => item.name === 'aiCatalogReadiness')!;
    await expect(spec.start()).resolves.toBeUndefined();

    const { hasManagedResourceReadinessProbeForTest, resolveManagedResourceReadiness } =
      await import('../services/managedResourceReadiness');
    expect(hasManagedResourceReadinessProbeForTest('aiProviders')).toBe(true);

    const disabled = await resolveManagedResourceReadiness();
    expect(disabled.aiProviders).toBe(false);

    mocks.isModuleEnabled.mockImplementation(async (id) => id === 'managedAi');
    const enabled = await resolveManagedResourceReadiness();
    expect(typeof enabled.aiProviders).toBe('boolean');
  });

  it('does not throw ReferenceError when the unmocked aiCatalogReadiness spec starts', async () => {
    const spec = ENTERPRISE_WORKER_SPECS.find((item) => item.name === 'aiCatalogReadiness')!;
    await expect(spec.start()).resolves.toBeUndefined();
  });
});
