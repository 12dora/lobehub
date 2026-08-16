// @vitest-environment node
/**
 * Read-boundary regression for the DingTalk fixed identity contract.
 *
 * The create/update zod schema is the write boundary; this is the other half: a published
 * revision or an LKG file that was hand-edited (or written by an older/looser build) must not
 * be materialized into a runtime provider with a remapped subject, a foreign issuer, or an
 * empty organisation allowlist.
 */
import {
  DINGTALK_IDENTITY_PROVIDER_ISSUER,
  DINGTALK_IDENTITY_PROVIDER_TEMPLATE,
} from '@lobechat/types';
import { describe, expect, it } from 'vitest';

import { parsePublishedIdentityProviderPayload } from './publishedPayload';

const dingtalkPayload = (overrides: Record<string, unknown> = {}) => ({
  autoProvision: true,
  buttonLabel: DINGTALK_IDENTITY_PROVIDER_TEMPLATE.buttonLabel,
  claimMapping: structuredClone(DINGTALK_IDENTITY_PROVIDER_TEMPLATE.claimMapping),
  clientId: 'app-key',
  dingtalkAllowedCorps: [{ addedAt: '2026-01-01T00:00:00.000Z', corpId: 'ding42' }],
  displayName: 'DingTalk',
  domainAllowlist: [],
  enabled: true,
  groupRoleMapping: {},
  icon: 'dingtalk',
  issuer: DINGTALK_IDENTITY_PROVIDER_ISSUER,
  providerKey: 'dingtalk',
  scopes: [...DINGTALK_IDENTITY_PROVIDER_TEMPLATE.scopes],
  secretFingerprint: 'a'.repeat(64),
  secretUpdatedAt: '2026-01-01T00:00:00.000Z',
  type: 'dingtalk',
  usePkce: true,
  ...overrides,
});

const oidcPayload = (overrides: Record<string, unknown> = {}) => ({
  autoProvision: true,
  buttonLabel: 'Sign in with work',
  claimMapping: {
    dingtalkTitle: [],
    dingtalkUserId: [],
    email: ['email'],
    name: ['name'],
    picture: [],
    subject: ['sub'],
  },
  clientId: 'client-id',
  dingtalkAllowedCorps: [],
  displayName: 'Work',
  domainAllowlist: [],
  enabled: true,
  groupRoleMapping: {},
  icon: null,
  issuer: 'https://login.example.test',
  providerKey: 'work',
  scopes: ['openid', 'profile', 'email'],
  secretFingerprint: 'a'.repeat(64),
  type: 'generic_oidc',
  usePkce: true,
  ...overrides,
});

describe('published DingTalk payload read boundary', () => {
  it('accepts the canonical payload', () => {
    const parsed = parsePublishedIdentityProviderPayload(dingtalkPayload());
    expect(parsed?.type).toBe('dingtalk');
    expect(parsed?.dingtalkAllowedCorps).toEqual([
      { addedAt: '2026-01-01T00:00:00.000Z', corpId: 'ding42' },
    ]);
  });

  it('rejects a remapped subject or altered scopes', () => {
    const remapped = dingtalkPayload();
    (remapped.claimMapping as { subject: string[] }).subject = ['nick'];
    expect(parsePublishedIdentityProviderPayload(remapped)).toBeNull();

    const openIdFallback = dingtalkPayload();
    (openIdFallback.claimMapping as { subject: string[] }).subject = ['unionId', 'openId'];
    expect(parsePublishedIdentityProviderPayload(openIdFallback)).toBeNull();

    expect(
      parsePublishedIdentityProviderPayload(dingtalkPayload({ scopes: ['openid'] })),
    ).toBeNull();
  });

  it('rejects any issuer other than the canonical DingTalk issuer', () => {
    for (const issuer of [
      'https://evil.example',
      `${DINGTALK_IDENTITY_PROVIDER_ISSUER}/ding42`,
      'https://login.dingtalk.com.evil.example',
    ]) {
      expect(parsePublishedIdentityProviderPayload(dingtalkPayload({ issuer })), issuer).toBeNull();
    }
  });

  it('refuses to materialize a DingTalk provider with an empty or malformed allowlist', () => {
    expect(
      parsePublishedIdentityProviderPayload(dingtalkPayload({ dingtalkAllowedCorps: [] })),
    ).toBeNull();
    expect(
      parsePublishedIdentityProviderPayload(
        dingtalkPayload({
          dingtalkAllowedCorps: [{ addedAt: '2026-01-01T00:00:00.000Z', corpId: 'ding/../evil' }],
        }),
      ),
    ).toBeNull();
    expect(
      parsePublishedIdentityProviderPayload(dingtalkPayload({ dingtalkAllowedCorps: 'ding42' })),
    ).toBeNull();
  });

  it('keeps strict OIDC payloads working and refuses organisation grants on them', () => {
    expect(parsePublishedIdentityProviderPayload(oidcPayload())?.type).toBe('generic_oidc');
    expect(
      parsePublishedIdentityProviderPayload(
        oidcPayload({
          dingtalkAllowedCorps: [{ addedAt: '2026-01-01T00:00:00.000Z', corpId: 'ding42' }],
        }),
      ),
    ).toBeNull();
  });
});
