import {
  AUTHENTIK_IDENTITY_PROVIDER_TEMPLATE,
  GENERIC_OIDC_IDENTITY_PROVIDER_TEMPLATE,
} from '@lobechat/types';
import { describe, expect, it } from 'vitest';

import {
  adminIdentityProviderCreateInputSchema,
  identityProviderClaimMappingSchema,
  identityProviderClaimPreviewSchema,
  identityProviderDraftSchema,
  identityProviderIssuerSchema,
  identityProviderScopesSchema,
} from './identityProviders';

describe('identity provider contracts', () => {
  it('keeps Authentik and Generic OIDC defaults structured and secret-free', () => {
    expect(AUTHENTIK_IDENTITY_PROVIDER_TEMPLATE.scopes).toEqual([
      'openid',
      'profile',
      'email',
      'dingtalk',
    ]);
    expect(AUTHENTIK_IDENTITY_PROVIDER_TEMPLATE.claimMapping).toMatchObject({
      dingtalkTitle: ['dingtalk_title'],
      dingtalkUserId: ['dingtalk_user_id'],
      name: ['name', 'preferred_username'],
    });
    expect(GENERIC_OIDC_IDENTITY_PROVIDER_TEMPLATE.scopes).toEqual(['openid', 'profile', 'email']);
    expect(JSON.stringify(AUTHENTIK_IDENTITY_PROVIDER_TEMPLATE)).not.toMatch(
      /clientSecret|secretRef|ciphertext/,
    );
  });

  it('requires openid and rejects duplicate scopes', () => {
    expect(identityProviderScopesSchema.safeParse(['profile']).success).toBe(false);
    expect(identityProviderScopesSchema.safeParse(['openid', 'openid']).success).toBe(false);
  });

  it.each([
    'http://login.example.test',
    'https://user:pass@login.example.test',
    'https://login.example.test?tenant=internal',
    'https://login.example.test/#fragment',
    ' https://login.example.test',
  ])('rejects non-canonical issuers: %s', (issuer) => {
    expect(identityProviderIssuerSchema.safeParse(issuer).success).toBe(false);
  });

  it('requires subject/name mappings and rejects unstructured fields', () => {
    expect(
      identityProviderClaimMappingSchema.safeParse({
        ...GENERIC_OIDC_IDENTITY_PROVIDER_TEMPLATE.claimMapping,
        unexpected: ['claim'],
      }).success,
    ).toBe(false);
    expect(
      identityProviderClaimMappingSchema.safeParse({
        ...GENERIC_OIDC_IDENTITY_PROVIDER_TEMPLATE.claimMapping,
        subject: [],
      }).success,
    ).toBe(false);
  });

  it.each(['clientSecret', 'apiKey', 'accessToken'])(
    'rejects credential-shaped claim names: %s',
    (claim) => {
      expect(
        identityProviderClaimMappingSchema.safeParse({
          ...GENERIC_OIDC_IDENTITY_PROVIDER_TEMPLATE.claimMapping,
          email: [claim],
        }).success,
      ).toBe(false);
    },
  );

  it('rejects nested credential fields, credential URLs, and disabled PKCE in safe drafts', () => {
    const draft = {
      activationRevision: null,
      autoProvision: true,
      buttonLabel: 'Sign in',
      claimMapping: GENERIC_OIDC_IDENTITY_PROVIDER_TEMPLATE.claimMapping,
      clientId: 'client',
      displayName: 'Work',
      domainAllowlist: [],
      enabled: false,
      groupRoleMapping: {},
      icon: null,
      id: 'provider',
      issuer: 'https://login.example.com',
      migrationRequired: false,
      providerKey: 'work',
      revision: 0,
      scopes: ['openid'],
      secret: { configured: false, fingerprint: null, updatedAt: null },
      status: 'draft',
      type: 'generic_oidc',
      usePkce: true,
    } as const;
    expect(identityProviderDraftSchema.safeParse(draft).success).toBe(true);
    expect(
      identityProviderDraftSchema.safeParse({
        ...draft,
        groupRoleMapping: { admins: { apiKey: 'sk-abcdefgh' } },
      }).success,
    ).toBe(false);
    expect(
      identityProviderDraftSchema.safeParse({
        ...draft,
        icon: 'https://example.com/icon?accessToken=opaque',
      }).success,
    ).toBe(false);
    expect(identityProviderDraftSchema.safeParse({ ...draft, usePkce: false }).success).toBe(false);
  });

  it('accepts explicit create secret operations and rejects secret-shaped public config', () => {
    const input = {
      autoProvision: true,
      buttonLabel: 'Sign in',
      claimMapping: GENERIC_OIDC_IDENTITY_PROVIDER_TEMPLATE.claimMapping,
      clientId: 'client',
      displayName: 'Work',
      domainAllowlist: [],
      groupRoleMapping: {},
      icon: null,
      issuer: 'https://login.example.test',
      providerKey: 'work',
      reason: 'configure work login',
      scopes: ['openid'],
      secret: { operation: 'replace', value: 'not-returned' },
      type: 'generic_oidc',
      usePkce: true,
    } as const;
    expect(adminIdentityProviderCreateInputSchema.safeParse(input).success).toBe(true);
    expect(
      adminIdentityProviderCreateInputSchema.safeParse({
        ...input,
        icon: 'https://example.test/icon?access_token=leak',
      }).success,
    ).toBe(false);
    expect(
      adminIdentityProviderCreateInputSchema.safeParse({
        ...input,
        secret: { operation: 'keep' },
      }).success,
    ).toBe(false);
  });

  it('accepts partial allowlisted previews and rejects token-shaped claims', () => {
    expect(
      identityProviderClaimPreviewSchema.safeParse({
        claims: { sub: 'subject' },
        issues: [],
        valid: true,
      }).success,
    ).toBe(true);
    expect(
      identityProviderClaimPreviewSchema.safeParse({
        claims: { access_token: 'leak' },
        issues: [],
        valid: true,
      }).success,
    ).toBe(false);
  });
});
