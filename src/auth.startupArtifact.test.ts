// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  commitIdentityProviderStartupSnapshot,
  resetIdentityProviderStartupArtifactForTest,
} from '@/server/enterprise/services/identityProvider/startupArtifact';

afterEach(() => {
  resetIdentityProviderStartupArtifactForTest();
});

describe('Better Auth startup artifact handoff', () => {
  it('consumes the artifact committed by an independently evaluated server chunk', async () => {
    resetIdentityProviderStartupArtifactForTest();
    commitIdentityProviderStartupSnapshot({
      databaseProviders: [],
      generation: 'better-auth-generation',
      health: 'healthy',
      identityRevision: null,
      lastError: null,
      loadedAt: new Date(),
      providerIds: ['work'],
      source: 'environment',
    });
    vi.resetModules();
    const independentlyEvaluatedAuthEntry = await import('./auth');

    expect(independentlyEvaluatedAuthEntry.auth).toBeDefined();
  });
});
