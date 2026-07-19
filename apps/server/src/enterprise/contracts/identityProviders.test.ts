import {
  AUTHENTIK_IDENTITY_PROVIDER_TEMPLATE,
  GENERIC_OIDC_IDENTITY_PROVIDER_TEMPLATE,
} from '@lobechat/types';
import { describe, expect, it } from 'vitest';

import {
  identityProviderClaimMappingSchema,
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
});
