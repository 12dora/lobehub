// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import { resetIdentityProviderStartupArtifactForTest } from '@/server/enterprise/services/identityProvider/startupArtifact';

afterEach(() => {
  resetIdentityProviderStartupArtifactForTest();
});

describe('Better Auth startup artifact handoff', () => {
  it('bootstraps its own worker before Better Auth consumes the artifact', async () => {
    resetIdentityProviderStartupArtifactForTest();
    vi.resetModules();
    const independentlyEvaluatedAuthEntry = await import('./auth');

    expect(independentlyEvaluatedAuthEntry.auth).toBeDefined();
  });
});
