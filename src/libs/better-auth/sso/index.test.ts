// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  build: vi.fn(() => ({
    clientId: 'client-id',
    providerId: 'generic-oidc',
  })),
}));

vi.mock('@/envs/app', () => ({
  appEnv: { APP_URL: 'https://app.example.test' },
}));

vi.mock('@/envs/auth', () => ({
  authEnv: { AUTH_SSO_PROVIDERS: 'generic-oidc' },
}));

vi.mock('@/libs/better-auth/utils/server', () => ({
  parseSSOProviders: vi.fn(() => ['generic-oidc']),
}));

vi.mock('./providers/generic-oidc', () => ({
  default: {
    build: mocks.build,
    checkEnvs: () => ({ configured: true }),
    id: 'generic-oidc',
    type: 'generic',
  },
}));

describe('initBetterAuthSSOProviders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses the Better Auth Generic OAuth callback route', async () => {
    const { initBetterAuthSSOProviders } = await import('.');

    const { genericOAuthProviders } = initBetterAuthSSOProviders();

    expect(genericOAuthProviders).toHaveLength(1);
    expect(genericOAuthProviders[0]).toMatchObject({
      providerId: 'generic-oidc',
      redirectURI: 'https://app.example.test/api/auth/oauth2/callback/generic-oidc',
    });
  });
});
