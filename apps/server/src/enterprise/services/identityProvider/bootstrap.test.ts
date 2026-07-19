// @vitest-environment node
import { PHASE_PRODUCTION_BUILD } from 'next/constants';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  bootstrapIdentityProviderRuntime,
  resetIdentityProviderBootstrapForTest,
} from './bootstrap';

const mocks = vi.hoisted(() => ({
  commitIdentityProviderStartupSnapshot: vi.fn(),
  loadIdentityProviderStartupSnapshot: vi.fn(async () => ({
    databaseProviders: [],
    generation: null,
    health: 'healthy' as const,
    identityRevision: null,
    lastError: null,
    loadedAt: new Date(),
    providerIds: [],
    source: 'environment' as const,
  })),
  parseEnvironmentIdentityProviderIds: vi.fn(() => ['github', 'work-account']),
  registerIdentityProviderInstance: vi.fn(),
}));

vi.mock('../../featureFlags', () => ({
  parseEnterpriseFeatureFlags: () => ({ ENABLE_DATABASE_OIDC: false }),
}));
vi.mock('./instanceRegistry', () => ({
  markIdentityProviderInstanceRegistrationFailed: vi.fn(),
  registerIdentityProviderInstance: mocks.registerIdentityProviderInstance,
}));
vi.mock('./startupSnapshot', () => ({
  loadIdentityProviderStartupSnapshot: mocks.loadIdentityProviderStartupSnapshot,
  parseEnvironmentIdentityProviderIds: mocks.parseEnvironmentIdentityProviderIds,
}));
vi.mock('./startupArtifact', () => ({
  commitIdentityProviderStartupSnapshot: mocks.commitIdentityProviderStartupSnapshot,
}));

beforeEach(() => {
  delete process.env.AUTH_SSO_PROVIDERS;
  delete process.env.NEXT_PHASE;
  resetIdentityProviderBootstrapForTest();
  mocks.commitIdentityProviderStartupSnapshot.mockClear();
  mocks.loadIdentityProviderStartupSnapshot.mockClear();
  mocks.parseEnvironmentIdentityProviderIds.mockClear();
  mocks.registerIdentityProviderInstance.mockClear();
});

describe('identity provider worker bootstrap', () => {
  it('shares one singleflight across concurrent callers and duplicate module evaluation', async () => {
    await Promise.all([
      bootstrapIdentityProviderRuntime(),
      bootstrapIdentityProviderRuntime(),
      bootstrapIdentityProviderRuntime(),
    ]);
    expect(mocks.loadIdentityProviderStartupSnapshot).toHaveBeenCalledOnce();

    vi.resetModules();
    const duplicateChunk = await import('./bootstrap');
    await duplicateChunk.bootstrapIdentityProviderRuntime();
    expect(mocks.loadIdentityProviderStartupSnapshot).toHaveBeenCalledOnce();
  });

  it('does not load or register runtime state while Next is producing build artifacts', async () => {
    process.env.NEXT_PHASE = PHASE_PRODUCTION_BUILD;
    process.env.AUTH_SSO_PROVIDERS = ' GitHub, github, Work-Account ';

    await bootstrapIdentityProviderRuntime();

    expect(mocks.loadIdentityProviderStartupSnapshot).not.toHaveBeenCalled();
    expect(mocks.parseEnvironmentIdentityProviderIds).toHaveBeenCalledWith(process.env);
    expect(mocks.registerIdentityProviderInstance).not.toHaveBeenCalled();
    expect(mocks.commitIdentityProviderStartupSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        databaseProviders: [],
        loadedAt: new Date(0),
        providerIds: ['github', 'work-account'],
        source: 'environment',
      }),
    );
  });
});
