import { GENERIC_OIDC_IDENTITY_PROVIDER_TEMPLATE } from '@lobechat/types';
import { describe, expect, it } from 'vitest';

import { buildIdentityProviderClaimPreview } from './testFlowService';

describe('buildIdentityProviderClaimPreview', () => {
  it('returns only the fixed allowlist and structured required-claim issues', () => {
    const preview = buildIdentityProviderClaimPreview(
      {
        access_token: 'must-not-leak',
        custom: 'must-not-leak',
        email: 'admin@example.test',
        name: '',
        nested: { password: 'must-not-leak' },
        sub: 'subject-1',
      },
      GENERIC_OIDC_IDENTITY_PROVIDER_TEMPLATE.claimMapping,
    );
    expect(preview).toEqual({
      claims: { email: 'admin@example.test', sub: 'subject-1' },
      issues: [{ code: 'required_claim_missing', field: 'name' }],
      valid: false,
    });
    expect(JSON.stringify(preview)).not.toMatch(/access_token|password|custom/);
  });

  it('uses mapped fallback claims for validation without expanding preview fields', () => {
    const preview = buildIdentityProviderClaimPreview(
      { employee_name: 'Ada', employee_subject: '42', private_claim: 'no' },
      {
        ...GENERIC_OIDC_IDENTITY_PROVIDER_TEMPLATE.claimMapping,
        name: ['employee_name'],
        subject: ['employee_subject'],
      },
    );
    expect(preview).toEqual({ claims: {}, issues: [], valid: true });
  });
});
