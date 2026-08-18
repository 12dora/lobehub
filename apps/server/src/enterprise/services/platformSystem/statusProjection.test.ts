// @vitest-environment node
import { describe, expect, it } from 'vitest';

import type { IdentityProviderStartupHealth } from '../identityProvider/startupArtifact';
import { projectOidcStatus } from './statusProjection';

const health = (
  overrides: Partial<IdentityProviderStartupHealth> = {},
): IdentityProviderStartupHealth => ({
  generation: 'generation',
  health: 'healthy',
  identityRevision: 'a'.repeat(64),
  lastError: null,
  loadedAt: new Date('2026-08-18T00:00:00.000Z'),
  providerIds: [],
  source: 'database',
  ...overrides,
});

describe('projectOidcStatus', () => {
  it('does not treat a committed artifact as configured when no live SSO exists', () => {
    expect(
      projectOidcStatus({
        artifact: health({ providerIds: [], source: 'break_glass', health: 'degraded' }),
        authSnapshot: { pendingRestart: false },
        envSsoConfigured: false,
        flags: { ENABLE_DATABASE_OIDC: true },
        publishedSso: 'empty',
      }),
    ).toMatchObject({
      configured: false,
      source: 'break_glass',
      status: 'degraded',
    });
  });

  it('reports an empty healthy database snapshot as not configured', () => {
    expect(
      projectOidcStatus({
        artifact: health({ identityRevision: 'b'.repeat(64), providerIds: [] }),
        authSnapshot: { pendingRestart: false },
        envSsoConfigured: false,
        flags: { ENABLE_DATABASE_OIDC: true },
        publishedSso: 'empty',
      }),
    ).toMatchObject({
      configured: false,
      source: 'database',
      status: 'healthy',
    });
  });

  it('reports configured when the artifact has live provider ids', () => {
    expect(
      projectOidcStatus({
        artifact: health({ providerIds: ['work'] }),
        authSnapshot: { pendingRestart: false },
        envSsoConfigured: false,
        flags: { ENABLE_DATABASE_OIDC: true },
        publishedSso: 'empty',
      }).configured,
    ).toBe(true);
  });

  it('reports configured when published material exists without a process artifact', () => {
    expect(
      projectOidcStatus({
        artifact: null,
        authSnapshot: { pendingRestart: true },
        envSsoConfigured: false,
        flags: { ENABLE_DATABASE_OIDC: true },
        publishedSso: 'present',
      }),
    ).toMatchObject({
      configured: true,
      source: 'unknown',
      status: 'unavailable',
    });
  });

  it('keeps the feature-flag-off projection disabled when no env SSO is set', () => {
    expect(
      projectOidcStatus({
        artifact: null,
        authSnapshot: null,
        envSsoConfigured: false,
        flags: { ENABLE_DATABASE_OIDC: false },
        publishedSso: 'empty',
      }),
    ).toMatchObject({
      configured: false,
      source: 'disabled',
      status: 'disabled',
    });
  });

  it('reports environment SSO when the database-OIDC flag is off and env providers are set', () => {
    expect(
      projectOidcStatus({
        artifact: null,
        authSnapshot: null,
        envSsoConfigured: true,
        flags: { ENABLE_DATABASE_OIDC: false },
        publishedSso: 'empty',
      }),
    ).toMatchObject({
      configured: true,
      source: 'environment',
      status: 'healthy',
    });
  });

  it('fails closed when published selection cannot be loaded', () => {
    expect(
      projectOidcStatus({
        artifact: health({ providerIds: [] }),
        authSnapshot: { pendingRestart: false },
        envSsoConfigured: false,
        flags: { ENABLE_DATABASE_OIDC: true },
        publishedSso: 'lookup_failed',
      }),
    ).toMatchObject({
      configured: true,
      source: 'database',
      status: 'unavailable',
    });
  });
});
