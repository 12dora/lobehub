// @vitest-environment node
/**
 * Characterization of the published-payload read boundary (generic OIDC).
 *
 * Records current accept/reject behaviour before flattening
 * `parsePublishedIdentityProviderPayload`. DingTalk-shaped cases live in
 * `publishedPayload.dingtalk.test.ts`.
 */
import { GENERIC_OIDC_IDENTITY_PROVIDER_TEMPLATE } from '@lobechat/types';
import { describe, expect, it } from 'vitest';

import { parsePublishedIdentityProviderPayload } from './publishedPayload';

const oidcPayload = (overrides: Record<string, unknown> = {}) => ({
  autoProvision: true,
  buttonLabel: 'Sign in with work',
  claimMapping: structuredClone(GENERIC_OIDC_IDENTITY_PROVIDER_TEMPLATE.claimMapping),
  clientId: 'client-id',
  dingtalkAllowedCorps: [],
  displayName: 'Work',
  domainAllowlist: [],
  enabled: true,
  groupRoleMapping: {},
  icon: null,
  issuer: 'https://login.example.test',
  providerKey: 'work',
  scopes: [...GENERIC_OIDC_IDENTITY_PROVIDER_TEMPLATE.scopes],
  secretFingerprint: 'a'.repeat(64),
  secretUpdatedAt: '2026-01-01T00:00:00.000Z',
  type: 'generic_oidc',
  usePkce: true,
  ...overrides,
});

describe('parsePublishedIdentityProviderPayload', () => {
  it('accepts a canonical generic-OIDC payload with and without secretUpdatedAt', () => {
    const withSecretTime = oidcPayload();
    expect(parsePublishedIdentityProviderPayload(withSecretTime)).toEqual(withSecretTime);

    const { secretUpdatedAt: _secretUpdatedAt, ...withoutSecretTime } = oidcPayload();
    expect(parsePublishedIdentityProviderPayload(withoutSecretTime)).toEqual({
      ...withoutSecretTime,
      secretUpdatedAt: undefined,
    });
  });

  it('rejects an unknown extra key', () => {
    expect(parsePublishedIdentityProviderPayload(oidcPayload({ extra: true }))).toBeNull();
  });

  it('rejects scopes without openid, with duplicates, or with a non-printable item', () => {
    expect(
      parsePublishedIdentityProviderPayload(oidcPayload({ scopes: ['profile', 'email'] })),
    ).toBeNull();
    expect(
      parsePublishedIdentityProviderPayload(oidcPayload({ scopes: ['openid', 'openid'] })),
    ).toBeNull();
    expect(
      parsePublishedIdentityProviderPayload(oidcPayload({ scopes: ['openid', 'has space'] })),
    ).toBeNull();
    expect(
      parsePublishedIdentityProviderPayload(oidcPayload({ scopes: ['openid', 'bad\u0007scope'] })),
    ).toBeNull();
  });

  it('rejects an issuer that is http, has credentials, a non-443 port, a query, or a fragment', () => {
    for (const issuer of [
      'http://login.example.test',
      'https://user:pass@login.example.test',
      'https://login.example.test:8443',
      'https://login.example.test?x=1',
      'https://login.example.test#frag',
    ]) {
      expect(parsePublishedIdentityProviderPayload(oidcPayload({ issuer })), issuer).toBeNull();
    }
  });

  it('rejects a providerKey that fails the published-key pattern', () => {
    expect(parsePublishedIdentityProviderPayload(oidcPayload({ providerKey: 'Work' }))).toBeNull();
  });

  it('rejects a secretFingerprint that is not 64 lowercase hex', () => {
    expect(
      parsePublishedIdentityProviderPayload(oidcPayload({ secretFingerprint: 'a'.repeat(63) })),
    ).toBeNull();
  });

  it('rejects a non-canonical secretUpdatedAt ISO string', () => {
    expect(
      parsePublishedIdentityProviderPayload(
        oidcPayload({ secretUpdatedAt: '2026-01-01T00:00:00Z' }),
      ),
    ).toBeNull();
  });

  it('rejects an untrimmed or over-length buttonLabel or displayName', () => {
    expect(
      parsePublishedIdentityProviderPayload(oidcPayload({ buttonLabel: ' Sign in with work' })),
    ).toBeNull();
    expect(
      parsePublishedIdentityProviderPayload(oidcPayload({ buttonLabel: 'x'.repeat(201) })),
    ).toBeNull();
    expect(parsePublishedIdentityProviderPayload(oidcPayload({ displayName: 'Work ' }))).toBeNull();
    expect(
      parsePublishedIdentityProviderPayload(oidcPayload({ displayName: 'x'.repeat(201) })),
    ).toBeNull();
  });

  it('rejects a domainAllowlist entry of 254 characters or more than 256 entries', () => {
    expect(
      parsePublishedIdentityProviderPayload(oidcPayload({ domainAllowlist: ['a'.repeat(254)] })),
    ).toBeNull();
    expect(
      parsePublishedIdentityProviderPayload(
        oidcPayload({
          domainAllowlist: Array.from({ length: 257 }, (_, index) => `d${index}.test`),
        }),
      ),
    ).toBeNull();
  });

  it('rejects a groupRoleMapping with an empty value or more than 1024 keys', () => {
    expect(
      parsePublishedIdentityProviderPayload(oidcPayload({ groupRoleMapping: { team: '' } })),
    ).toBeNull();
    expect(
      parsePublishedIdentityProviderPayload(
        oidcPayload({
          groupRoleMapping: Object.fromEntries(
            Array.from({ length: 1025 }, (_, index) => [`k${index}`, 'role']),
          ),
        }),
      ),
    ).toBeNull();
  });
});
