import { describe, expect, it } from 'vitest';

import { adminIdentityProviderTestResultOutputSchema } from './identityProviders';

describe('identity provider test result output', () => {
  it('serializes only strict claim presence summaries and rejects raw or unknown claims', () => {
    const output = adminIdentityProviderTestResultOutputSchema.parse({
      attemptId: 'attempt-1',
      errorCode: null,
      result: {
        claims: {
          dingtalk_user_id: { present: true, type: 'string' },
          email: { present: true, type: 'string' },
          name: { present: true, type: 'string' },
          sub: { present: true, type: 'string' },
        },
        issues: [],
        valid: true,
      },
      status: 'succeeded',
    });
    expect(JSON.stringify(output)).not.toMatch(
      /admin@example\.test|Ada Lovelace|subject-1|ding-user-42/,
    );

    expect(() =>
      adminIdentityProviderTestResultOutputSchema.parse({
        ...output,
        result: { ...output.result, claims: { email: 'admin@example.test' } },
      }),
    ).toThrow();
    expect(() =>
      adminIdentityProviderTestResultOutputSchema.parse({
        ...output,
        result: {
          ...output.result,
          claims: { unknown_private_claim: { present: true, type: 'string' } },
        },
      }),
    ).toThrow();
  });
});
