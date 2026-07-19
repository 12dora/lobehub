// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  bootstrapIdentityProviderRuntime,
  resetIdentityProviderBootstrapForTest,
} from './bootstrap';

const mocks = vi.hoisted(() => ({
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
}));

vi.mock('../../featureFlags', () => ({
  parseEnterpriseFeatureFlags: () => ({ ENABLE_DATABASE_OIDC: false }),
}));
vi.mock('./instanceRegistry', () => ({
  markIdentityProviderInstanceRegistrationFailed: vi.fn(),
  registerIdentityProviderInstance: vi.fn(),
}));
vi.mock('./startupSnapshot', () => ({
  loadIdentityProviderStartupSnapshot: mocks.loadIdentityProviderStartupSnapshot,
}));

beforeEach(() => {
  resetIdentityProviderBootstrapForTest();
  mocks.loadIdentityProviderStartupSnapshot.mockClear();
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
});
